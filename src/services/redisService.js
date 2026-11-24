const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL || '';

const TTL_SESSAO_SEG = 24 * 60 * 60; // 24 horas
const TTL_BUFFER_SEG = 60; // 60 segundos
const TTL_PAUSA_PADRAO_SEG = Number(process.env.PAUSA_HUMANA_MINUTOS || 30) * 60; // 30 minutos
const TTL_DEDUP_SEG = 5 * 60; // 5 minutos
const TTL_FALTAS_SEG = 24 * 60 * 60; // 24 horas
const TTL_LID_MAP_SEG = 30 * 24 * 60 * 60; // 30 dias
const TTL_VISION_PENDENTE_SEG = 10 * 60; // 10 minutos
const TTL_PEDIDO_ATIVO_SEG = 12 * 60 * 60; // 12 horas
const TTL_LOCK_SEG = 30; // 30 segundos

let redisClient = null;
let redisConectado = false;

const memSessoes = new Map();
const memBuffers = new Map();
const memPausas = new Map();
const memDedup = new Map();
const memFaltas = new Set();
const memPrecosOverride = new Map();
const memLidMap = new Map();
const memVisionPendente = new Map();
const memPedidosAtivos = new Map();
const memLocks = new Map();

if (REDIS_URL) {
  try {
    redisClient = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      retryStrategy(times) {
        return Math.min(times * 500, 5000);
      },
      tls: REDIS_URL.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
    });

    redisClient.on('ready', () => {
      redisConectado = true;
      console.log('[Redis] Conectado e pronto para operação.');
    });

    redisClient.on('error', (err) => {
      redisConectado = false;
      console.warn('[Redis] Erro de conexão (usando fallback seguro):', err.message);
    });

    redisClient.on('close', () => {
      redisConectado = false;
    });
  } catch (err) {
    console.warn('[Redis] Falha ao inicializar ioredis:', err.message);
    redisClient = null;
  }
} else {
  console.warn('[Redis] REDIS_URL não definida. Operando em fallback em memória até configurar o Redis.');
}

function isRedisConectado() {
  return Boolean(redisClient && redisConectado);
}

function criarSessaoVazia() {
  return {
    clienteNome: '',
    itens: [],
    endereco: '',
    bairro: '',
    forma_pagamento: '',
    troco_para: null,
    etapa: 'INICIO',
    boasVindasEnviada: false,
    historico: [],
    atualizadoEm: new Date().toISOString(),
  };
}

async function adquirirLock(chave, ttlSeg = TTL_LOCK_SEG) {
  if (!chave) return true;
  const key = `lock:${chave}`;

  if (isRedisConectado()) {
    try {
      const ok = await redisClient.set(key, '1', 'EX', ttlSeg, 'NX');
      return ok === 'OK';
    } catch (err) {
      console.warn('[Redis] Erro ao adquirir lock:', err.message);
    }
  }

  const agora = Date.now();
  const exp = memLocks.get(key) || 0;
  if (exp > agora) return false;
  memLocks.set(key, agora + ttlSeg * 1000);
  return true;
}

async function liberarLock(chave) {
  if (!chave) return;
  const key = `lock:${chave}`;
  memLocks.delete(key);

  if (isRedisConectado()) {
    try {
      await redisClient.del(key);
    } catch (err) {
      console.warn('[Redis] Erro ao liberar lock:', err.message);
    }
  }
}

async function obterSessao(chave) {
  if (!chave) return criarSessaoVazia();
  const key = `sessao:${chave}`;

  if (isRedisConectado()) {
    try {
      const raw = await redisClient.get(key);
      if (raw) {
        return { ...criarSessaoVazia(), ...JSON.parse(raw) };
      }
    } catch (err) {
      console.warn('[Redis] Erro ao ler sessão:', err.message);
    }
  }

  const local = memSessoes.get(key);
  if (local && local.expiraEm > Date.now()) {
    return { ...criarSessaoVazia(), ...local.dados };
  }
  return criarSessaoVazia();
}

async function salvarSessao(chave, sessao) {
  if (!chave || !sessao) return;
  const key = `sessao:${chave}`;
  const payload = {
    ...criarSessaoVazia(),
    ...sessao,
    historico: Array.isArray(sessao.historico) ? sessao.historico.slice(-16) : [],
    atualizadoEm: new Date().toISOString(),
  };

  memSessoes.set(key, { dados: payload, expiraEm: Date.now() + TTL_SESSAO_SEG * 1000 });

  if (isRedisConectado()) {
    try {
      await redisClient.set(key, JSON.stringify(payload), 'EX', TTL_SESSAO_SEG);
    } catch (err) {
      console.warn('[Redis] Erro ao salvar sessão:', err.message);
    }
  }
}

