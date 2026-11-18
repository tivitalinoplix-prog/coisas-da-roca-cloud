require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const { processarMensagemReceptiva } = require('./services/atendimentoReceptivoService');
const redisService = require('./services/redisService');

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
app.use('/assets', express.static(path.join(__dirname, 'assets')));

const PORT = process.env.PORT || 3001;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'coisasdaroca_internal_caixa1_secret_2026';

function autenticarWorkerInterno(req, res, next) {
  if (!INTERNAL_API_KEY) return next();
  const token = req.headers['x-api-key'] || req.query.key;
  if (token !== INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  next();
}

const mapaLidParaTelefone = new Map();
const historicoSessoes = new Map();
const pausasAtendimentoHumano = new Map();
const mensagensEnviadasPeloBot = new Set();
const mensagensProcessadasIds = new Map();
const buffersDebounce = new Map();
const processamentoEmAndamento = new Set();
const filaPendentePosLock = new Map();

const TEMPO_DEBOUNCE_MS = Number(process.env.DEBOUNCE_MS || 3500);
const TEMPO_PAUSA_HUMANA_MS = Number(process.env.PAUSA_HUMANA_MINUTOS || 30) * 60 * 1000;
const TTL_SESSAO_MS = 24 * 60 * 60 * 1000; // 24 horas
const TTL_DEDUP_MSG_MS = 5 * 60 * 1000;

setInterval(() => {
  const agora = Date.now();
  for (const [k, expiraEm] of pausasAtendimentoHumano.entries()) {
    if (expiraEm <= agora) pausasAtendimentoHumano.delete(k);
  }
  for (const [k, msgs] of historicoSessoes.entries()) {
    const validas = msgs.filter((m) => agora - (m.timestamp || agora) < TTL_SESSAO_MS);
    if (validas.length === 0) historicoSessoes.delete(k);
    else if (validas.length !== msgs.length) historicoSessoes.set(k, validas);
  }
  for (const [msgId, ts] of mensagensProcessadasIds.entries()) {
    if (agora - ts > TTL_DEDUP_MSG_MS) mensagensProcessadasIds.delete(msgId);
  }
}, 15 * 60 * 1000).unref();

function migrarSessaoSeNecessario(chaveOrigem, chaveDestino) {
  if (!chaveOrigem || !chaveDestino || chaveOrigem === chaveDestino) return;

  if (historicoSessoes.has(chaveOrigem)) {
    const antiga = historicoSessoes.get(chaveOrigem) || [];
    const atual = historicoSessoes.get(chaveDestino) || [];
    historicoSessoes.set(chaveDestino, [...antiga, ...atual].slice(-20));
    historicoSessoes.delete(chaveOrigem);
  }

  if (pausasAtendimentoHumano.has(chaveOrigem)) {
    const expiraOrigem = pausasAtendimentoHumano.get(chaveOrigem);
    const expiraDestino = pausasAtendimentoHumano.get(chaveDestino) || 0;
    pausasAtendimentoHumano.set(chaveDestino, Math.max(expiraOrigem, expiraDestino));
    pausasAtendimentoHumano.delete(chaveOrigem);
  }
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
    mapaLidParaTelefone.set(lidKey, telCandidato);
    redisService.salvarMapeamentoLid(lidKey, telCandidato).catch(() => {});
    migrarSessaoSeNecessario(lidKey, telCandidato);
  }

  if (sessionKey.startsWith('lid:') && !mapaLidParaTelefone.has(sessionKey)) {
    try {
      const telMapeadoRedis = await redisService.obterTelefonePorLid(sessionKey);
      if (telMapeadoRedis) {
        mapaLidParaTelefone.set(sessionKey, telMapeadoRedis);
      }
    } catch (_) {}
  }

  if (sessionKey.startsWith('lid:') && mapaLidParaTelefone.has(sessionKey)) {
    const telMapeado = mapaLidParaTelefone.get(sessionKey);
    return {
      chaveCanonica: telMapeado,
      destinoEnvio: replyTarget,
      telefoneReal: telMapeado,
    };
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
  if (messageId && mensagensEnviadasPeloBot.has(`id:${messageId}`)) {
    return true;
  }
  if (texto) {
    const assinatura = `${chaveCanonica}:${String(texto).slice(0, 60).trim()}`;
    if (mensagensEnviadasPeloBot.has(assinatura)) return true;
  }
  return false;
}

async function enviarMensagemWhatsApp(destino, texto) {
  if (!destino || !texto) return null;

  if (whatsappAdapter && typeof whatsappAdapter.enviarTextoUniversal === 'function') {
    return whatsappAdapter.enviarTextoUniversal(destino, texto);
  }

  const baseUrl = (process.env.WAPI_BASE_URL || 'https://api.w-api.app/v1').replace(/\/$/, '');
  const instanceId = process.env.WAPI_INSTANCE_ID;
  const token = process.env.WAPI_TOKEN;

  if (baseUrl && instanceId && token) {
    const phoneLimpo = /@lid/i.test(destino)
      ? destino
      : String(destino).replace(/@s\.whatsapp\.net|@c\.us/gi, '');
    const res = await fetch(`${baseUrl}/message/send-text?instanceId=${instanceId}`, {
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
    return res.json().catch(() => null);
  }

  console.warn('[app] Nenhum método de envio WhatsApp configurado para responder:', destino);
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
  telefoneReal,
  nomeCliente,
  dadosPedido,
  respostaIA,
}) {
  if (!dadosPedido) return;

  if (telefoneReal && supabaseService) {
    try {
      if (typeof supabaseService.upsertCliente === 'function') {
        await supabaseService.upsertCliente({
          telefone: telefoneReal,
          nome: dadosPedido.cliente_nome || nomeCliente || null,
          bairro: dadosPedido.endereco || null,
        });
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

  try {
    if (impressaoTermicaService && typeof impressaoTermicaService.enfileirarImpressaoPedido === 'function') {
      await impressaoTermicaService.enfileirarImpressaoPedido({
        pedidoId: dadosPedido.codigo_pedido || Date.now().toString().slice(-4),
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
    }
  } catch (err) {
    console.error('[app] Erro ao enfileirar impressão térmica:', err.message);
  }

  historicoSessoes.delete(chaveCanonica);
  await redisService.limparSessao(chaveCanonica);
}

async function executarTurnoConsolidado(chaveCanonica) {
  const pacote = buffersDebounce.get(chaveCanonica);
  buffersDebounce.delete(chaveCanonica);

  if (!pacote || !pacote.mensagens.length) return;

  const emPausaRedis = await redisService.estaEmPausa(chaveCanonica);
  const emPausaMemoria = (pausasAtendimentoHumano.get(chaveCanonica) || 0) > Date.now();
  if (emPausaRedis || emPausaMemoria) {
    return;
  }

  if (processamentoEmAndamento.has(chaveCanonica)) {
    const pendente = filaPendentePosLock.get(chaveCanonica) || { mensagens: [], meta: pacote.meta };
    pendente.mensagens.push(...pacote.mensagens);
    pendente.meta = { ...pendente.meta, ...pacote.meta };
    filaPendentePosLock.set(chaveCanonica, pendente);
    return;
  }

  processamentoEmAndamento.add(chaveCanonica);
  const inicioMs = Date.now();

  try {
    const textoConsolidado = pacote.mensagens.join('\n');
    const { destinoEnvio, telefoneReal, nomeCliente } = pacote.meta;

    // Hidrata sessão unificada no Redis (com fallback gracioso em memória)
    const sessaoAtiva = await redisService.obterSessao(chaveCanonica);
    const faltasBalcao = await redisService.listarFaltas();
    const perfilCliente = await carregarPerfilCliente(telefoneReal);

    const resultado = await processarMensagemReceptiva(textoConsolidado, sessaoAtiva, {
      nomeCliente: nomeCliente || perfilCliente?.nome || sessaoAtiva.clienteNome || '',
      perfilCliente,
      faltasBalcao,
    });

    const aindaEmPausa =
      (await redisService.estaEmPausa(chaveCanonica)) ||
      (pausasAtendimentoHumano.get(chaveCanonica) || 0) > Date.now();

    if (aindaEmPausa) {
      console.log(`[app] Resposta descartada para ${chaveCanonica}: operador humano assumiu durante processamento.`);
      return;
    }

    // Persiste atualização da sessão rica no Redis
    if (resultado.sessaoAtualizada) {
      await redisService.salvarSessao(chaveCanonica, resultado.sessaoAtualizada);
    }

    // Se a IA indicou envio de logo nas boas-vindas
    if (resultado.enviarLogo) {
      const logoUrl =
        process.env.URL_LOGO_OFICIAL ||
        'https://coisasdaroca-core-production.up.railway.app/assets/logo.png';
      if (whatsappAdapter && typeof whatsappAdapter.enviarImagemUniversal === 'function') {
        whatsappAdapter.enviarImagemUniversal(destinoEnvio, logoUrl, '').catch(() => {});
      }
    }

    if (resultado.resposta) {
      registrarEnvioBot(chaveCanonica, resultado.resposta);

      let envioRes = null;
      if (resultado.tipoBotoes === 'PAGAMENTO') {
        const botoes = [
          { id: 'btn_pix', label: '💠 Pix' },
          { id: 'btn_cartao', label: '💳 Cartão na Entrega' },
          { id: 'btn_dinheiro', label: '💵 Dinheiro' },
        ];
        if (whatsappAdapter && typeof whatsappAdapter.enviarBotoesUniversal === 'function') {
          envioRes = await whatsappAdapter.enviarBotoesUniversal(destinoEnvio, resultado.resposta, botoes);
        } else {
          envioRes = await enviarMensagemWhatsApp(destinoEnvio, resultado.resposta);
        }
      } else if (resultado.tipoBotoes === 'CONFIRMACAO') {
        const botoes = [
          { id: 'btn_confirmar', label: '✅ Confirmar Pedido' },
          { id: 'btn_ajustar', label: '✏️ Ajustar Itens' },
        ];
        if (whatsappAdapter && typeof whatsappAdapter.enviarBotoesUniversal === 'function') {
          envioRes = await whatsappAdapter.enviarBotoesUniversal(destinoEnvio, resultado.resposta, botoes);
        } else {
          envioRes = await enviarMensagemWhatsApp(destinoEnvio, resultado.resposta);
        }
      } else {
        envioRes = await enviarMensagemWhatsApp(destinoEnvio, resultado.resposta);
      }

      const sentMsgId = envioRes?.messageId || envioRes?.key?.id || envioRes?.id || null;
      if (sentMsgId) {
        registrarEnvioBot(chaveCanonica, null, sentMsgId);
      }
    }

    if (supabaseService && typeof supabaseService.registrarConversa === 'function') {
      supabaseService
        .registrarConversa({
          clienteTelefone: telefoneReal || chaveCanonica,
          nomeCliente: nomeCliente || perfilCliente?.nome || null,
          mensagemCliente: textoConsolidado,
          tipoMensagem: pacote.meta.isAudio ? 'audio' : 'texto',
          respostaIA: resultado.resposta || '',
          tempoRespostaMs: Date.now() - inicioMs,
        })
        .catch(() => {});
    }

    if (resultado.transbordoHumano) {
      pausasAtendimentoHumano.set(chaveCanonica, Date.now() + TEMPO_PAUSA_HUMANA_MS);
      await redisService.ativarPausa(chaveCanonica, TEMPO_PAUSA_HUMANA_MS / 1000);
      console.log(`[app] Transbordo humano acionado para ${chaveCanonica}. Bot pausado por 30 min.`);
    }

    if (resultado.pedidoFechado) {
      await finalizarPedidoEDespachar({
        chaveCanonica,
        telefoneReal,
        nomeCliente,
        dadosPedido: resultado.dadosPedido,
        respostaIA: resultado.resposta,
      });
    }
  } finally {
    processamentoEmAndamento.delete(chaveCanonica);

    if (filaPendentePosLock.has(chaveCanonica)) {
      const proximo = filaPendentePosLock.get(chaveCanonica);
      filaPendentePosLock.delete(chaveCanonica);
      buffersDebounce.set(chaveCanonica, {
        mensagens: proximo.mensagens,
        meta: proximo.meta,
        timer: null,
      });
      executarTurnoConsolidado(chaveCanonica).catch((err) => {
        console.error(`[app] Erro ao drenar fila pós-lock de ${chaveCanonica}:`, err);
      });
    }
  }
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

    if (normalizado.messageId) {
      const jaProcessada = await redisService.verificarEDeduplicarMensagem(normalizado.messageId);
      if (jaProcessada || mensagensProcessadasIds.has(normalizado.messageId)) {
        return;
      }
      mensagensProcessadasIds.set(normalizado.messageId, Date.now());
    }

    const { chaveCanonica, destinoEnvio, telefoneReal } = await resolverIdentificadorUnificado(
      normalizado,
      body
    );

    if (!chaveCanonica) return;

    if (normalizado.fromMe) {
      const textoOperador = String(normalizado.text || '').trim();

      if (foiEnviadoPeloBot(chaveCanonica, textoOperador, normalizado.messageId)) {
        return;
      }

      if (textoOperador.toLowerCase() === '#bot') {
        pausasAtendimentoHumano.delete(chaveCanonica);
        await redisService.removerPausa(chaveCanonica);
        console.log(`[app] Bot reativado manualmente via #bot para ${chaveCanonica}.`);
        return;
      }

      pausasAtendimentoHumano.set(chaveCanonica, Date.now() + TEMPO_PAUSA_HUMANA_MS);
      await redisService.ativarPausa(chaveCanonica, TEMPO_PAUSA_HUMANA_MS / 1000);
      console.log(`[app] Intervenção humana detectada para ${chaveCanonica}. Bot pausado por 30 min.`);
      return;
    }

    const emPausaRedis = await redisService.estaEmPausa(chaveCanonica);
    const emPausaMemoria = (pausasAtendimentoHumano.get(chaveCanonica) || 0) > Date.now();
    if (emPausaRedis || emPausaMemoria) {
      return;
    }

    let textoFinal = normalizado.text || '';
    if (normalizado.isAudio && normalizado.base64Audio) {
      const transcricao = await transcreverAudioSeguro(
        normalizado.base64Audio,
        telefoneReal || chaveCanonica
      );
      textoFinal = textoFinal ? `${textoFinal}\n${transcricao}` : transcricao;
    }

    if (!textoFinal) return;

    const nomeCliente = normalizado.pushName || '';

    const existente = buffersDebounce.get(chaveCanonica);
    if (existente) {
      clearTimeout(existente.timer);
      existente.mensagens.push(textoFinal);
      existente.meta.destinoEnvio = destinoEnvio || existente.meta.destinoEnvio;
      if (nomeCliente) existente.meta.nomeCliente = nomeCliente;
      if (normalizado.isAudio) existente.meta.isAudio = true;
    } else {
      buffersDebounce.set(chaveCanonica, {
        mensagens: [textoFinal],
        meta: {
          destinoEnvio,
          telefoneReal,
          nomeCliente,
          isAudio: Boolean(normalizado.isAudio),
        },
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
// ENDPOINTS DE FALTAS DE BALCÃO
// ============================================================================
app.get('/api/balcao/faltas', autenticarWorkerInterno, async (req, res) => {
  try {
    const faltas = await redisService.listarFaltas();
    res.json({ ok: true, faltas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/balcao/faltas', autenticarWorkerInterno, async (req, res) => {
  try {
    const { item } = req.body || {};
    if (!item) return res.status(400).json({ error: 'Item obrigatório' });
    await redisService.adicionarFalta(item);
    res.json({ ok: true, mensagem: `Falta adicionada: ${item}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/balcao/faltas', autenticarWorkerInterno, async (req, res) => {
  try {
    const { item } = req.body || {};
    if (!item) return res.status(400).json({ error: 'Item obrigatório' });
    await redisService.removerFalta(item);
    res.json({ ok: true, mensagem: `Falta removida: ${item}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

app.post('/api/conversa/despausar', autenticarWorkerInterno, async (req, res) => {
  const { telefone } = req.body || {};
  if (telefone) {
    const limpo = String(telefone).trim();
    pausasAtendimentoHumano.delete(limpo);
    pausasAtendimentoHumano.delete(limpo.replace(/\D/g, ''));
    await redisService.removerPausa(limpo);
    await redisService.removerPausa(limpo.replace(/\D/g, ''));
    return res.json({ ok: true, mensagem: `Conversa ${limpo} despausada com sucesso.` });
  }
  res.status(400).json({ error: 'Telefone obrigatório' });
});

// Rota de saúde para monitoramento (Railway / Docker / Uptime)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'online',
    loja: process.env.NOME_LOJA || 'Açougue e Mercearia Coisas da Roça',
    redisConectado: redisService.isRedisConectado(),
    sessoesAtivas: historicoSessoes.size,
    pausasHumanasAtivas: pausasAtendimentoHumano.size,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`[Coisas da Roça] Servidor de atendimento rodando 24/7 na porta ${PORT}`);
});

module.exports = app;
