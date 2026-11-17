/**
 * SERVIDOR DE PRODUÇÃO - AÇOUGUE E MERCEARIA COISAS DA ROÇA
 * Macaé/RJ — Gateway W-API + Gemini 3.5 Flash Lite + Fila de Impressão Caixa 1
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { pool, registrarConversa, upsertCliente } = require('./database');
const {
  gerarRespostaAtendimento,
  transcreverAudio,
  extrairRupturasImagemVision,
  validarEnderecoEntrega,
  isConversaPausada,
  pausarIAIntervencaoHumana,
  despausarConversa,
  obterProdutosEmFalta,
  alternarProdutoEmFalta,
  extrairPrimeiroNome
} = require('./services/atendimentoReceptivoService');
const {
  enviarTextoUniversal,
  normalizarPayloadWebhook
} = require('./services/whatsappUniversalAdapter');
const {
  enfileirarImpressaoPedido,
  buscarProximoPedidoFila,
  confirmarImpressaoJob
} = require('./services/impressaoTermicaService');
const { iniciarRotinasAgendadas } = require('./services/cronService');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

const PORT = process.env.PORT || 3001;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

// Debounce adaptativo: 1200ms agrupa rajadas de "Oi" + "Quero carne" sem parecer lento
const DEBOUNCE_JANELA_MS = parseInt(process.env.DEBOUNCE_MS || '1200', 10);

const filaRajadaClientes = new Map();
const clientesEmProcessamento = new Set();
const mensagensProcessadasIds = new Set(); // Deduplicação de webhooks reenviados pelo gateway

function autenticarWorkerInterno(req, res, next) {
  if (!INTERNAL_API_KEY) return next();
  const token = req.headers['x-api-key'] || req.query.key;
  if (token !== INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  next();
}

// ============================================================================
// 1. FILTRO DE FORNECEDORES E PARCEIROS (CORREÇÃO DE SUBSTRING - CASO MONIQUE)
// ============================================================================
function verificarFornecedorOuParceiro(textoMensagem = '', pushName = '') {
  const termosFornecedores = [
    'panko', 'pam', 'mara', 'frigo copa', 'norte lagos', 'seara',
    'd\'carmo', 'hortifruti', 'folhas', 'pluxee', 'ticket', 'stone', 'sieg'
  ];

  // Normaliza apenas espaços extras, mantendo acentuação para boundary seguro
  const textoLimpo = String(textoMensagem).trim();
  const nomeLimpo = String(pushName).trim();

  for (const termo of termosFornecedores) {
    // Escapa caracteres especiais (ex: apóstrofo em d'carmo)
    const termoEscapado = termo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Limite de palavra com suporte a fronteiras Unicode/acentuação
    // Garante que "mara" NÃO dê match em "câmara", nem "pam" em "panorama"
    const regexPalavraExata = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${termoEscapado}(?:$|[^\\p{L}\\p{N}_])`, 'iu');

    if (regexPalavraExata.test(textoLimpo) || regexPalavraExata.test(nomeLimpo)) {
      return {
        bloquear: true,
        motivo: `Fornecedor/Parceiro (${termo})`,
        cooldownMinutos: 60
      };
    }
  }

  // Termos de robôs e chatbots técnicos
  const termosRobo = [
    'statementcallback', 'bad sql grammar', 'chat_bot', 'java.sql',
    'funcao invalida', 'função inválida', 'opcao invalida', 'opção inválida',
    'digite 1 para', 'digite 2 para', 'atendimento automatico', 'atendimento automático',
    'ticket antecipado'
  ];
  for (const termo of termosRobo) {
    if (textoLimpo.toLowerCase().includes(termo)) {
      return {
        bloquear: true,
        motivo: `Chatbot/Sistema (${termo})`,
        cooldownMinutos: 60
      };
    }
  }

  return { bloquear: false };
}

// ============================================================================
// 2. DETECTOR DE PÓS-VENDA E DESPEDIDA (COOLDOWN 30 MIN SEM REABRIR MENU)
// ============================================================================
function verificarDespedidaPosVenda(textoMensagem = '', possuiHistoricoRecente = false) {
  if (!possuiHistoricoRecente) return { isDespedida: false };

  const texto = String(textoMensagem)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos para matching limpo
    .replace(/[,;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Evita disparar se o cliente expressar intenção de pedir algo novo (ex: "obrigado, mas queria pedir mais 1kg")
  const temPedidoNovo = /\b(quero|manda|separa|quanto|tem|troca|mais|entrega|rua|bairro|pix|cartao|kg|kilo|grama|agua|carne)\b/i.test(texto);
  if (temPedidoNovo) return { isDespedida: false };

  // Regex de despedida, agradecimento ou confirmação de recebimento (simples ou composta)
  const regexDespedida = /^(muito\s+)?(obrigad[oa]|valeu|vlw|tmj|perfeito|show|top|blz|beleza|ja\s+chegou|chegou|ja\s+recebi|recebi|tudo\s+certo|tudo\s+certinho|ok\s+obrigad[oa]|bom\s+apetite|tks|thanks|agradeco)/i;

  if (regexDespedida.test(texto)) {
    return {
      isDespedida: true,
      cooldownMinutos: 30
    };
  }

  return { isDespedida: false };
}

/**
 * Busca histórico recente respeitando reset de sessão (últimas 2h ou após último pedido impresso).
 */
