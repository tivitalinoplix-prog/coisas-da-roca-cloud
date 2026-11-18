require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const { processarMensagemReceptiva } = require('./services/atendimentoReceptivoService');

// Carregamento seguro dos serviços auxiliares existentes no repositório
let db = null;
try {
  db = require('./database');
} catch (e) {
  console.warn('[app] database.js não carregado diretamente:', e.message);
}

let supabaseService = null;
try {
  supabaseService = require('./services/supabaseService');
} catch (e) {
  console.warn('[app] supabaseService.js indisponível:', e.message);
}

let whatsappAdapter = null;
try {
  whatsappAdapter = require('./services/whatsappUniversalAdapter');
} catch (e) {
  console.warn('[app] whatsappUniversalAdapter.js indisponível:', e.message);
}

let geminiService = null;
try {
  geminiService = require('./services/geminiService');
} catch (e) {
  console.warn('[app] geminiService.js indisponível:', e.message);
}

let impressaoTermicaService = null;
try {
  impressaoTermicaService = require('./services/impressaoTermicaService');
} catch (e) {
  console.warn('[app] impressaoTermicaService.js indisponível:', e.message);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

const PORT = process.env.PORT || 3001;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'coisasdaroca_internal_caixa1_secret_2026';

// Middleware de autenticação interna para os endpoints de impressão e caixa
function autenticarWorkerInterno(req, res, next) {
  if (!INTERNAL_API_KEY) return next();
  const token = req.headers['x-api-key'] || req.query.key;
  if (token !== INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  next();
}

// Estruturas em memória para alta concorrência, resolução @lid, debounce e pausa humana
const mapaLidParaTelefone = new Map();
const historicoSessoes = new Map(); // chaveCanonica -> Array<{ role, content, timestamp }>
const pausasAtendimentoHumano = new Map(); // chaveCanonica -> timestampExpiraMs
const mensagensEnviadasPeloBot = new Set(); // hashes recentes para distinguir bot vs humano
const buffersDebounce = new Map(); // chaveCanonica -> { mensagens: [], timer, meta }

const TEMPO_DEBOUNCE_MS = Number(process.env.DEBOUNCE_MS || 3500);
const TEMPO_PAUSA_HUMANA_MS = Number(process.env.PAUSA_HUMANA_MINUTOS || 30) * 60 * 1000;
const TTL_SESSAO_MS = 4 * 60 * 60 * 1000; // 4 horas

/**
 * Normaliza qualquer JID, @lid ou número bruto para uma chave canônica consistente.
 */
function resolverIdentificadorCanonico(payload = {}) {
  const brutoChat = String(
    payload.chatId || payload.remoteJid || payload.from || payload.phone || payload.telefone || ''
  ).trim();

  const brutoSender = String(
    payload.sender || payload.participant || payload.senderPhone || ''
  ).trim();

  const limpoChat = brutoChat.replace(/@s\.whatsapp\.net|@c\.us|@lid/gi, '').replace(/\D/g, '');
  const limpoSender = brutoSender.replace(/@s\.whatsapp\.net|@c\.us|@lid/gi, '').replace(/\D/g, '');

  const isLidChat = /@lid/i.test(brutoChat);
  const isLidSender = /@lid/i.test(brutoSender);

  // Se vier um @lid acompanhado de um telefone real (10 a 13 dígitos), registra o vínculo
  if (isLidChat && limpoChat && limpoSender && limpoSender.length >= 10 && limpoSender.length <= 13) {
    mapaLidParaTelefone.set(limpoChat, limpoSender);
  }
  if (isLidSender && limpoSender && limpoChat && limpoChat.length >= 10 && limpoChat.length <= 13) {
    mapaLidParaTelefone.set(limpoSender, limpoChat);
  }

  // Resolve se já conhecemos o telefone por trás deste @lid
  if (isLidChat && mapaLidParaTelefone.has(limpoChat)) {
    const telMapeado = mapaLidParaTelefone.get(limpoChat);
    return {
      chaveCanonica: telMapeado,
      destinoEnvio: brutoChat, // responde no mesmo JID de origem para entrega garantida na W-API
      telefoneReal: telMapeado,
    };
  }

  const escolhido =
    limpoSender.length >= 10 && limpoSender.length <= 13
      ? limpoSender
      : limpoChat || limpoSender;

  return {
    chaveCanonica: escolhido,
    destinoEnvio: brutoChat || (escolhido ? `${escolhido}@s.whatsapp.net` : ''),
    telefoneReal: escolhido.length >= 10 && escolhido.length <= 13 ? escolhido : null,
  };
}

/**
 * Registra assinatura curta de mensagem enviada pelo bot para não confundir com humano.
 */
function registrarEnvioBot(chaveCanonica, texto) {
  const assinatura = `${chaveCanonica}:${String(texto).slice(0, 60).trim()}`;
  mensagensEnviadasPeloBot.add(assinatura);
  setTimeout(() => mensagensEnviadasPeloBot.delete(assinatura), 60 * 1000);
}

function foiEnviadoPeloBot(chaveCanonica, texto) {
  const assinatura = `${chaveCanonica}:${String(texto).slice(0, 60).trim()}`;
  return mensagensEnviadasPeloBot.has(assinatura);
}

/**
 * Filtra mensagens de grupos, status, chamadas ou conversas em pausa humana ativa.
 */
function deveIgnorarEvento(body = {}, texto = '', chaveCanonica = '') {
  const chatId = String(body.chatId || body.remoteJid || body.from || '');

  // Ignora grupos e transmissões de status
  if (chatId.includes('@g.us') || chatId.includes('status@broadcast')) {
    return true;
  }

  // Ignora notificações de sistema sem conteúdo
  if (!texto && !body.audioUrl && !body.mediaUrl && !body.isAudio) {
    return true;
  }

  // Ignora se a conversa estiver em pausa humana ativa
  const emPausa = (pausasAtendimentoHumano.get(chaveCanonica) || 0) > Date.now();
  if (emPausa) {
    return true;
  }

  return false;
}

/**
 * Envia mensagem de volta ao WhatsApp usando o adaptador universal ou fallback W-API.
 */
async function enviarMensagemWhatsApp(destino, texto) {
  if (!destino || !texto) return;

  if (whatsappAdapter && typeof whatsappAdapter.enviarTextoUniversal === 'function') {
    return whatsappAdapter.enviarTextoUniversal(destino, texto);
  }
  if (whatsappAdapter && typeof whatsappAdapter.enviarTexto === 'function') {
    return whatsappAdapter.enviarTexto(destino, texto);
  }
  if (whatsappAdapter && typeof whatsappAdapter.sendMessage === 'function') {
    return whatsappAdapter.sendMessage(destino, texto);
  }

  // Fallback direto HTTP para W-API caso o adapter não responda
  const baseUrl = process.env.WAPI_BASE_URL || 'https://api.w-api.app/v1';
  const instanceId = process.env.WAPI_INSTANCE_ID;
  const token = process.env.WAPI_TOKEN;

  if (baseUrl && instanceId && token) {
    const phoneLimpo = String(destino).replace(/@s\.whatsapp\.net|@c\.us/gi, '');
    await fetch(`${baseUrl.replace(/\/$/, '')}/message/send-text?instanceId=${instanceId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        phone: phoneLimpo,
        message: texto,
        delayMessage: 0,
      }),
    });
  } else {
    console.warn('[app] Nenhum método de envio WhatsApp configurado para responder:', destino);
  }
}

/**
 * Busca perfil salvo do cliente no Supabase (se disponível).
 */
async function carregarPerfilCliente(telefoneReal) {
  if (!telefoneReal || !supabaseService) return null;
  try {
    if (typeof supabaseService.buscarClientePorTelefone === 'function') {
      return await supabaseService.buscarClientePorTelefone(telefoneReal);
    }
    if (typeof supabaseService.obterCliente === 'function') {
      return await supabaseService.obterCliente(telefoneReal);
    }
  } catch (err) {
    console.warn('[app] Falha não-bloqueante ao consultar Supabase:', err.message);
  }
  return null;
}

/**
 * Atualiza CRM no Supabase e despacha comanda para impressão térmica ao fechar pedido.
 */
async function finalizarPedidoEDespachar({ chaveCanonica, telefoneReal, nomeCliente, dadosPedido }) {
  if (!dadosPedido) return;

  // 1. Atualiza cadastro do cliente no Supabase (endereço e pagamento preferido)
  if (telefoneReal && supabaseService) {
    try {
      const payloadCliente = {
        telefone: telefoneReal,
        nome: dadosPedido.cliente_nome || nomeCliente || '',
        endereco: dadosPedido.endereco || '',
        forma_pagamento: dadosPedido.forma_pagamento || '',
        ultimo_pedido_em: new Date().toISOString(),
      };

      if (typeof supabaseService.salvarOuAtualizarCliente === 'function') {
        await supabaseService.salvarOuAtualizarCliente(payloadCliente);
      } else if (typeof supabaseService.upsertCliente === 'function') {
        await supabaseService.upsertCliente(payloadCliente);
      }
    } catch (err) {
      console.warn('[app] Erro ao persistir cliente no Supabase:', err.message);
    }
  }

  // 2. Enfileira comanda para impressão térmica local (Bematech/Elgin)
  try {
    if (impressaoTermicaService && typeof impressaoTermicaService.enfileirarImpressaoPedido === 'function') {
      await impressaoTermicaService.enfileirarImpressaoPedido({
        id: dadosPedido.codigo_pedido ? `PED-${dadosPedido.codigo_pedido}` : `PED-${Date.now().toString().slice(-6)}`,
        cliente: dadosPedido.cliente_nome || nomeCliente || 'Cliente',
        contato: telefoneReal || chaveCanonica,
        endereco: dadosPedido.endereco || 'Retirada no Balcão',
        pagamento: dadosPedido.forma_pagamento || 'A Combinar',
        itens: (dadosPedido.itens || []).map((it) => ({
          descricao: it.nome,
          quantidade: it.quantidade,
          unidade: it.unidade || 'KG',
          preparo: it.observacao_corte || 'Padrão da casa',
        })),
        valorTotalEstimado: dadosPedido.total_estimado,
      });
    } else if (impressaoTermicaService && typeof impressaoTermicaService.enfileirarImpressao === 'function') {
      await impressaoTermicaService.enfileirarImpressao(dadosPedido);
    }
  } catch (err) {
    console.error('[app] Erro ao enfileirar impressão térmica:', err.message);
  }

  // 3. Limpa o histórico da sessão concluída para o próximo pedido começar limpo
  historicoSessoes.delete(chaveCanonica);
}

/**
 * Processa o lote consolidado de mensagens de um cliente após o tempo de debounce.
 */
async function executarTurnoConsolidado(chaveCanonica) {
  const pacote = buffersDebounce.get(chaveCanonica);
  buffersDebounce.delete(chaveCanonica);

  if (!pacote || !pacote.mensagens.length) return;

  const textoConsolidado = pacote.mensagens.join('\n');
  const { destinoEnvio, telefoneReal, nomeCliente } = pacote.meta;

  // Recupera ou inicializa o histórico da conversa respeitando TTL
  const agora = Date.now();
  let sessao = historicoSessoes.get(chaveCanonica) || [];
  sessao = sessao.filter((m) => agora - (m.timestamp || agora) < TTL_SESSAO_MS);

  // Hidrata dados do CRM (Supabase) se existir
  const perfilCliente = await carregarPerfilCliente(telefoneReal);

  // Executa a orquestração inteligente com Gemini + Catálogo SGM
  const resultado = await processarMensagemReceptiva(textoConsolidado, sessao, {
    nomeCliente: nomeCliente || perfilCliente?.nome || '',
    perfilCliente,
  });

  // Atualiza histórico da sessão
  sessao.push({ role: 'user', content: textoConsolidado, timestamp: Date.now() });
  if (resultado.resposta) {
    sessao.push({ role: 'model', content: resultado.resposta, timestamp: Date.now() });
  }
  historicoSessoes.set(chaveCanonica, sessao.slice(-20));

  // Envia resposta ao cliente
  if (resultado.resposta) {
    registrarEnvioBot(chaveCanonica, resultado.resposta);
    await enviarMensagemWhatsApp(destinoEnvio, resultado.resposta);
  }

  // Se houve transbordo para atendente humana, pausa o robô por 30 min nesta conversa
  if (resultado.transbordoHumano) {
    pausasAtendimentoHumano.set(chaveCanonica, Date.now() + TEMPO_PAUSA_HUMANA_MS);
    console.log(`[app] Transbordo humano acionado para ${chaveCanonica}. Bot pausado por 30 min.`);
  }

  // Se o pedido foi fechado, salva no CRM, imprime comanda e encerra ciclo ativo
  if (resultado.pedidoFechado) {
    await finalizarPedidoEDespachar({
      chaveCanonica,
      telefoneReal,
      nomeCliente,
      dadosPedido: resultado.dadosPedido,
    });
  }
}

/**
 * Extrai texto (ou transcreve áudio) de payloads heterogêneos da W-API / WhatsApp.
 */
async function extrairConteudoMensagem(body = {}) {
  const msgObj = body.msgContent || body.message || body.data?.message || body;

  const textoDireto =
    body.text ||
    body.body ||
    msgObj?.conversation ||
    msgObj?.extendedTextMessage?.text ||
    msgObj?.text?.message ||
    '';

  if (textoDireto) {
    return String(textoDireto).trim();
  }

  // Suporte a áudio: W-API / Evolution / Baileys
  const audioUrl =
    body.audioUrl ||
    msgObj?.audioMessage?.url ||
    body.mediaUrl ||
    null;

  if (audioUrl && geminiService && typeof geminiService.transcreverAudio === 'function') {
    try {
      const transcricao = await geminiService.transcreverAudio(audioUrl);
      if (transcricao) {
        return `[Áudio do cliente]: ${transcricao}`;
      }
    } catch (err) {
      console.error('[app] Falha ao transcrever áudio:', err.message);
    }
  }

  return '';
}

/**
 * Rota principal de Webhook do WhatsApp (W-API / Universal).
 */
app.post(['/webhook', '/webhook/whatsapp', '/api/webhook'], async (req, res) => {
  // Responde HTTP 200 imediatamente para evitar reenvios duplicados do gateway W-API
  res.status(200).json({ ok: true });

  try {
    const body = req.body || {};
    const { chaveCanonica, destinoEnvio, telefoneReal } = resolverIdentificadorCanonico(body);

    if (!chaveCanonica) return;

    const fromMe = Boolean(body.fromMe || body.key?.fromMe || body.data?.key?.fromMe);
    const texto = await extrairConteudoMensagem(body);

    // Detecção de intervenção humana: mensagem enviada pelo aparelho/WhatsApp Web da loja
    if (fromMe) {
      if (texto && !foiEnviadoPeloBot(chaveCanonica, texto)) {
        // Permite comando manual para reativar o bot imediatamente: #bot
        if (texto.trim().toLowerCase() === '#bot') {
          pausasAtendimentoHumano.delete(chaveCanonica);
          console.log(`[app] Bot reativado manualmente via #bot para ${chaveCanonica}.`);
          return;
        }

        pausasAtendimentoHumano.set(chaveCanonica, Date.now() + TEMPO_PAUSA_HUMANA_MS);
        console.log(`[app] Intervenção humana detectada para ${chaveCanonica}. Bot pausado por 30 min.`);
      }
      return;
    }

    if (deveIgnorarEvento(body, texto, chaveCanonica)) {
      return;
    }

    const nomeCliente =
      body.senderName ||
      body.pushName ||
      body.data?.pushName ||
      body.contactName ||
      '';

    // Debounce: agrupa mensagens em rajada do mesmo cliente antes de chamar a IA
    const existente = buffersDebounce.get(chaveCanonica);
    if (existente) {
      clearTimeout(existente.timer);
      if (texto) existente.mensagens.push(texto);
      existente.meta.destinoEnvio = destinoEnvio || existente.meta.destinoEnvio;
      if (nomeCliente) existente.meta.nomeCliente = nomeCliente;
    } else {
      buffersDebounce.set(chaveCanonica, {
        mensagens: texto ? [texto] : [],
        meta: { destinoEnvio, telefoneReal, nomeCliente },
        timer: null,
      });
    }

    const entradaAtual = buffersDebounce.get(chaveCanonica);
    entradaAtual.timer = setTimeout(() => {
      executarTurnoConsolidado(chaveCanonica).catch((err) => {
        console.error(`[app] Erro ao processar turno de ${chaveCanonica}:`, err);
      });
    }, TEMPO_DEBOUNCE_MS);
  } catch (err) {
    console.error('[app] Erro inesperado no webhook:', err);
  }
});

