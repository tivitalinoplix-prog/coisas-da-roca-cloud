const fs = require('fs');
const path = require('path');

let cacheCatalogo = null;
let cacheMtimeMs = 0;
let cacheCaminho = '';
let ultimaLeituraDb = 0;
const TTL_CACHE_DB_MS = 5 * 60 * 1000; // 5 minutos

let cacheEmFalta = { itens: new Set(), mtimeMs: 0 };

let dbPool = null;
try {
  const db = require('../database');
  dbPool = db.pool;
} catch (_) {}

function normalizarTexto(texto = '') {
  return String(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function singularizarToken(token = '') {
  if (!token || token.length < 4) return token;
  if (token.endsWith('oes')) return `${token.slice(0, -3)}ao`;
  if (token.endsWith('aes')) return `${token.slice(0, -3)}ao`;
  if (token.endsWith('eis')) return `${token.slice(0, -3)}el`;
  if (token.endsWith('is') && token.length > 4) return `${token.slice(0, -2)}l`;
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function carregarProdutosEmFalta() {
  const caminhos = [
    path.join(__dirname, '..', '..', 'config', 'produtos_em_falta.json'),
    path.join(__dirname, '..', '..', '..', 'config', 'produtos_em_falta.json'),
  ];

  for (const caminho of caminhos) {
    if (fs.existsSync(caminho)) {
      try {
        const stats = fs.statSync(caminho);
        if (stats.mtimeMs === cacheEmFalta.mtimeMs) {
          return cacheEmFalta.itens;
        }
        const parsed = JSON.parse(fs.readFileSync(caminho, 'utf-8'));
        const lista = Array.isArray(parsed?.itens) ? parsed.itens : [];
        cacheEmFalta = {
          itens: new Set(lista.map((x) => normalizarTexto(x)).filter(Boolean)),
          mtimeMs: stats.mtimeMs,
        };
        return cacheEmFalta.itens;
      } catch (err) {
        console.warn('[produtosService] Falha ao ler produtos_em_falta.json:', err.message);
      }
    }
  }

  return new Set();
}

async function carregarCatalogoDbAsync(forcar = false) {
  const agora = Date.now();
  if (!forcar && cacheCatalogo && cacheCatalogo.length > 0 && agora - ultimaLeituraDb < TTL_CACHE_DB_MS) {
    return cacheCatalogo;
  }

  if (dbPool) {
    try {
      const res = await dbPool.query(`
        SELECT 
          COALESCE(codigo_aux, id_sgm::text) AS codigo,
          descricao,
          CASE 
            WHEN preco_promocao > 0 THEN preco_promocao 
            ELSE preco 
          END AS preco,
          CASE 
            WHEN balanca = true THEN 'KG' 
            ELSE 'UN' 
          END AS unidade,
          balanca,
          ativo
        FROM produtos
        WHERE ativo = true AND (preco > 0 OR preco_promocao > 0)
        ORDER BY descricao ASC
      `);

      if (res.rows && res.rows.length > 0) {
        cacheCatalogo = res.rows.map((r, idx) => ({
          id: r.codigo || `SGM-${idx + 1}`,
          codigo: String(r.codigo).trim(),
          nome: String(r.descricao).trim(),
          preco: Number(r.preco || 0),
          unidade: String(r.unidade || 'KG').toUpperCase(),
          balanca: Boolean(r.balanca),
          ativo: Boolean(r.ativo)
        }));
        ultimaLeituraDb = agora;
        console.log(`[produtosService] ✅ Catálogo vivo carregado do Supabase: ${cacheCatalogo.length} itens.`);
        return cacheCatalogo;
      }
    } catch (err) {
      console.warn('[produtosService] Falha ao consultar Supabase direto, recorrendo a arquivos locais:', err.message);
    }
  }

  return null;
}

function carregarCatalogo(forcarRecarga = false) {
  const agora = Date.now();
  if (!forcarRecarga && cacheCatalogo && cacheCatalogo.length > 0 && agora - ultimaLeituraDb < TTL_CACHE_DB_MS) {
    return cacheCatalogo;
  }

  if (dbPool) {
    carregarCatalogoDbAsync(forcarRecarga).catch(() => {});
  }

  if (cacheCatalogo && cacheCatalogo.length > 0 && !forcarRecarga) {
    return cacheCatalogo;
  }

  const caminhos = [
    path.join(__dirname, '..', 'data', 'produtos.json'),
    path.join(__dirname, '..', 'data', 'produtos_sgm.json'),
    path.join(__dirname, '..', '..', 'data', 'produtos.json'),
    path.join(__dirname, '..', '..', 'data', 'produtos_sgm.json'),
  ];

  for (const caminho of caminhos) {
    if (fs.existsSync(caminho)) {
      try {
        const stats = fs.statSync(caminho);
        if (!forcarRecarga && cacheCatalogo && stats.mtimeMs === cacheMtimeMs && cacheCaminho === caminho) {
          return cacheCatalogo;
        }

        const conteudo = fs.readFileSync(caminho, 'utf-8');
        const parsed = JSON.parse(conteudo);
        const lista = Array.isArray(parsed)
          ? parsed
          : parsed.produtos || parsed.itens || parsed.data || [];

        cacheCatalogo = lista.map((item, idx) => ({
          id: item.id || item.codigo || item.CODIGO || item.cod || `SGM-${idx + 1}`,
          codigo: String(item.codigo || item.CODIGO || item.cod || item.id || '').trim(),
          nome: String(
            item.descricao || item.DESCRICAO || item.nome || item.NOME || item.produto || ''
          ).trim(),
          preco: Number(
            item.preco || item.PRECO || item.preco_venda || item.PRECO_VENDA || item.valor || 0
          ),
          unidade: String(item.unidade || item.UNIDADE || item.un || item.UN || 'KG')
            .trim()
            .toUpperCase(),
          estoque: item.estoque !== undefined ? Number(item.estoque) : null,
          balanca: item.balanca === true || String(item.unidade || '').toUpperCase() === 'KG',
        }));

        cacheMtimeMs = stats.mtimeMs;
        cacheCaminho = caminho;
        return cacheCatalogo;
      } catch (err) {
        console.error(`[produtosService] Falha ao ler catálogo ${caminho}:`, err.message);
      }
    }
  }

  return [];
}

const SINONIMOS_ACOUGUE = {
  moida: ['patinho kg', 'acem bovino kg', 'carne moida'],
  moido: ['patinho kg', 'acem bovino kg', 'carne moida'],
  cha: ['cha bovino kg', 'coxao mole kg'],
  tiras: ['cha bovino kg', 'alcatra kg'],
  rocambole: ['rocambole de frango', 'rocambole'],
  sobrecoxa: ['coxa c/sobrecoxa granel kg', 'sobrecoxa'],
  coxa: ['coxa c/sobrecoxa granel kg', 'coxa'],
  toscana: ['linguica toscana p/churrasco kg', 'linguica toscana'],
  contra: ['contra file kg', 'contrafile'],
  contrafile: ['contra file kg'],
  tulipa: ['meio da asa kg'],
  drumet: ['coxinha da asa kg', 'drumet'],
  batata: ['batata inglesa kg'],
  cebola: ['cebola kg'],
  tomate: ['tomate kg'],
  farinha: ['farinha de mandioca', 'farinha de trigo'],
  mandioca: ['farinha de mandioca'],
  trigo: ['farinha de trigo'],
  oleo: ['oleo de soja'],
  azeitona: ['azeitona'],
  colorau: ['colorau da roca', 'colorifico'],
  creme: ['creme de cebola'],
  pimenta: ['pimenta do reino moida', 'pimenta do reino'],
  vinho: ['vinho tinto seco', 'vinho'],
  cha_bebida: ['cha leao', 'cha mate', 'cha'],
  refri: ['refrigerante', 'coca cola', 'guarana'],
  coca: ['coca cola'],
};

const STOPWORDS = new Set([
  'oi', 'ola', 'opa', 'bom', 'dia', 'boa', 'tarde', 'noite', 'tudo', 'bem',
  'quero', 'queria', 'gostaria', 'preciso', 'manda', 'mandar', 'pode', 'ver', 've',
  'tem', 'voces', 'ai', 'por', 'favor', 'pfv', 'me', 'uma', 'um', 'uns', 'umas',
  'de', 'da', 'do', 'das', 'dos', 'para', 'pra', 'pro', 'com', 'sem', 'mais', 'menos',
  'outro', 'outra', 'tambem', 'ja', 'agora', 'hoje', 'amanha', 'quanto', 'custa', 'valor',
  'preco', 'kg', 'kilo', 'kilos', 'quilo', 'quilos', 'grama', 'gramas', 'gr', 'g',
  'unidade', 'unidades', 'un', 'pct', 'pacote', 'bandeja', 'caixa', 'litro', 'litros',
  'sache', 'caixinha', 'caixinhas', 'dentro', 'diversos', 'segue', 'pedido', 'igreja',
  'corta', 'cortado', 'cortada', 'inteiro', 'inteira', 'limpo', 'limpa',
  'bife', 'bifes', 'cubos', 'pedacos', 'churrasco', 'panela', 'picado', 'picada',
  'rua', 'avenida', 'av', 'numero', 'casa', 'apto', 'apartamento', 'bloco', 'bairro',
  'pix', 'cartao', 'dinheiro', 'credito', 'debito', 'troco', 'entrega', 'retirar',
  'ok', 'certo', 'fechado', 'isso', 'mesmo', 'fechar', 'confirmado', 'obrigado', 'obrigada',
  'valeu', 'show', 'beleza', 'perfeito', 'sim', 'nao', 'tira', 'tirar', 'coloca', 'colocar',
  'audio', 'cliente', 'pedido', 'resumo', 'total', 'subtotal', 'estimado', 'aproximado',
  'balanca', 'cupom', 'separar', 'anotei', 'anotado', 'mantemos', 'pagamento', 'endereco',
]);

function pontuarProduto(produto, termoNorm, linhaOriginal = '') {
  const nomeNorm = normalizarTexto(produto.nome || produto.descricao || '');
  if (!nomeNorm || produto.preco <= 0) return 0;

  let score = 0;
  if (nomeNorm === termoNorm) score += 250;
  else if (nomeNorm.startsWith(termoNorm)) score += 180;
  else if (nomeNorm.includes(termoNorm)) score += 120;

  const tokens = termoNorm.split(' ');
  let hits = 0;
  for (const t of tokens) {
    if (t.length >= 3 && nomeNorm.includes(t)) {
      score += 35;
      hits++;
    }
  }
  if (tokens.length > 1 && hits === tokens.length) {
    score += 60;
  }

  const linhaPedeKg = /\b(kg|kilo|quilo)\b/i.test(linhaOriginal);
  if (linhaPedeKg && produto.balanca) {
    score += 40;
  }

  return score;
}

function buscarProdutosRelevantes(mensagemAtual = '', historicoConversa = []) {
  const catalogo = carregarCatalogo();
  if (!catalogo.length) return [];

  const textos = [];
  if (mensagemAtual) textos.push(mensagemAtual);

  if (Array.isArray(historicoConversa)) {
    for (const msg of historicoConversa.slice(-6)) {
      const txt = msg?.content || msg?.texto || msg?.body || '';
      if (txt) textos.push(txt);
    }
  }

  const textoTotal = textos.join('\n');
  const linhas = textoTotal.split('\n').map((l) => l.trim()).filter((l) => l.length > 2);

  const MAX_PRODUTOS = 65;
  const mapa = new Map();

  for (const linha of linhas) {
    const lNorm = normalizarTexto(linha);
    const tokens = lNorm.split(' ').map((t) => singularizarToken(t)).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
    if (!tokens.length) continue;

    const termosDaLinha = [tokens.join(' ')];
    for (const t of tokens) {
      termosDaLinha.push(t);
      if (SINONIMOS_ACOUGUE[t]) termosDaLinha.push(...SINONIMOS_ACOUGUE[t]);
    }

    const candidatosLinha = [];
    for (const termo of termosDaLinha) {
      const top = catalogo
        .map((p) => ({ p, score: pontuarProduto(p, termo, linha) }))
        .filter((x) => x.score >= 50)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      candidatosLinha.push(...top);
    }
    candidatosLinha.sort((a, b) => b.score - a.score);

    for (const c of candidatosLinha.slice(0, 4)) {
      const chave = String(c.p.codigo || c.p.nome).trim();
      if (!mapa.has(chave) && mapa.size < MAX_PRODUTOS) {
        mapa.set(chave, c.p);
      }
    }
  }

  if (mapa.size < MAX_PRODUTOS) {
    const limpo = normalizarTexto(textoTotal);
    const rawTokens = limpo.split(' ').filter((t) => t.length >= 3 && !STOPWORDS.has(t));
    for (const tok of rawTokens) {
      if (mapa.size >= MAX_PRODUTOS) break;
      const top = catalogo
        .map((p) => ({ p, score: pontuarProduto(p, tok, textoTotal) }))
        .filter((x) => x.score >= 60)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2);

      for (const c of top) {
        const chave = String(c.p.codigo || c.p.nome).trim();
        if (!mapa.has(chave) && mapa.size < MAX_PRODUTOS) {
          mapa.set(chave, c.p);
        }
      }
    }
  }

  return Array.from(mapa.values());
}

function formatarCatalogoParaPrompt(produtos = []) {
  if (!produtos || produtos.length === 0) {
    return 'NENHUM PRODUTO DO CATÁLOGO SGM CORRESPONDEU AOS TERMOS DESTA MENSAGEM.';
  }

  const emFalta = carregarProdutosEmFalta();

  return produtos
    .map((p) => {
      const precoStr = Number(p.preco).toFixed(2).replace('.', ',');
      const un = p.unidade === 'UN' || p.unidade === 'PCT' || p.unidade === 'CX' ? p.unidade : 'KG';
      const nomeNorm = normalizarTexto(p.nome);
      const emFaltaHoje = Array.from(emFalta).some((itemFalta) => nomeNorm.includes(itemFalta));
      const tagFalta = emFaltaHoje ? ' [AVISO: ITEM EM FALTA NO BALCÃO HOJE]' : '';
      return `• [Cód ${p.codigo}] ${p.nome} — R$ ${precoStr} / ${un}${tagFalta}`;
    })
    .join('\n');
}

async function sincronizarSgmComSupabase() {
  const lista = await carregarCatalogoDbAsync(true);
  return { ok: true, totalProdutos: lista ? lista.length : 0 };
}

async function atualizarCatalogoSgm(produtos = []) {
  if (!Array.isArray(produtos) || produtos.length === 0) {
    return { ok: false, motivo: 'Nenhum produto fornecido' };
  }

  const produtosFormatados = produtos.map((p, idx) => ({
    id_sgm: parseInt(p.id_sgm || p.id || p.IDPRODUTO || idx + 1, 10),
    descricao: String(p.descricao || p.nome || p.DESCRICAOPRODUTO || '').trim(),
    preco: parseFloat(p.preco || p.preco_venda || p.PRECOGONDOLA || p.PRECOAVISTA || 0),
    preco_promocao: parseFloat(p.preco_promocao || p.PRECOPROMOCAO || 0),
    balanca: p.balanca === true || p.BALANCA === 'S' || p.balanca === 'true' || p.balanca === 1,
    codigo_aux: String(p.codigo_aux || p.CODIGOAUX || p.codigo || '').trim() || null,
    ean: String(p.ean || p.EAN || '').trim() || null,
    ativo: p.ativo !== false && p.ATIVO !== 'N',
  })).filter((p) => p.descricao && (p.preco > 0 || p.preco_promocao > 0));

  let atualizadosDb = 0;
  if (dbPool) {
    try {
      const BATCH_SIZE = 100;
      for (let i = 0; i < produtosFormatados.length; i += BATCH_SIZE) {
        const lote = produtosFormatados.slice(i, i + BATCH_SIZE);
        const values = [];
        const placeholders = [];

        lote.forEach((p, idx) => {
          const offset = idx * 8;
          placeholders.push(
            `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, NOW())`
          );
          values.push(
            p.id_sgm,
            p.descricao,
            p.preco,
            p.preco_promocao,
            p.balanca,
            p.codigo_aux,
            p.ean,
            p.ativo
          );
        });

        const query = `
          INSERT INTO produtos (id_sgm, descricao, preco, preco_promocao, balanca, codigo_aux, ean, ativo, atualizado_em)
          VALUES ${placeholders.join(', ')}
          ON CONFLICT (id_sgm) DO UPDATE SET
            descricao = EXCLUDED.descricao,
            preco = EXCLUDED.preco,
            preco_promocao = EXCLUDED.preco_promocao,
            balanca = EXCLUDED.balanca,
            codigo_aux = EXCLUDED.codigo_aux,
            ean = EXCLUDED.ean,
            ativo = EXCLUDED.ativo,
            atualizado_em = NOW();
        `;
        await dbPool.query(query, values);
        atualizadosDb += lote.length;
      }
      console.log(`[produtosService] ${atualizadosDb} produtos sincronizados com sucesso no Supabase.`);
    } catch (err) {
      console.error('[produtosService] Erro ao sincronizar produtos no Supabase:', err.message);
    }
  }

  try {
    const listaJson = produtosFormatados.map((p) => ({
      id: p.id_sgm,
      codigo: p.codigo_aux || String(p.id_sgm),
      descricao: p.descricao,
      preco: p.preco_promocao > 0 ? p.preco_promocao : p.preco,
      unidade: p.balanca ? 'KG' : 'UN',
      ativo: p.ativo,
      atualizado_em: new Date().toISOString(),
    }));

    const caminhosParaSalvar = [
      path.join(__dirname, '..', 'data', 'produtos.json'),
      path.join(__dirname, '..', 'data', 'produtos_sgm.json'),
      path.join(__dirname, '..', '..', 'data', 'produtos.json'),
      path.join(__dirname, '..', '..', 'data', 'produtos_sgm.json'),
    ];

    for (const cp of caminhosParaSalvar) {
      const dir = path.dirname(cp);
      if (fs.existsSync(dir)) {
        fs.writeFileSync(cp, JSON.stringify(listaJson, null, 2), 'utf-8');
      }
    }
    cacheCatalogo = null;
    cacheMtimeMs = 0;
  } catch (err) {
    console.warn('[produtosService] Falha ao persistir produtos.json local:', err.message);
  }

  return { ok: true, totalRecebidos: produtos.length, atualizadosDb, timestamp: new Date().toISOString() };
}

if (dbPool) {
  carregarCatalogoDbAsync().catch(() => {});
}

module.exports = {
  normalizarTexto,
  carregarCatalogo,
  carregarProdutosEmFalta,
  buscarProdutosRelevantes,
  formatarCatalogoParaPrompt,
  sincronizarSgmComSupabase,
  atualizarCatalogoSgm,
};
