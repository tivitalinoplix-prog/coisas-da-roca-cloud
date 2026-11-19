const fs = require('fs');
const path = require('path');

let cacheCatalogo = null;
let cacheMtimeMs = 0;
let cacheCaminho = '';

let cacheEmFalta = { itens: new Set(), mtimeMs: 0 };

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

function carregarCatalogo(forcarRecarga = false) {
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
          categoria: String(item.categoria || item.CATEGORIA || item.grupo || item.GRUPO || '').trim(),
          estoque: item.estoque !== undefined ? Number(item.estoque) : null,
        }));

        cacheMtimeMs = stats.mtimeMs;
        cacheCaminho = caminho;
        return cacheCatalogo;
      } catch (err) {
        console.error(`[produtosService] Falha ao ler catálogo ${caminho}:`, err.message);
      }
    }
  }

  console.warn('[produtosService] Nenhum arquivo de catálogo SGM encontrado.');
  return [];
}

const SINONIMOS_ACOUGUE = {
  cha: ['coxao mole', 'coxao duro'],
  coxao: ['coxao mole', 'coxao duro'],
  contra: ['contra file', 'contrafile'],
  contrafile: ['contra file'],
  tulipa: ['meio da asa'],
  drumet: ['coxinha da asa', 'drumet'],
  toscana: ['linguica toscana'],
  carvao: ['carvao vegetal'],
  alho: ['pao de alho', 'pasta de alho'],
  moida: ['carne moida', 'acem', 'patinho', 'musculo'],
  moido: ['carne moida', 'acem', 'patinho', 'musculo'],
  refri: ['refrigerante', 'coca cola', 'guarana'],
  coca: ['coca cola'],
};

const STOPWORDS = new Set([
  'oi', 'ola', 'opa', 'bom', 'dia', 'boa', 'tarde', 'noite', 'tudo', 'bem',
  'quero', 'queria', 'gostaria', 'preciso', 'manda', 'mandar', 'pode', 'ver', 've',
  'tem', 'voces', 'ai', 'por', 'favor', 'pfv', 'me', 'uma', 'um', 'uns', 'umas',
  'de', 'da', 'do', 'das', 'dos', 'para', 'pra', 'pro', 'com', 'sem', 'mais', 'menos',
  'outro', 'outra', 'tambem', 'ja', 'agora', 'hoje', 'amanha', 'quanto', 'custa', 'valor',
  'preco', 'kg', 'kilo', 'kilos', 'quilo', 'quilos', 'grama', 'gramas', 'gr',
  'unidade', 'unidades', 'un', 'pct', 'pacote', 'bandeja', 'caixa', 'litro', 'litros',
  'corta', 'cortado', 'cortada', 'inteiro', 'inteira', 'limpo', 'limpa',
  'bife', 'bifes', 'cubos', 'pedacos', 'churrasco', 'panela', 'picado', 'picada',
  'rua', 'avenida', 'av', 'numero', 'casa', 'apto', 'apartamento', 'bloco', 'bairro',
  'pix', 'cartao', 'dinheiro', 'credito', 'debito', 'troco', 'entrega', 'retirar',
  'ok', 'certo', 'fechado', 'isso', 'mesmo', 'fechar', 'confirmado', 'obrigado', 'obrigada',
  'valeu', 'show', 'beleza', 'perfeito', 'sim', 'nao', 'tira', 'tirar', 'coloca', 'colocar',
  'audio', 'cliente', 'pedido', 'resumo', 'total', 'subtotal', 'estimado', 'aproximado',
  'balanca', 'cupom', 'separar', 'anotei', 'anotado', 'mantemos', 'pagamento', 'endereco',
]);

function extrairTermosDeBusca(texto = '') {
  const limpo = normalizarTexto(texto);
  const rawTokens = limpo.split(' ').filter((t) => t.length >= 2 && !/^\d+$/.test(t));

  const bigramas = [];
  const unigramas = [];
  const extras = [];

  for (let i = 0; i < rawTokens.length; i++) {
    const t1 = singularizarToken(rawTokens[i]);

    if (i < rawTokens.length - 1) {
      const t2 = singularizarToken(rawTokens[i + 1]);
      if (!STOPWORDS.has(t1) && !STOPWORDS.has(t2) && t1.length >= 2 && t2.length >= 2) {
        const bigrama = `${t1} ${t2}`;
        if (bigrama.length >= 5) {
          bigramas.push(bigrama);
        }
      }
    }

    if (t1.length >= 3 && !STOPWORDS.has(t1)) {
      unigramas.push(t1);
      if (SINONIMOS_ACOUGUE[t1]) {
        for (const sin of SINONIMOS_ACOUGUE[t1]) {
          extras.push(normalizarTexto(sin));
        }
      }
    }
  }

  return Array.from(new Set([...bigramas, ...unigramas, ...extras]));
}

