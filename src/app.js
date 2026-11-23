require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const { processarMensagemReceptiva } = require('./services/atendimentoReceptivoService');
const redisService = require('./services/redisService');
const visaoComandosService = require('./services/visaoComandosService');
const pesagemPixService = require('./services/pesagemPixService');
const { executarFechamentoExpediente } = require('./services/fechamentoExpedienteService');

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

let produtosService = null;
try {
  produtosService = require('./services/produtosService');
} catch (e) {
  console.warn('[app] produtosService.js indisponível:', e.message);
}

let cronService = null;
try {
  cronService = require('./services/cronService');
  if (cronService && typeof cronService.iniciarRotinasAgendadas === 'function') {
    cronService.iniciarRotinasAgendadas();
  }
} catch (e) {
  console.warn('[app] cronService.js indisponível:', e.message);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

const PORT = process.env.PORT || 3001;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'coisasdaroca_internal_caixa1_secret_2026';

const logoPath = path.join(__dirname, 'assets', 'logo_coisas_da_roca.jpg');
let logoBase64 = null;
if (fs.existsSync(logoPath)) {
  try {
    logoBase64 = `data:image/jpeg;base64,${fs.readFileSync(logoPath).toString('base64')}`;
  } catch (e) {
    console.warn('[app] Falha ao carregar logo_coisas_da_roca.jpg:', e.message);
  }
}

function autenticarWorkerInterno(req, res, next) {
  if (!INTERNAL_API_KEY) return next();
  const token = req.headers['x-api-key'] || req.query.key;
  if (token !== INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  next();
}

const mensagensEnviadasPeloBot = new Set();
const timersDebounceLocais = new Map();

let pausaGlobalMemoria = process.env.AUTOMACOES_PAUSADAS === 'true';

function isAutomacaoPausadaGlobal() {
  return pausaGlobalMemoria || process.env.AUTOMACOES_PAUSADAS === 'true';
}

const TEMPO_DEBOUNCE_MS = Number(process.env.DEBOUNCE_MS || 7000);
const TEMPO_PAUSA_HUMANA_SEG = Number(process.env.PAUSA_HUMANA_MINUTOS || 30) * 60;

function isNumeroTestador(chave = '') {
  if (redisService && typeof redisService.isNumeroTestador === 'function') {
    return redisService.isNumeroTestador(chave);
  }
  const cleanPhone = String(chave || '').replace(/\D/g, '');
  if (!cleanPhone) return false;
  return (
    cleanPhone.includes('998586180') ||
    cleanPhone.includes('173679971422247') ||
    cleanPhone.includes('148863600070757')
  );
}

function isMensagemFornecedorOuRobo(texto = '', pushName = '') {
  const txt = String(texto || '').toLowerCase();
  const nome = String(pushName || '').toLowerCase();

  const termosRobo = [
    'statementcallback', 'bad sql grammar', 'chat_bot', 'java.sql',
    'funcao invalida', 'função inválida', 'opcao invalida', 'opção inválida',
    'atendimento automatico', 'atendimento automático', 'ticket antecipado',
  ];
  for (const t of termosRobo) {
    if (txt.includes(t)) return `Chatbot/Sistema (${t})`;
  }

  // Apenas termos empresariais inequívocos no texto. NUNCA colocar nomes próprios como mara, pam, etc.:
  const termosFornecedores = [
    'panko', 'dan solucoes', 'dan soluções', 'dam solucoes', 'dam soluções',
    'arte fruti', 'artefruti', 'menino do polvilho', 'macae med', 'macaé med',
    'andre grafica', 'andré gráfica', 'ticket antecipado de reembolso',
  ];
  for (const t of termosFornecedores) {
    if (txt.includes(t)) return `Fornecedor (${t})`;
  }

  // NUNCA bloquear cliente por primeiro nome no pushName.
  // Só considera fornecedor no nome se contiver termos corporativos explícitos:
  const termosCorporativos = ['soluções', 'solucoes', 'distribuidora', 'gráfica', 'grafica', 'ltda', 'eireli'];
  for (const c of termosCorporativos) {
    if (nome.includes(c)) return `Fornecedor Corporativo (${c})`;
  }

  return null;
}

async function resolverIdentificadorUnificado(normalizado, body = {}) {
  const sessionKey = normalizado?.sessionKey || '';
  const replyTarget = normalizado?.replyTarget || '';

  const telCandidatoRaw = String(
    normalizado?.senderPhone || body.senderPhone || body.phone || ''
  ).replace(/\D/g, '');
  const telCandidato =
    telCandidatoRaw.length >= 10 && telCandidatoRaw.length <= 13 ? telCandidatoRaw : null;

  const lidCandidatoRaw = String(
    normalizado?.senderLid || (sessionKey.startsWith('lid:') ? sessionKey : '')
  );
  const lidKey = lidCandidatoRaw
    ? lidCandidatoRaw.startsWith('lid:')
      ? lidCandidatoRaw.split('@')[0]
      : `lid:${lidCandidatoRaw.split('@')[0].replace(/\D/g, '')}`
    : null;

  if (lidKey && telCandidato) {
    await redisService.salvarMapeamentoLid(lidKey, telCandidato);
  }

  if (sessionKey.startsWith('lid:')) {
    const telMapeado = await redisService.obterTelefonePorLid(sessionKey);
    if (telMapeado) {
      return {
        chaveCanonica: telMapeado,
        destinoEnvio: replyTarget,
        telefoneReal: telMapeado,
      };
    }
  }

  const chaveCanonica = sessionKey || telCandidato || '';
  const telefoneReal =
    !chaveCanonica.startsWith('lid:') && chaveCanonica.length >= 10 && chaveCanonica.length <= 13
      ? chaveCanonica
      : telCandidato;

  return {
    chaveCanonica,
    destinoEnvio: replyTarget || (telefoneReal ? `${telefoneReal}@s.whatsapp.net` : ''),
    telefoneReal,
  };
}

function registrarEnvioBot(chaveCanonica, texto, messageId = null) {
  if (texto) {
    const assinatura = `${chaveCanonica}:${String(texto).slice(0, 60).trim()}`;
    mensagensEnviadasPeloBot.add(assinatura);
    setTimeout(() => mensagensEnviadasPeloBot.delete(assinatura), 90 * 1000).unref();
  }
  if (messageId) {
    const idKey = `id:${messageId}`;
    mensagensEnviadasPeloBot.add(idKey);
    setTimeout(() => mensagensEnviadasPeloBot.delete(idKey), 90 * 1000).unref();
  }
}

function foiEnviadoPeloBot(chaveCanonica, texto, messageId = null) {
  if (messageId && mensagensEnviadasPeloBot.has(`id:${messageId}`)) return true;
  if (texto) {
    const assinatura = `${chaveCanonica}:${String(texto).slice(0, 60).trim()}`;
    if (mensagensEnviadasPeloBot.has(assinatura)) return true;
  }
  return false;
}

async function enviarMensagemWhatsApp(destino, texto, tipoBotoes = null) {
  if (!destino || !texto) return null;

  if (tipoBotoes && whatsappAdapter && typeof whatsappAdapter.enviarBotoesUniversal === 'function') {
    const botoes =
      tipoBotoes === 'PAGAMENTO'
        ? [
            { id: 'pgto_pix', label: 'Pix' },
            { id: 'pgto_cartao', label: 'Cartão na Entrega' },
            { id: 'pgto_dinheiro', label: 'Dinheiro' },
          ]
        : [
            { id: 'conf_sim', label: 'Confirmar Pedido' },
            { id: 'conf_mais', label: 'Adicionar Mais' },
            { id: 'conf_balcao', label: 'Falar com Balcão' },
          ];
    return whatsappAdapter.enviarBotoesUniversal(destino, texto, botoes);
  }

  if (whatsappAdapter && typeof whatsappAdapter.enviarTextoUniversal === 'function') {
    return whatsappAdapter.enviarTextoUniversal(destino, texto);
  }

  return null;
}

async function transcreverAudioSeguro(base64Audio, telefone) {
  if (!base64Audio || !geminiService || typeof geminiService.processarAudioComGemini !== 'function') {
    return '';
  }

  const chaves = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_FALLBACK,
    process.env.GOOGLE_API_KEY,
  ].filter((k) => Boolean(k && String(k).trim()));

  for (const apiKey of chaves) {
    try {
      const analise = await geminiService.processarAudioComGemini(base64Audio, telefone, apiKey);
      const transcricao = analise?.transcricao_literal || '';
      if (transcricao) {
        const obs = analise?.observacoes ? ` (Obs áudio: ${analise.observacoes})` : '';
        return `[Áudio do cliente]: ${transcricao}${obs}`;
      }
    } catch (err) {
      console.warn('[app] Falha ao transcrever áudio com Gemini:', err.message);
    }
  }

  return '[Áudio do cliente recebido, mas não foi possível transcrever automaticamente]';
}

async function carregarPerfilCliente(telefoneReal) {
  if (!telefoneReal || !supabaseService || typeof supabaseService.supabaseRequest !== 'function') {
    return null;
  }
  try {
    const rows = await supabaseService.supabaseRequest(
      'clientes',
      'GET',
      null,
      `telefone=eq.${encodeURIComponent(telefoneReal)}&select=telefone,nome,bairro,opt_out&limit=1`
    );
    const cliente = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;

    let ultimoPedido = null;
    if (typeof supabaseService.buscarPedidosRecentes === 'function') {
      const pedidos = await supabaseService.buscarPedidosRecentes(telefoneReal, 1);
      if (Array.isArray(pedidos) && pedidos.length > 0) {
        ultimoPedido = pedidos[0];
      }
    }

    if (!cliente && !ultimoPedido) return null;

    return {
      nome: cliente?.nome || '',
      endereco: cliente?.bairro || '',
      forma_pagamento: ultimoPedido?.forma_pagamento || '',
      opt_out: Boolean(cliente?.opt_out),
    };
  } catch (err) {
    console.warn('[app] Falha não-bloqueante ao consultar Supabase:', err.message);
    return null;
  }
}

async function finalizarPedidoEDespachar({
  chaveCanonica,
  destinoEnvio,
  telefoneReal,
  nomeCliente,
  dadosPedido,
  respostaIA,
}) {
  if (!dadosPedido) return false;

  const codigoPedido = dadosPedido.codigo_pedido || Date.now().toString().slice(-4);

  if (telefoneReal && supabaseService) {
    try {
      if (typeof supabaseService.upsertCliente === 'function') {
        await supabaseService.upsertCliente({
          telefone: telefoneReal,
          nome: dadosPedido.cliente_nome || nomeCliente || null,
          bairro: dadosPedido.endereco || null,
        });
      }

      if (db && typeof db.upsertCliente === 'function') {
        await db.upsertCliente({
          telefone: telefoneReal,
          nome: dadosPedido.cliente_nome || nomeCliente || null,
        }).catch(() => {});
      }

      if (typeof supabaseService.registrarPedido === 'function') {
        const itensAcougue = (dadosPedido.itens || []).filter((i) => i.unidade === 'KG');
        const itensMercearia = (dadosPedido.itens || []).filter((i) => i.unidade !== 'KG');
        await supabaseService.registrarPedido({
          clienteTelefone: telefoneReal,
          itensAcougue,
          itensMercearia,
          formaPagamento: dadosPedido.forma_pagamento || 'A combinar',
          respostaIA: respostaIA || '',
        });
      }
    } catch (err) {
      console.warn('[app] Erro ao persistir pedido/cliente no Supabase:', err.message);
    }
  }

  let enfileirou = false;
  try {
    if (impressaoTermicaService && typeof impressaoTermicaService.enfileirarImpressaoPedido === 'function') {
      await impressaoTermicaService.enfileirarImpressaoPedido({
        pedidoId: codigoPedido,
        clienteNome: dadosPedido.cliente_nome || nomeCliente || 'Cliente WhatsApp',
        clienteTelefone: telefoneReal || chaveCanonica,
        enderecoEntrega: dadosPedido.endereco || 'Retirada no Balcao',
        formaPagamento: dadosPedido.forma_pagamento || 'A combinar',
        itens: (dadosPedido.itens || []).map((it) => ({
          descricao: it.nome,
          quantidade: `${it.quantidade} ${it.unidade || 'KG'}`,
          preparo: it.observacao_corte || 'Padrao da casa',
        })),
      });
      enfileirou = true;
    }
  } catch (err) {
    console.error('[app] Erro ao enfileirar impressão térmica:', err.message);
  }

  await redisService.salvarPedidoAguardandoPesagem(codigoPedido, {
    codigoPedido,
    clienteNome: dadosPedido.cliente_nome || nomeCliente || 'Cliente WhatsApp',
    clienteTelefone: destinoEnvio || telefoneReal || chaveCanonica,
    formaPagamento: dadosPedido.forma_pagamento || 'Pix',
    itens: dadosPedido.itens || [],
  });

  if (enfileirou) {
    await redisService.limparSessao(chaveCanonica);
    await redisService.ativarPausa(chaveCanonica, TEMPO_PAUSA_HUMANA_SEG);
  }
  return enfileirou;
}

async function executarTurnoConsolidado(chaveCanonica) {
  timersDebounceLocais.delete(chaveCanonica);

  const obteveLock = await redisService.adquirirLock(chaveCanonica, 30);
  if (!obteveLock) {
    const t = setTimeout(() => executarTurnoConsolidado(chaveCanonica), 1500);
    timersDebounceLocais.set(chaveCanonica, t);
    return;
  }

  try {
    const mensagensLote = await redisService.consumirBufferMensagens(chaveCanonica);
    if (!mensagensLote.length) return;

    if (await redisService.estaEmPausa(chaveCanonica)) {
      return;
    }

    const inicioMs = Date.now();
    const ultimoMeta = mensagensLote[mensagensLote.length - 1];
    const textoConsolidado = mensagensLote.map((m) => m.texto).filter(Boolean).join('\n');
    const { destinoEnvio, telefoneReal, nomeCliente, isAudio } = ultimoMeta;

    if (!textoConsolidado) return;

    if (whatsappAdapter?.enviarPresencaUniversal) {
      whatsappAdapter.enviarPresencaUniversal(destinoEnvio, 'composing').catch(() => {});
    }

    const sessaoAtiva = await redisService.obterSessao(chaveCanonica);
    if (nomeCliente && !sessaoAtiva.clienteNome) {
      sessaoAtiva.clienteNome = nomeCliente;
    }

    const perfilCliente = await carregarPerfilCliente(telefoneReal);
    const faltasBalcao = await redisService.listarFaltas();

    const resultado = await processarMensagemReceptiva(textoConsolidado, sessaoAtiva, {
      nomeCliente: nomeCliente || sessaoAtiva.clienteNome || perfilCliente?.nome || '',
      perfilCliente,
      faltasBalcao,
    });

    if (await redisService.estaEmPausa(chaveCanonica)) {
      return;
    }

    const sessaoParaSalvar = resultado.sessaoAtualizada || sessaoAtiva;
    const historicoBase = Array.isArray(sessaoParaSalvar.historico) && sessaoParaSalvar.historico.length > 0
      ? sessaoParaSalvar.historico
      : (Array.isArray(sessaoAtiva.historico) ? sessaoAtiva.historico : []);
    const historicoAtual = [...historicoBase];
    historicoAtual.push({ role: 'user', content: textoConsolidado, timestamp: Date.now() });
    if (resultado.resposta) {
      historicoAtual.push({ role: 'model', content: resultado.resposta, timestamp: Date.now() });
    }
    sessaoParaSalvar.historico = historicoAtual.slice(-16);
    await redisService.salvarSessao(chaveCanonica, sessaoParaSalvar);

    if (resultado.enviarLogo && logoBase64 && whatsappAdapter?.enviarImagemUniversal) {
      registrarEnvioBot(chaveCanonica, resultado.resposta);
      const envioImg = await whatsappAdapter.enviarImagemUniversal(destinoEnvio, logoBase64, resultado.resposta);
      const sentImgId = envioImg?.messageId || envioImg?.key?.id || envioImg?.id || envioImg?.data?.messageId || null;
      if (sentImgId) {
        registrarEnvioBot(chaveCanonica, null, sentImgId);
      }
    } else if (resultado.resposta) {
      registrarEnvioBot(chaveCanonica, resultado.resposta);
      const envioRes = await enviarMensagemWhatsApp(destinoEnvio, resultado.resposta, resultado.tipoBotoes);
      const sentMsgId = envioRes?.messageId || envioRes?.key?.id || envioRes?.id || envioRes?.data?.messageId || null;
      if (sentMsgId) {
        registrarEnvioBot(chaveCanonica, null, sentMsgId);
      }
    }

    if (resultado.enviarLocalizacao && whatsappAdapter?.enviarLocalizacaoUniversal) {
      await whatsappAdapter.enviarLocalizacaoUniversal(destinoEnvio).catch(() => {});
    }

    const payloadRegistro = {
      clienteTelefone: telefoneReal || chaveCanonica,
      nomeCliente: nomeCliente || sessaoAtiva.clienteNome || perfilCliente?.nome || null,
      mensagemCliente: textoConsolidado,
      tipoMensagem: isAudio ? 'audio' : 'texto',
      respostaIA: resultado.resposta || '',
      tempoRespostaMs: Date.now() - inicioMs,
    };

    if (supabaseService && typeof supabaseService.registrarConversa === 'function') {
      supabaseService.registrarConversa(payloadRegistro).catch(() => {});
    }
    if (db && typeof db.registrarConversa === 'function') {
      db.registrarConversa(payloadRegistro).catch(() => {});
    }

    if (resultado.transbordoHumano || resultado.pausaSegundos) {
      await redisService.ativarPausa(chaveCanonica, resultado.pausaSegundos || TEMPO_PAUSA_HUMANA_SEG);
    }

    if (resultado.pedidoFechado) {
      await finalizarPedidoEDespachar({
        chaveCanonica,
        destinoEnvio,
        telefoneReal,
        nomeCliente: nomeCliente || sessaoAtiva.clienteNome,
        dadosPedido: resultado.dadosPedido,
        respostaIA: resultado.resposta,
      });
    }
  } finally {
    await redisService.liberarLock(chaveCanonica);
  }
}

async function tratarComandoOperacional(texto, destinoEnvio) {
  const lower = texto.toLowerCase().trim();

  if (lower.startsWith('#falta ') || lower.startsWith('#esgotado ')) {
    const itens = texto.replace(/^#(falta|esgotado)\s+/i, '').split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
    for (const item of itens) await redisService.adicionarFalta(item);
    await enviarMensagemWhatsApp(destinoEnvio, `🚨 *Esgotado no balcão:*\n${itens.map((i) => `• ${i}`).join('\n')}`);
    return true;
  }

  if (lower.startsWith('#tem ') || lower.startsWith('#chegou ') || lower.startsWith('#disponivel ') || lower.startsWith('#disponível ')) {
    const itens = texto.replace(/^#(tem|chegou|dispon[ií]vel)\s+/i, '').split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
    for (const item of itens) await redisService.removerFalta(item);
    await enviarMensagemWhatsApp(destinoEnvio, `✅ *Liberado no balcão:*\n${itens.map((i) => `• ${i}`).join('\n')}`);
    return true;
  }

  if (lower.startsWith('#preco ') || lower.startsWith('#preço ')) {
    const resto = texto.replace(/^#pre[cç]o\s+/i, '').trim();
    const match = resto.match(/^(.*)\s+([0-9]+(?:[.,][0-9]{1,2})?)$/);
    if (match) {
      const nomeItem = match[1].trim();
      const valor = Number(match[2].replace(',', '.'));
      await redisService.salvarPrecoOverride(nomeItem, valor);
      await enviarMensagemWhatsApp(
        destinoEnvio,
        `🏷️ *Preço atualizado hoje:*\n• *${nomeItem}*: R$ ${valor.toFixed(2).replace('.', ',')}`
      );
      return true;
    }
  }

  if (lower === '#falta' || lower === '#esgotados' || lower === '#estoque') {
    const lista = await redisService.listarFaltas();
    const msg = lista.length > 0
      ? `📋 *ITENS EM FALTA HOJE:*\n${lista.map((i) => `• ${i}`).join('\n')}\n\n_Para liberar: #disponivel [corte]_`
      : '✅ *Nenhum item em falta no balcão hoje!*';
    await enviarMensagemWhatsApp(destinoEnvio, msg);
    return true;
  }

  if (lower === '#fechamento') {
    await executarFechamentoExpediente();
    return true;
  }

  return false;
}

app.post(['/webhook', '/webhook/whatsapp', '/api/webhook'], async (req, res) => {
  res.status(200).json({ ok: true });

  try {
    const body = req.body || {};

    let normalizado = null;
    if (whatsappAdapter && typeof whatsappAdapter.normalizarPayloadWebhook === 'function') {
      normalizado = await whatsappAdapter.normalizarPayloadWebhook(body);
    }

    if (!normalizado) return;

    if (isAutomacaoPausadaGlobal()) {
      console.log(`[app] ⏸️ AUTOMAÇÃO PAUSADA GLOBALMENTE. Mensagem de ${normalizado.senderPhone || normalizado.from} ignorada.`);
      return;
    }

    if (normalizado.messageId) {
      const duplicada = await redisService.verificarEDeduplicarMensagem(normalizado.messageId);
      if (duplicada) return;
    }

    const { chaveCanonica, destinoEnvio, telefoneReal } = await resolverIdentificadorUnificado(
      normalizado,
      body
    );

    if (!chaveCanonica) return;

    const textoRecebido = String(normalizado.text || '').trim();

    if (normalizado.isChatPropriaLoja || textoRecebido.startsWith('#')) {
      if (foiEnviadoPeloBot(chaveCanonica, textoRecebido, normalizado.messageId)) {
        return;
      }

      if (textoRecebido.toLowerCase() === '#bot' || textoRecebido.toLowerCase() === '#ativar') {
        await redisService.removerPausa(chaveCanonica);
        return;
      }

      if (textoRecebido.startsWith('#')) {
        const okCmd = await tratarComandoOperacional(textoRecebido, destinoEnvio);
        if (okCmd) return;
      }

      if (normalizado.isImage && normalizado.base64Image) {
        const msgCalibracao = await visaoComandosService.iniciarCalibracaoPorFoto(
          chaveCanonica,
          normalizado.base64Image,
          textoRecebido
        );
        registrarEnvioBot(chaveCanonica, msgCalibracao);
        await enviarMensagemWhatsApp(destinoEnvio, msgCalibracao);
        return;
      }

      if (normalizado.isChatPropriaLoja && textoRecebido) {
        const respConfirmacao = await visaoComandosService.processarConfirmacaoVision(
          chaveCanonica,
          textoRecebido
        );
        if (respConfirmacao) {
          registrarEnvioBot(chaveCanonica, respConfirmacao);
          await enviarMensagemWhatsApp(destinoEnvio, respConfirmacao);
          return;
        }
      }
    }

    if (normalizado.fromMe) {
      if (foiEnviadoPeloBot(chaveCanonica, textoRecebido, normalizado.messageId)) {
        return;
      }

      if (textoRecebido.toLowerCase() === '#bot' || textoRecebido.toLowerCase() === '#ativar') {
        await redisService.removerPausa(chaveCanonica);
        console.log(`[app] Bot reativado manualmente via #bot para ${chaveCanonica}.`);
        return;
      }

      if (isNumeroTestador(chaveCanonica) || isNumeroTestador(telefoneReal)) {
        console.log(`[app] Mensagem do próprio testador/loja detectada para ${chaveCanonica}, imunidade total de pausa mantida.`);
        return;
      }

      await redisService.ativarPausa(chaveCanonica, TEMPO_PAUSA_HUMANA_SEG);
      console.log(`[app] Intervenção humana detectada para ${chaveCanonica}. Bot pausado por 30 min.`);
      return;
    }

    // === INTERCEPTADOR DETERMINÍSTICO DE OPT-OUT (CASO BRUNO) ===
    const isOptOut = /^(sair|parar|cancelar|remover|me tira da lista|não quero receber|nao quero receber|remover da lista|remover meu numero|remover meu número)\b/i.test(textoRecebido.trim());
    if (isOptOut) {
      console.log(`[app] 🛑 Solicitação de OPT-OUT detectada para ${chaveCanonica} (${normalizado.pushName}).`);
      try {
        const { pool } = require('./database');
        if (pool) {
          await pool.query(
            'UPDATE clientes SET opt_out = true WHERE telefone = $1 OR telefone = $2 OR telefone = $3',
            [telefoneReal || '', chaveCanonica, chaveCanonica.replace(/\D/g, '')]
          );
        }
      } catch (eOpt) {
        console.warn('[app] Falha ao gravar opt-out no banco:', eOpt.message);
      }
      const msgOptOut = 'Tudo bem! Seu número foi removido da nossa lista de novidades e promoções. Se precisar de carnes frescas ou pedidos no futuro, é só chamar por aqui. Um abraço do Coisas da Roça! 👍';
      registrarEnvioBot(chaveCanonica, msgOptOut);
      await enviarMensagemWhatsApp(destinoEnvio, msgOptOut);
      return;
    }

    const motivoBloqueio = isMensagemFornecedorOuRobo(textoRecebido, normalizado.pushName);
    if (motivoBloqueio) {
      await redisService.ativarPausa(chaveCanonica, 3600);
      return;
    }

    if (await redisService.estaEmPausa(chaveCanonica)) {
      return;
    }

    if (normalizado.messageId && whatsappAdapter?.marcarMensagemComoLida) {
      setTimeout(() => {
        whatsappAdapter.marcarMensagemComoLida(destinoEnvio, normalizado.messageId).catch(() => {});
      }, 2000).unref();
    }

    let textoFinal = textoRecebido;
    if (normalizado.isAudio && normalizado.base64Audio) {
      const transcricao = await transcreverAudioSeguro(
        normalizado.base64Audio,
        telefoneReal || chaveCanonica
      );
      textoFinal = textoFinal ? `${textoFinal}\n${transcricao}` : transcricao;
    }

    if (normalizado.isImage && geminiService && typeof geminiService.lerListaComprasImagem === 'function') {
      try {
        const urlImg = normalizado.imageUrl || (normalizado.base64Image ? `data:image/jpeg;base64,${normalizado.base64Image}` : null);
        if (urlImg) {
          const listaOcr = await geminiService.lerListaComprasImagem(urlImg);
          if (listaOcr) {
            const prefixo = `[Foto de lista de compras enviada pelo cliente]:\n${listaOcr}`;
            textoFinal = textoFinal ? `${textoFinal}\n${prefixo}` : prefixo;
          }
        }
      } catch (errOcr) {
        console.warn('[app] Falha ao processar OCR de lista de compras:', errOcr.message);
      }
    }

    if (!textoFinal) return;

    await redisService.adicionarBufferMensagem(chaveCanonica, {
      texto: textoFinal,
      destinoEnvio,
      telefoneReal,
      nomeCliente: normalizado.pushName || '',
      isAudio: Boolean(normalizado.isAudio),
    });

    if (timersDebounceLocais.has(chaveCanonica)) {
      clearTimeout(timersDebounceLocais.get(chaveCanonica));
    }

    const timer = setTimeout(() => {
      executarTurnoConsolidado(chaveCanonica).catch((err) => {
        console.error(`[app] Erro ao processar turno de ${chaveCanonica}:`, err);
      });
    }, TEMPO_DEBOUNCE_MS);
    timersDebounceLocais.set(chaveCanonica, timer);
  } catch (err) {
    console.error('[app] Erro inesperado no webhook:', err);
  }
});

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
        const jobConfirmado = await impressaoTermicaService.confirmarImpressaoJob(id);
        try {
          const telCliente = jobConfirmado?.cliente_telefone || jobConfirmado?.contato || req.body?.cliente_telefone || req.body?.contato;
          if (telCliente && typeof enviarMensagemWhatsApp === 'function') {
            await enviarMensagemWhatsApp(
              telCliente,
              '> 🥩 *Status do Pedido:* Sua comanda acabou de sair na impressora do nosso balcão e o açougueiro já começou a separar seus cortes! Assim que passar na balança, te enviamos o cupom por aqui.'
            );
          }
        } catch (eNotif) {
          console.warn('[app] Aviso de impressão não enviado no WhatsApp:', eNotif.message);
        }
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

app.post('/api/pesagem/ean13', autenticarWorkerInterno, async (req, res) => {
  try {
    const { barcode, codigoPedido, telefoneCliente } = req.body || {};
    const resultado = await pesagemPixService.processarEtiquetaPesagemEan13({
      barcode,
      codigoPedido,
      telefoneCliente,
    });
    res.json(resultado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/expediente/fechamento', autenticarWorkerInterno, async (req, res) => {
  try {
    const resumo = await executarFechamentoExpediente();
    res.json(resumo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/worker-caixa1.ps1', autenticarWorkerInterno, (req, res) => {
  const candidatos = [
    path.resolve(__dirname, '../../scripts/worker_impressao_caixa1.ps1'),
    path.resolve(__dirname, '../scripts/worker_impressao_caixa1.ps1'),
    path.resolve(__dirname, './worker_impressao_caixa1.ps1'),
    path.resolve(__dirname, '../worker_impressao_caixa1.ps1'),
    path.resolve(__dirname, 'worker_impressao_caixa1.ps1'),
  ];
  const workerFile = candidatos.find((p) => fs.existsSync(p));
  if (workerFile) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.sendFile(workerFile);
  }
  return res.status(404).send('# Arquivo worker_impressao_caixa1.ps1 não encontrado no servidor');
});

app.post('/api/produtos/sync', autenticarWorkerInterno, async (req, res) => {
  try {
    const { produtos } = req.body || {};
    if (!produtos || !Array.isArray(produtos)) {
      return res.status(400).json({ error: 'Array "produtos" é obrigatório no corpo da requisição.' });
    }
    if (!produtosService || typeof produtosService.atualizarCatalogoSgm !== 'function') {
      return res.status(500).json({ error: 'produtosService indisponível no servidor' });
    }
    const resultado = await produtosService.atualizarCatalogoSgm(produtos);
    console.log(`[API /api/produtos/sync] Sincronização concluída: ${resultado.totalRecebidos} produtos recebidos, ${resultado.atualizadosDb} atualizados no Supabase.`);
    return res.status(200).json(resultado);
  } catch (err) {
    console.error('[API /api/produtos/sync] Erro ao sincronizar catálogo:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/produtos/catalogo', autenticarWorkerInterno, (req, res) => {
  try {
    if (!produtosService) return res.status(500).json({ error: 'produtosService indisponível' });
    const lista = produtosService.carregarCatalogo(true);
    return res.status(200).json({
      total: lista.length,
      primeirosItens: lista.slice(0, 10),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/conversa/despausar', autenticarWorkerInterno, async (req, res) => {
  const { telefone } = req.body || {};
  if (telefone) {
    const limpo = String(telefone).trim();
    await redisService.removerPausa(limpo);
    await redisService.removerPausa(limpo.replace(/\D/g, ''));
    return res.json({ ok: true, mensagem: `Conversa ${limpo} despausada com sucesso.` });
  }
  res.status(400).json({ error: 'Telefone obrigatório' });
});

app.post('/api/sessao/reset', autenticarWorkerInterno, async (req, res) => {
  const { telefone } = req.body || {};
  if (telefone) {
    const limpo = String(telefone).trim();
    const cleanDigits = limpo.replace(/\D/g, '');
    await redisService.limparSessao(limpo);
    if (cleanDigits && cleanDigits !== limpo) {
      await redisService.limparSessao(cleanDigits);
    }
    await redisService.removerPausa(limpo);
    if (cleanDigits && cleanDigits !== limpo) {
      await redisService.removerPausa(cleanDigits);
    }
    return res.json({ ok: true, mensagem: `Sessão e pausa de ${limpo} resetadas com sucesso.` });
  }
  res.status(400).json({ error: 'Telefone obrigatório' });
});

app.get('/api/automacao/status', (req, res) => {
  res.json({
    pausado: isAutomacaoPausadaGlobal(),
    motivo: process.env.AUTOMACOES_PAUSADAS === 'true' ? 'Variavel AUTOMACOES_PAUSADAS' : (pausaGlobalMemoria ? 'Pausa Manual via API' : 'Ativo'),
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/automacao/pausar', autenticarWorkerInterno, (req, res) => {
  pausaGlobalMemoria = true;
  console.log('⏸️ [app] Automação PAUSADA GLOBALMENTE via endpoint /api/automacao/pausar');
  res.json({ ok: true, pausado: true, mensagem: 'Automação de atendimento pausada globalmente.' });
});

app.post('/api/automacao/ativar', autenticarWorkerInterno, (req, res) => {
  pausaGlobalMemoria = false;
  console.log('▶️ [app] Automação ATIVADA GLOBALMENTE via endpoint /api/automacao/ativar');
  res.json({ ok: true, pausado: false, mensagem: 'Automação de atendimento ativada com sucesso.' });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'online',
    loja: process.env.NOME_LOJA || 'Açougue e Mercearia Coisas da Roça',
    redisConectado: redisService.isRedisConectado(),
    automacaoPausada: isAutomacaoPausadaGlobal(),
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`[Coisas da Roça] Servidor de atendimento rodando 24/7 na porta ${PORT}`);
});

module.exports = app;