async function limparSessao(chave) {
  if (!chave) return;
  const key = `sessao:${chave}`;
  memSessoes.delete(key);

  if (isRedisConectado()) {
    try {
      await redisClient.del(key);
    } catch (err) {
      console.warn('[Redis] Erro ao limpar sessão:', err.message);
    }
  }
}

async function adicionarBufferMensagem(chave, payloadMsg) {
  if (!chave || !payloadMsg) return;
  const key = `buffer:${chave}`;
  const serializado = JSON.stringify(payloadMsg);

  if (isRedisConectado()) {
    try {
      await redisClient.rpush(key, serializado);
      await redisClient.expire(key, TTL_BUFFER_SEG);
      return;
    } catch (err) {
      console.warn('[Redis] Erro ao adicionar no buffer:', err.message);
    }
  }

  const lista = memBuffers.get(key) || [];
  lista.push(payloadMsg);
  memBuffers.set(key, lista);
}

async function consumirBufferMensagens(chave) {
  if (!chave) return [];
  const key = `buffer:${chave}`;

  if (isRedisConectado()) {
    try {
      const multi = redisClient.multi();
      multi.lrange(key, 0, -1);
      multi.del(key);
      const resultados = await multi.exec();
      const itensBrutos = resultados?.[0]?.[1] || [];
      if (Array.isArray(itensBrutos) && itensBrutos.length > 0) {
        return itensBrutos.map((s) => JSON.parse(s));
      }
    } catch (err) {
      console.warn('[Redis] Erro ao consumir buffer:', err.message);
    }
  }

  const local = memBuffers.get(key) || [];
  memBuffers.delete(key);
  return local;
}

function isNumeroTestador(chave = '') {
  const cleanPhone = String(chave || '').replace(/\D/g, '');
  if (!cleanPhone) return false;
  if (
    cleanPhone.includes('998586180') ||
    cleanPhone.includes('173679971422247') ||
    cleanPhone.includes('148863600070757')
  ) {
    return true;
  }
  const envTestadores = String(process.env.TELEFONES_TESTADORES || '')
    .split(',')
    .map((s) => s.replace(/\D/g, ''))
    .filter(Boolean);
  return envTestadores.some((t) => cleanPhone.includes(t) || t.includes(cleanPhone));
}

async function ativarPausa(chave, segundos = TTL_PAUSA_PADRAO_SEG) {
  if (!chave || isNumeroTestador(chave)) return;
  const key = `pausa:${chave}`;
  const ttl = Math.max(60, Number(segundos) || TTL_PAUSA_PADRAO_SEG);

  memPausas.set(key, Date.now() + ttl * 1000);

  if (isRedisConectado()) {
    try {
      await redisClient.set(key, '1', 'EX', ttl);
    } catch (err) {
      console.warn('[Redis] Erro ao ativar pausa:', err.message);
    }
  }
}

async function estaEmPausa(chave) {
  if (!chave || isNumeroTestador(chave)) return false;
  const key = `pausa:${chave}`;

  if (isRedisConectado()) {
    try {
      const val = await redisClient.get(key);
      if (val === '1') return true;
      return false;
    } catch (err) {
      console.warn('[Redis] Erro ao checar pausa:', err.message);
    }
  }

  const expira = memPausas.get(key) || 0;
  if (expira > Date.now()) return true;
  memPausas.delete(key);
  return false;
}

async function removerPausa(chave) {
  if (!chave) return;
  const key = `pausa:${chave}`;
  memPausas.delete(key);

  if (isRedisConectado()) {
    try {
      await redisClient.del(key);
    } catch (err) {
      console.warn('[Redis] Erro ao remover pausa:', err.message);
    }
  }
}

async function verificarEDeduplicarMensagem(messageId, ttlSeg = TTL_DEDUP_SEG) {
  if (!messageId) return false;
  const key = `dedup:${messageId}`;

  if (isRedisConectado()) {
    try {
      const res = await redisClient.set(key, '1', 'EX', ttlSeg, 'NX');
      return res === null;
    } catch (err) {
      console.warn('[Redis] Erro na deduplicação:', err.message);
    }
  }

  const agora = Date.now();
  const exp = memDedup.get(key);
  if (exp && exp > agora) return true;
  memDedup.set(key, agora + ttlSeg * 1000);
  return false;
}