function pontuarProduto(produto, termoNorm) {
  if (!produto || !produto.nome || produto.preco <= 0) return 0;

  const nomeNorm = normalizarTexto(produto.nome);
  const catNorm = normalizarTexto(produto.categoria);

  let score = 0;

  if (nomeNorm === termoNorm) {
    score += 180;
  } else if (nomeNorm.includes(termoNorm)) {
    score += 110;
    if (nomeNorm.startsWith(termoNorm)) {
      score += 30;
    }
  }

  const palavrasTermo = termoNorm.split(' ').filter((p) => p.length >= 3);
  let hits = 0;

  for (const palavra of palavrasTermo) {
    const regexPalavra = new RegExp(`\\b${palavra}`);
    if (regexPalavra.test(nomeNorm)) {
      hits += 1;
      score += 40;
    } else if (nomeNorm.includes(palavra)) {
      hits += 1;
      score += 28;
    } else if (catNorm.includes(palavra)) {
      score += 10;
    }
  }

  if (palavrasTermo.length > 1 && hits === palavrasTermo.length) {
    score += 55;
  }

  return score;
}

function coletarCandidatosPorTermos(catalogo, termos, limiteSlots, mapaDestino) {
  if (!termos.length || limiteSlots <= 0) return;

  const slotsPorTermo = Math.max(2, Math.floor(limiteSlots / Math.min(termos.length, 5)));

  for (const termo of termos) {
    if (mapaDestino.size >= 22) break;

    const candidatos = catalogo
      .map((prod) => ({ prod, score: pontuarProduto(prod, termo) }))
      .filter((x) => x.score >= 35)
      .sort((a, b) => b.score - a.score)
      .slice(0, slotsPorTermo);

    for (const { prod } of candidatos) {
      const chave = prod.codigo || prod.nome;
      if (!mapaDestino.has(chave)) {
        mapaDestino.set(chave, prod);
      }
    }
  }
}

function buscarProdutosRelevantes(mensagemAtual = '', historicoConversa = []) {
  const catalogo = carregarCatalogo();
  if (!catalogo.length) return [];

  const termosAtuais = extrairTermosDeBusca(mensagemAtual);

  const textosHistorico = [];
  if (Array.isArray(historicoConversa)) {
    for (const msg of historicoConversa.slice(-14)) {
      const txt = msg?.content || msg?.texto || msg?.body || '';
      if (txt) textosHistorico.push(txt);
    }
  }
  const termosHistorico = extrairTermosDeBusca(textosHistorico.join(' ')).filter(
    (t) => !termosAtuais.includes(t)
  );

  const mapaSelecionados = new Map();

  coletarCandidatosPorTermos(catalogo, termosAtuais, 12, mapaSelecionados);
  coletarCandidatosPorTermos(catalogo, termosHistorico, 10, mapaSelecionados);

  return Array.from(mapaSelecionados.values()).slice(0, 22);
}

function formatarCatalogoParaPrompt(produtos = []) {
  if (!produtos || produtos.length === 0) {
    return 'NENHUM PRODUTO DO CATÁLOGO SGM CORRESPONDEU EXATAMENTE AOS TERMOS DESTA MENSAGEM.';
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
  const lista = carregarCatalogo(true);
  return { ok: true, totalProdutos: lista.length };
}async function atualizarCatalogoSgm(produtos = []) {
  const listaNormalizada = (Array.isArray(produtos) ? produtos : [])
    .filter((item) => item && (item.codigo !== undefined || item.nome))
    .map((item) => {
      const precoNum = Number(String(item.preco ?? item.valor ?? 0).replace(',', '.'));
      return {
        codigo: String(item.codigo ?? '').trim(),
        nome: String(item.nome ?? item.descricao ?? '').trim(),
        preco: Number.isFinite(precoNum) ? precoNum : 0,
        unidade: String(item.unidade ?? 'KG').trim().toUpperCase() || 'KG',
        categoria: item.categoria ? String(item.categoria).trim() : null,
        ativo: item.ativo !== false,
      };
    });

  try {
    const dataDir = path.join(__dirname, '..', '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'produtos.json'), JSON.stringify(listaNormalizada, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[produtosService] Falha ao salvar snapshot data/produtos.json:', err.message);
  }

  cacheCatalogo = null;

  let dbUpserted = 0;
  try {
    let db = null;
    for (const p of ['../database', '../config/db', '../db', '../database/db', '../config/database']) {
      try { db = require(p); break; } catch (_) {}
    }
    if (db && db.pool && listaNormalizada.length > 0) {
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        const chunkSize = 200;
        for (let i = 0; i < listaNormalizada.length; i += chunkSize) {
          const lote = listaNormalizada.slice(i, i + chunkSize);
          const valores = [];
          const placeholders = lote.map((prod, idx) => {
            const base = idx * 6;
            valores.push(prod.codigo, prod.nome, prod.preco, prod.unidade, prod.categoria, prod.ativo);
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
          });
          await client.query(
            `INSERT INTO produtos (codigo, nome, preco, unidade, categoria, ativo) VALUES ${placeholders.join(', ')} ON CONFLICT (codigo) DO UPDATE SET nome = EXCLUDED.nome, preco = EXCLUDED.preco, unidade = EXCLUDED.unidade, categoria = EXCLUDED.categoria, ativo = EXCLUDED.ativo`,
            valores
          );
          dbUpserted += lote.length;
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }
  } catch (err) {
    console.warn('[produtosService] Falha ao fazer upsert no banco (nao fatal):', err.message);
  }

  return { ok: true, totalProdutos: listaNormalizada.length, dbUpserted };
}



module.exports = {
  normalizarTexto,
  carregarCatalogo,
  carregarProdutosEmFalta,
  extrairTermosDeBusca,
  buscarProdutosRelevantes,
  formatarCatalogoParaPrompt,
  sincronizarSgmComSupabase,
  atualizarCatalogoSgm,
};