async function buscarHistoricoRecente(sessionKey, replyTarget, limite = 8) {
  try {
    const res = await pool.query(
      `SELECT id, mensagem_cliente, resposta_ia, criado_em
       FROM conversas
       WHERE cliente_telefone IN ($1, $2)
         AND resposta_ia NOT LIKE '[SILENCIADO%'
         AND criado_em >= NOW() - INTERVAL '2 hours'
       ORDER BY id DESC
       LIMIT $3`,
      [sessionKey, replyTarget, limite]
    );

    const rows = res.rows.reverse();
    // Corta histórico anterior a um pedido já finalizado para iniciar contexto limpo
    const ultimoFechamentoIdx = rows.map(r => r.resposta_ia || '').reduce(
      (acc, resp, idx) => (resp.includes('[PEDIDO_IMPRESSO_CAIXA1]') ? idx : acc),
      -1
    );
    return ultimoFechamentoIdx >= 0 ? rows.slice(ultimoFechamentoIdx + 1) : rows;
  } catch (e) {
    console.error('Erro ao buscar historico:', e.message);
    return [];
  }
}

async function processarTurnoConsolidado(sessionKey) {
  if (clientesEmProcessamento.has(sessionKey)) return;
  const lote = filaRajadaClientes.get(sessionKey);
  if (!lote || lote.mensagens.length === 0) return;

  filaRajadaClientes.delete(sessionKey);
  clientesEmProcessamento.add(sessionKey);
  const t0 = Date.now();

  try {
    const payloadBase = lote.ultimoPayload;
    const textoConsolidado = lote.mensagens.join('\n').trim();
    payloadBase.text = textoConsolidado;

    // 1. Checa fornecedor pós-áudio / pós-consolidação
    const checkFornecedorPosAudio = verificarFornecedorOuParceiro(textoConsolidado, payloadBase.pushName);
    if (checkFornecedorPosAudio.bloquear) {
      pausarIAIntervencaoHumana(sessionKey, checkFornecedorPosAudio.cooldownMinutos, 'FORNECEDOR');
      registrarConversa({
        clienteTelefone: sessionKey,
        nomeCliente: payloadBase.pushName,
        mensagemCliente: textoConsolidado,
        tipoMensagem: payloadBase.isAudio ? 'audio' : 'texto',
        respostaIA: `[SILENCIADO: ${checkFornecedorPosAudio.motivo}]`,
        tempoMs: 0
      }).catch(() => {});
      return;
    }

    const historicoRecente = await buscarHistoricoRecente(sessionKey, payloadBase.replyTarget, 8);
    const possuiHistoricoRecente = historicoRecente.length > 0;

    // 2. Checa pós-venda / agradecimento
    const checkDespedidaPos = verificarDespedidaPosVenda(textoConsolidado, possuiHistoricoRecente);
    if (checkDespedidaPos.isDespedida) {
      const primeiroNome = extrairPrimeiroNome(payloadBase.pushName);
      const msgDespedida = `Por nada, ${primeiroNome}! Bom apetite e precisando estamos à disposição no balcão! 🥩👍`;
      await enviarTextoUniversal(payloadBase.replyTarget, msgDespedida).catch(() => {});
      pausarIAIntervencaoHumana(sessionKey, checkDespedidaPos.cooldownMinutos, 'POS_VENDA');
      setImmediate(() => {
        registrarConversa({
          clienteTelefone: sessionKey,
          nomeCliente: payloadBase.pushName,
          mensagemCliente: textoConsolidado,
          tipoMensagem: payloadBase.isAudio ? 'audio' : 'texto',
          respostaIA: msgDespedida,
          tempoMs: Date.now() - t0
        }).catch(() => {});
      });
      return;
    }

    const resultadoIA = await gerarRespostaAtendimento({
      replyTarget: payloadBase.replyTarget,
      clienteNome: payloadBase.pushName,
      texto: textoConsolidado,
      base64Audio: payloadBase.base64Audio,
      apiKey: GEMINI_API_KEY,
      historico: historicoRecente
    });

    // Roteamento determinístico com objeto (ex: consulta de status ou humano)
    if (resultadoIA && typeof resultadoIA === 'object' && resultadoIA.texto) {
      if (resultadoIA.cooldownMinutos) {
        pausarIAIntervencaoHumana(sessionKey, resultadoIA.cooldownMinutos, 'ROTEAMENTO_DETERMINISTICO');
      }
      await enviarTextoUniversal(payloadBase.replyTarget, resultadoIA.texto).catch(() => {});
      setImmediate(() => {
        registrarConversa({
          clienteTelefone: sessionKey,
          nomeCliente: payloadBase.pushName,
          mensagemCliente: textoConsolidado,
          tipoMensagem: payloadBase.isAudio ? 'audio' : 'texto',
          respostaIA: resultadoIA.texto,
          tempoMs: Date.now() - t0
        }).catch(() => {});
      });
      return;
    }

    let resposta = String(resultadoIA || '');
    let pedidoImpressoNesteTurno = false;

    if (resposta) {
      if (resposta.includes('[CHAMAR_HUMANO]')) {
        resposta = resposta.replace(/\[CHAMAR_HUMANO\]/g, '').trim();
        pausarIAIntervencaoHumana(sessionKey, 20, 'TRANSBORDO_SOLICITADO');
      }

      const tagInicio = resposta.indexOf('[FINALIZAR_PEDIDO:');
      if (tagInicio !== -1) {
        const tagFim = resposta.lastIndexOf(']');
        if (tagFim > tagInicio) {
          const jsonStr = resposta.substring(tagInicio + '[FINALIZAR_PEDIDO:'.length, tagFim).trim();
          const textoSemTag = (resposta.substring(0, tagInicio) + resposta.substring(tagFim + 1)).trim();

          try {
            const dadosPedido = JSON.parse(jsonStr);
            const checkEndereco = validarEnderecoEntrega(dadosPedido.entrega);

            if (!checkEndereco.valido) {
              const primeiroNome = extrairPrimeiroNome(payloadBase.pushName);
              resposta = `Para enviar seu pedido para separação e entrega${primeiroNome !== 'Cliente' ? ', ' + primeiroNome : ''}, informe por favor o endereço completo aqui em Macaé (*Rua, Número e Bairro*):`;
            } else {
              resposta = textoSemTag;
              const pedidoParaImprimir = {
                pedidoId: `PED-${Date.now().toString().slice(-6)}`,
                clienteTelefone: sessionKey,
                clienteNome: payloadBase.pushName || 'Cliente WhatsApp',
                tipoEntrega: checkEndereco.tipo === 'RETIRADA_BALCAO' ? 'RETIRADA BALCAO' : 'ENTREGA MACAE',
                enderecoEntrega: dadosPedido.entrega || 'Retirada no Balcao',
                formaPagamento: dadosPedido.pagamento || 'A combinar',
                itens: Array.isArray(dadosPedido.itens) && dadosPedido.itens.length > 0
                  ? dadosPedido.itens.map(i => ({
                      descricao: i.descricao || i.nome || 'Corte selecionado',
                      quantidade: i.quantidade || i.qtd || '1 un',
                      preparo: i.preparo || i.corte || 'Padrao balcao'
                    }))
                  : [{ descricao: 'Itens conforme conversa', quantidade: '1 un', preparo: 'Conferir' }]
              };

              await enfileirarImpressaoPedido(pedidoParaImprimir);
              pedidoImpressoNesteTurno = true;
              pausarIAIntervencaoHumana(sessionKey, 15, 'PEDIDO_FINALIZADO');
            }
          } catch (errPedido) {
            console.error('  [Fila Impressão] JSON inválido emitido pelo modelo:', errPedido.message);
            resposta = textoSemTag;
          }
        }
      }

      // Regra dos 3 Passos (transbordo se >= 6 turnos sem fechar)
      const mensagensClienteNoHistorico = historicoRecente.filter(h => h.mensagem_cliente).length;
      if (!pedidoImpressoNesteTurno && mensagensClienteNoHistorico >= 6 && !isConversaPausada(sessionKey)) {
        pausarIAIntervencaoHumana(sessionKey, 45, 'REGRA_3_PASSOS');
        const msgTransf = 'Para finalizar seu atendimento com rapidez, já acionei nossa equipe aqui no balcão e te respondemos em instantes! ✅';
        await enviarTextoUniversal(payloadBase.replyTarget, msgTransf).catch(() => {});
        setImmediate(() => {
          registrarConversa({
            clienteTelefone: sessionKey,
            nomeCliente: payloadBase.pushName,
            mensagemCliente: textoConsolidado,
            tipoMensagem: payloadBase.isAudio ? 'audio' : 'texto',
            respostaIA: `[TRANSFERIDO_HUMANO_REGRA_3_PASSOS] ${msgTransf}`,
            tempoMs: Date.now() - t0
          }).catch(() => {});
        });
        return;
      }

      // Envia resposta no WhatsApp primeiro
      if (!resposta.startsWith('[IMAGEM_ENVIADA]')) {
        await enviarTextoUniversal(payloadBase.replyTarget, resposta).catch(e => console.error('Erro envio gateway:', e.message));
      }

      // Persistência assíncrona (fire-and-forget) sem bloquear ciclo de resposta
      const respostaFinalLog = pedidoImpressoNesteTurno ? `[PEDIDO_IMPRESSO_CAIXA1] ${resposta}` : resposta;
      setImmediate(() => {
        upsertCliente({ telefone: sessionKey, nome: payloadBase.pushName }).catch(() => {});
        registrarConversa({
          clienteTelefone: sessionKey,
          nomeCliente: payloadBase.pushName,
          mensagemCliente: textoConsolidado,
          tipoMensagem: payloadBase.isAudio ? 'audio' : 'texto',
          respostaIA: respostaFinalLog,
          tempoMs: Date.now() - t0
        }).catch(() => {});
      });
    }
  } catch (err) {
    console.error(`  Erro no turno consolidado (${sessionKey}):`, err.message);
  } finally {
    clientesEmProcessamento.delete(sessionKey);
    if (filaRajadaClientes.has(sessionKey)) {
      setTimeout(() => processarTurnoConsolidado(sessionKey), 250);
    }
  }
}

