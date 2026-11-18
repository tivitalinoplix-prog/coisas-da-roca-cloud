const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL || '';

const TTL_SESSAO_SEG = 24 * 60 * 60; // 24 horas
const TTL_BUFFER_SEG = 60; // 60 segundos
const TTL_PAUSA_PADRAO_SEG = Number(process.env.PAUSA_HUMANA_MINUTOS || 30) * 60; // 30 minutos
const TTL_DEDUP_SEG = 5 * 60; // 5 minutos
const TTL_FALTAS_SEG = 24 * 60 * 60; // 24 horas
const TTL_LID_MAP_SEG = 30 * 24 * 60 * 60; // 30 dias

let redisClient = null;
let redisConectado = false;

// Fallback em memória caso REDIS_URL ainda não esteja configurada ou oscile
const memSessoes = new Map();
const memBuffers = new Map();
const memPausas = new Map();
const memDedup = new Map();
const memFaltas = new Set();
const memLidMap = new Map();

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

async function ativarPausa(chave, segundos = TTL_PAUSA_PADRAO_SEG) {
  if (!chave) return;
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
  if (!chave) return false;
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

async function verificarEDeduplicarMensagem(messageId) {
  if (!messageId) return false;
  const key = `dedup:${messageId}`;

  if (isRedisConectado()) {
    try {
      const res = await redisClient.set(key, '1', 'EX', TTL_DEDUP_SEG, 'NX');
      return res === null; // true se já existia
    } catch (err) {
      console.warn('[Redis] Erro na deduplicação:', err.message);
    }
  }

  const agora = Date.now();
  const exp = memDedup.get(key);
  if (exp && exp > agora) return true;
  memDedup.set(key, agora + TTL_DEDUP_SEG * 1000);
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
    if (x.toLowerCase() === alvo) memFaltas.delete(x);
  }

  if (isRedisConectado()) {
    try {
      const atuais = await redisClient.smembers('faltas_balcao');
      for (const x of atuais) {
        if (String(x).toLowerCase() === alvo) {
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

module.exports = {
  isRedisConectado,
  criarSessaoVazia,
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
  salvarMapeamentoLid,
  obterTelefonePorLid,
};