async function adicionarFalta(item) {
  const limpo = String(item || '').trim();
  if (!limpo) return;
  memFaltas.add(limpo);

  if (isRedisConectado()) {
    try {
      await redisClient.sadd('faltas_balcao', limpo);
      await redisClient.expire('faltas_balcao', TTL_FALTAS_SEG);
    } catch (err) {
      console.warn('[Redis] Erro ao adicionar falta:', err.message);
    }
  }
}

async function removerFalta(item) {
  const alvo = String(item || '').trim().toLowerCase();
  if (!alvo) return;

  for (const x of Array.from(memFaltas)) {
    if (x.toLowerCase().includes(alvo) || alvo.includes(x.toLowerCase())) {
      memFaltas.delete(x);
    }
  }

  if (isRedisConectado()) {
    try {
      const atuais = await redisClient.smembers('faltas_balcao');
      for (const x of atuais) {
        const xl = String(x).toLowerCase();
        if (xl === alvo || xl.includes(alvo) || alvo.includes(xl)) {
          await redisClient.srem('faltas_balcao', x);
        }
      }
    } catch (err) {
      console.warn('[Redis] Erro ao remover falta:', err.message);
    }
  }
}

async function listarFaltas() {
  if (isRedisConectado()) {
    try {
      const itens = await redisClient.smembers('faltas_balcao');
      return itens || [];
    } catch (err) {
      console.warn('[Redis] Erro ao listar faltas:', err.message);
    }
  }
  return Array.from(memFaltas);
}

async function salvarPrecoOverride(itemNome, precoValor) {
  const chave = String(itemNome || '').trim().toUpperCase();
  const preco = Number(String(precoValor).replace(',', '.'));
  if (!chave || !(preco > 0)) return false;

  memPrecosOverride.set(chave, preco);

  if (isRedisConectado()) {
    try {
      await redisClient.hset('precos_override', chave, String(preco));
      await redisClient.expire('precos_override', TTL_FALTAS_SEG);
    } catch (err) {
      console.warn('[Redis] Erro ao salvar override de preço:', err.message);
    }
  }
  return true;
}

async function listarPrecosOverride() {
  if (isRedisConectado()) {
    try {
      const raw = await redisClient.hgetall('precos_override');
      const out = {};
      for (const [k, v] of Object.entries(raw || {})) {
        out[k] = Number(v);
      }
      return out;
    } catch (err) {
      console.warn('[Redis] Erro ao listar overrides de preço:', err.message);
    }
  }

  const out = {};
  for (const [k, v] of memPrecosOverride.entries()) {
    out[k] = v;
  }
  return out;
}

async function salvarVisionPendente(telefone, payloadVision) {
  if (!telefone || !payloadVision) return;
  const key = `vision_pendente:${telefone}`;
  memVisionPendente.set(key, {
    dados: payloadVision,
    expiraEm: Date.now() + TTL_VISION_PENDENTE_SEG * 1000,
  });

  if (isRedisConectado()) {
    try {
      await redisClient.set(key, JSON.stringify(payloadVision), 'EX', TTL_VISION_PENDENTE_SEG);
    } catch (err) {
      console.warn('[Redis] Erro ao salvar vision_pendente:', err.message);
    }
  }
}

async function obterVisionPendente(telefone) {
  if (!telefone) return null;
  const key = `vision_pendente:${telefone}`;

  if (isRedisConectado()) {
    try {
      const raw = await redisClient.get(key);
      if (raw) return JSON.parse(raw);
    } catch (err) {
      console.warn('[Redis] Erro ao ler vision_pendente:', err.message);
    }
  }

  const local = memVisionPendente.get(key);
  if (local && local.expiraEm > Date.now()) return local.dados;
  memVisionPendente.delete(key);
  return null;
}

async function limparVisionPendente(telefone) {
  if (!telefone) return;
  const key = `vision_pendente:${telefone}`;
  memVisionPendente.delete(key);

  if (isRedisConectado()) {
    try {
      await redisClient.del(key);
    } catch (err) {
      console.warn('[Redis] Erro ao limpar vision_pendente:', err.message);
    }
  }
}