// 1. Webhook Principal do WhatsApp
app.post('/webhook/whatsapp', async (req, res) => {
  // Responde 200 imediatamente para evitar retries duplicados da W-API
  res.status(200).json({ received: true });

  try {
    const payload = await normalizarPayloadWebhook(req.body);
    if (!payload) return;

    // Idempotência por messageId
    if (payload.messageId) {
      if (mensagensProcessadasIds.has(payload.messageId)) return;
      mensagensProcessadasIds.add(payload.messageId);
      if (mensagensProcessadasIds.size > 2000) {
        const firstKey = mensagensProcessadasIds.values().next().value;
        mensagensProcessadasIds.delete(firstKey);
      }
    }

    const { sessionKey, replyTarget } = payload;

    // Intervenção Humana detectada (operador respondeu pelo celular/WhatsApp Web)
    if (payload.fromMe) {
      pausarIAIntervencaoHumana(sessionKey, 20, 'ATENDENTE_HUMANO_RESPONDEU');
      return;
    }

    const textoLimpoComando = (payload.text || '').toLowerCase().trim();

    // Comandos operacionais (#falta, #tem, #estoque)
    if (textoLimpoComando.startsWith('#')) {
      if (payload.isImage && payload.base64Image && /^#(falta|esgotado)/.test(textoLimpoComando)) {
        const itens = await extrairRupturasImagemVision(payload.base64Image, GEMINI_API_KEY);
        const msg = itens.length > 0
          ? `✅ *Bloquinho lido:*\n${itens.map(i => `• ${i}`).join('\n')}\nTotal em falta: ${obterProdutosEmFalta().length}`
          : 'Não consegui ler os itens na foto. Envie: *#falta [nome do corte]*';
        await enviarTextoUniversal(replyTarget, msg).catch(() => {});
        return;
      }
      if (/^#(falta|esgotado)\s+/.test(textoLimpoComando)) {
        const itens = payload.text.replace(/^#(falta|esgotado)\s+/i, '').split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
        itens.forEach(i => alternarProdutoEmFalta(i, 'ESGOTADO'));
        await enviarTextoUniversal(replyTarget, `🚫 *Esgotado no balcão:*\n${itens.map(i => `• ${i}`).join('\n')}`).catch(() => {});
        return;
      }
      if (/^#(tem|chegou)\s+/.test(textoLimpoComando)) {
        const itens = payload.text.replace(/^#(tem|chegou)\s+/i, '').split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
        itens.forEach(i => alternarProdutoEmFalta(i, 'DISPONIVEL'));
        await enviarTextoUniversal(replyTarget, `✅ *Liberado no balcão:*\n${itens.map(i => `• ${i}`).join('\n')}`).catch(() => {});
        return;
      }
      if (/^#(falta|esgotados|estoque)$/.test(textoLimpoComando)) {
        const lista = obterProdutosEmFalta();
        const msg = lista.length > 0
          ? `📋 *ESGOTADOS HOJE:*\n${lista.map(i => `• ${i}`).join('\n')}`
          : '✅ *Nenhum item em falta hoje!*';
        await enviarTextoUniversal(replyTarget, msg).catch(() => {});
        return;
      }
      if (/^#(reset|iniciar|limpar)$/.test(textoLimpoComando)) {
        despausarConversa(sessionKey);
        await enviarTextoUniversal(replyTarget, '🔄 Sessão reiniciada! Pode mandar seu pedido.').catch(() => {});
        return;
      }
    }

    // 1. Filtro Imediato de Fornecedores e Robôs (CORREÇÃO DE SUBSTRING - CASO MONIQUE)
    const checkFornecedorPre = verificarFornecedorOuParceiro(payload.text, payload.pushName);
    if (checkFornecedorPre.bloquear) {
      console.log(`🤖 [SILENCIADO: FORNECEDOR/ROBÔ] "${payload.pushName || sessionKey}" - ${checkFornecedorPre.motivo}`);
      pausarIAIntervencaoHumana(sessionKey, checkFornecedorPre.cooldownMinutos, 'FORNECEDOR_PRE');
      return;
    }

    // 2. Cooldown ativo (pós-venda ou atendimento humano em curso)
    if (isConversaPausada(sessionKey)) {
      return;
    }

    // 3. Checagem prévia de Pós-Venda / Agradecimento (evita abrir turno desnecessário)
    if (payload.text && !payload.isAudio) {
      const historicoPreCheck = await buscarHistoricoRecente(sessionKey, replyTarget, 4);
      const checkDespedidaPre = verificarDespedidaPosVenda(payload.text, historicoPreCheck.length > 0);
      if (checkDespedidaPre.isDespedida) {
        const primeiroNome = extrairPrimeiroNome(payload.pushName);
        const msgDespedida = `Por nada, ${primeiroNome}! Bom apetite e precisando estamos à disposição no balcão! 🥩👍`;
        await enviarTextoUniversal(replyTarget, msgDespedida).catch(() => {});
        pausarIAIntervencaoHumana(sessionKey, checkDespedidaPre.cooldownMinutos, 'POS_VENDA');
        console.log(`✅ [PÓS-VENDA] Despedida cordial enviada para ${primeiroNome}. Cooldown de 30min ativado.`);
        setImmediate(() => {
          registrarConversa({
            clienteTelefone: sessionKey,
            nomeCliente: payload.pushName,
            mensagemCliente: payload.text,
            tipoMensagem: 'texto',
            respostaIA: msgDespedida,
            tempoMs: 0
          }).catch(() => {});
        });
        return;
      }
    }

    // Transcrição de áudio PTT (já descriptografado pelo adaptador)
    if (payload.isAudio && payload.base64Audio) {
      const textoTranscrito = await transcreverAudio(payload.base64Audio, GEMINI_API_KEY);
      payload.text = textoTranscrito ? `[Áudio]: ${textoTranscrito}` : '[Áudio inaudível]';
    }

    if (!payload.text || !payload.text.trim()) return;

    // Debounce de rajada: se já há turno em processamento, não cria timer paralelo
    let registroFila = filaRajadaClientes.get(sessionKey);
    if (!registroFila) {
      registroFila = { mensagens: [], timer: null, ultimoPayload: payload };
      filaRajadaClientes.set(sessionKey, registroFila);
    }
    registroFila.mensagens.push(payload.text.trim());
    registroFila.ultimoPayload = payload;

    if (registroFila.timer) clearTimeout(registroFila.timer);
    if (!clientesEmProcessamento.has(sessionKey)) {
      registroFila.timer = setTimeout(() => {
        processarTurnoConsolidado(sessionKey);
      }, DEBOUNCE_JANELA_MS);
    }
  } catch (err) {
    console.error('  Erro assíncrono no webhook whatsapp:', err.message);
  }
});

// Endpoints de Impressão Protegidos por INTERNAL_API_KEY
app.get('/api/impressao/proximo', autenticarWorkerInterno, async (req, res) => {
  try {
    const job = await buscarProximoPedidoFila();
    res.json({ job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/impressao/status', autenticarWorkerInterno, async (req, res) => {
  const { id, status, erro, adiadoPorPdv } = req.body || {};
  try {
    if (status === 'IMPRESSO') {
      await confirmarImpressaoJob(id);
    } else if (status === 'PENDENTE') {
      // Se foi adiado por ocupação do PDV (Tríplice Trava), NÃO incrementa tentativas!
      if (adiadoPorPdv || (erro && String(erro).startsWith('BUSY:'))) {
        await pool.query(
          "UPDATE public.fila_impressao SET status = 'PENDENTE', atualizado_em = NOW(), erro_mensagem = $2 WHERE id = $1;",
          [id, erro || 'Adiado por ocupação do PDV']
        );
      } else {
        await pool.query(
          "UPDATE public.fila_impressao SET status = 'PENDENTE', atualizado_em = NOW(), erro_mensagem = $2, tentativas = COALESCE(tentativas, 0) + 1 WHERE id = $1;",
          [id, erro || 'Falha de impressão']
        );
      }
    } else if (status === 'ERRO') {
      await pool.query(
        "UPDATE public.fila_impressao SET status = 'ERRO', atualizado_em = NOW(), erro_mensagem = $2 WHERE id = $1;",
        [id, erro || 'Erro fatal']
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Despausa manual de cliente
app.post('/api/conversa/despausar', autenticarWorkerInterno, (req, res) => {
  const { telefone } = req.body || {};
  if (telefone) {
    despausarConversa(telefone);
    return res.json({ ok: true, mensagem: `Conversa ${telefone} despausada.` });
  }
  return res.status(400).json({ error: 'telefone obrigatorio' });
});

// Health check para monitoramento
app.get('/health', (req, res) => {
  res.json({ status: 'OK', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Inicia servidor e rotinas agendadas (CRON e Sentinela SGM)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Açougue e Mercearia Coisas da Roça Core ativo na porta ${PORT}`);
  try {
    iniciarRotinasAgendadas();
  } catch (errCron) {
    console.warn('Aviso ao iniciar rotinas agendadas:', errCron.message);
  }
});

module.exports = app;