// ============================================================================
// ENDPOINTS DE IMPRESSÃO TÉRMICA E PDV (CAIXA 1) PROTEGIDOS POR INTERNAL_API_KEY
// ============================================================================

app.get('/api/impressao/proximo', autenticarWorkerInterno, async (req, res) => {
  try {
    if (impressaoTermicaService && typeof impressaoTermicaService.buscarProximoPedidoFila === 'function') {
      const job = await impressaoTermicaService.buscarProximoPedidoFila();
      return res.json({ job });
    }
    res.json({ job: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/impressao/status', autenticarWorkerInterno, async (req, res) => {
  const { id, status, erro, adiadoPorPdv } = req.body || {};
  try {
    if (impressaoTermicaService) {
      if (status === 'IMPRESSO' && typeof impressaoTermicaService.confirmarImpressaoJob === 'function') {
        await impressaoTermicaService.confirmarImpressaoJob(id);
      } else if (status === 'PENDENTE' && db && db.pool) {
        if (adiadoPorPdv || (erro && String(erro).startsWith('BUSY:'))) {
          await db.pool.query(
            "UPDATE public.fila_impressao SET status = 'PENDENTE', atualizado_em = NOW(), erro_mensagem = $2 WHERE id = $1;",
            [id, erro || 'Adiado por ocupação do PDV']
          );
        } else {
          await db.pool.query(
            "UPDATE public.fila_impressao SET status = 'PENDENTE', atualizado_em = NOW(), erro_mensagem = $2, tentativas = COALESCE(tentativas, 0) + 1 WHERE id = $1;",
            [id, erro || 'Falha de impressão']
          );
        }
      } else if (status === 'ERRO' && db && db.pool) {
        await db.pool.query(
          "UPDATE public.fila_impressao SET status = 'ERRO', atualizado_em = NOW(), erro_mensagem = $2 WHERE id = $1;",
          [id, erro || 'Erro fatal']
        );
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/worker-caixa1.ps1', autenticarWorkerInterno, (req, res) => {
  const workerFile = path.resolve(__dirname, '../../scripts/worker_impressao_caixa1.ps1');
  if (fs.existsSync(workerFile)) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.sendFile(workerFile);
  }
  return res.status(404).send('# Arquivo worker_impressao_caixa1.ps1 não encontrado no servidor');
});

app.post('/api/conversa/despausar', autenticarWorkerInterno, (req, res) => {
  const { telefone } = req.body || {};
  if (telefone) {
    pausasAtendimentoHumano.delete(String(telefone).trim());
    return res.json({ ok: true, mensagem: `Conversa ${telefone} despausada com sucesso.` });
  }
  res.status(400).json({ error: 'Telefone obrigatório' });
});

// Rota de saúde para monitoramento (Railway / Docker / Uptime)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'online',
    loja: process.env.NOME_LOJA || 'Açougue e Mercearia Coisas da Roça',
    sessoesAtivas: historicoSessoes.size,
    pausasHumanasAtivas: pausasAtendimentoHumano.size,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`[Coisas da Roça] Servidor de atendimento rodando 24/7 na porta ${PORT}`);
});

module.exports = app;