async function salvarPedidoAguardandoPesagem(codigoPedido, dadosPedido) {
  if (!codigoPedido || !dadosPedido) return;
  const codigoLimpo = String(codigoPedido).replace(/^PED-/i, '').trim();
  const key = `pedido_ativo:${codigoLimpo}`;

  memPedidosAtivos.set(key, {
    dados: dadosPedido,
    expiraEm: Date.now() + TTL_PEDIDO_ATIVO_SEG * 1000,
  });
  memPedidosAtivos.set('pedido_ativo:ULTIMO', {
    dados: dadosPedido,
    expiraEm: Date.now() + TTL_PEDIDO_ATIVO_SEG * 1000,
  });

  if (isRedisConectado()) {
    try {
      const str = JSON.stringify(dadosPedido);
      await redisClient.set(key, str, 'EX', TTL_PEDIDO_ATIVO_SEG);
      await redisClient.set('pedido_ativo:ULTIMO', str, 'EX', TTL_PEDIDO_ATIVO_SEG);
    } catch (err) {
      console.warn('[Redis] Erro ao salvar pedido_ativo:', err.message);
    }
  }
}

async function buscarPedidoAguardandoPesagem(codigoPedido = null) {
  const codigoLimpo = codigoPedido ? String(codigoPedido).replace(/^PED-/i, '').trim() : 'ULTIMO';
  const key = `pedido_ativo:${codigoLimpo}`;

  if (isRedisConectado()) {
    try {
      const raw = await redisClient.get(key);
      if (raw) return JSON.parse(raw);
    } catch (err) {
      console.warn('[Redis] Erro ao buscar pedido_ativo:', err.message);
    }
  }

  const local = memPedidosAtivos.get(key);
  if (local && local.expiraEm > Date.now()) return local.dados;
  return null;
}

async function salvarMapeamentoLid(lidKey, telefoneReal) {
  if (!lidKey || !telefoneReal) return;
  const key = `lid_map:${lidKey}`;
  memLidMap.set(key, telefoneReal);

  if (isRedisConectado()) {
    try {
      await redisClient.set(key, telefoneReal, 'EX', TTL_LID_MAP_SEG);
    } catch (err) {
      console.warn('[Redis] Erro ao salvar mapeamento @lid:', err.message);
    }
  }
}

async function obterTelefonePorLid(lidKey) {
  if (!lidKey) return null;
  const key = `lid_map:${lidKey}`;

  if (isRedisConectado()) {
    try {
      const tel = await redisClient.get(key);
      if (tel) return tel;
    } catch (err) {
      console.warn('[Redis] Erro ao buscar mapeamento @lid:', err.message);
    }
  }
  return memLidMap.get(key) || null;
}


let memPausaGlobal = true; // Padrão de segurança: inicia pausado até liberação explícita

async function definirPausaGlobal(pausado) {
  memPausaGlobal = Boolean(pausado);
  const valor = memPausaGlobal ? '1' : '0';
  if (isRedisConectado()) {
    try {
      await redisClient.set('config:automacao_pausada_global', valor);
    } catch (err) {
      console.warn('[Redis] Erro ao salvar pausa global:', err.message);
    }
  }
  return memPausaGlobal;
}

async function obterPausaGlobal() {
  if (process.env.AUTOMACOES_PAUSADAS === 'true') return true;
  if (isRedisConectado()) {
    try {
      const val = await redisClient.get('config:automacao_pausada_global');
      if (val === '0') {
        memPausaGlobal = false;
        return false;
      }
      if (val === '1') {
        memPausaGlobal = true;
        return true;
      }
    } catch (err) {
      console.warn('[Redis] Erro ao ler pausa global:', err.message);
    }
  }
  return memPausaGlobal;
}

module.exports = {
  definirPausaGlobal,
  obterPausaGlobal,
  isRedisConectado,
  criarSessaoVazia,
  adquirirLock,
  liberarLock,
  obterSessao,
  salvarSessao,
  limparSessao,
  adicionarBufferMensagem,
  consumirBufferMensagens,
  ativarPausa,
  estaEmPausa,
  removerPausa,
  verificarEDeduplicarMensagem,
  adicionarFalta,
  removerFalta,
  listarFaltas,
  salvarPrecoOverride,
  listarPrecosOverride,
  salvarVisionPendente,
  obterVisionPendente,
  limparVisionPendente,
  salvarPedidoAguardandoPesagem,
  buscarPedidoAguardandoPesagem,
  salvarMapeamentoLid,
  obterTelefonePorLid,
  isNumeroTestador,
};
