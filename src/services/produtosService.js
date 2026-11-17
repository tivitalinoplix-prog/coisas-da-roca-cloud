const fs = require('fs');
const path = require('path');

let cacheCatalogo = null;
let cacheMtimeMs = 0;

/**
 * Remove acentos, caracteres especiais e padroniza espaços.
 */
function normalizarTexto(texto = '') {
  return String(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Carrega o catálogo do ERP SGM com cache inteligente baseado na data de modificação do arquivo.
 * Prioriza src/data/produtos.json e faz fallback para src/data/produtos_sgm.json.
 */
function carregarCatalogo() {
  const caminhos = [
    path.join(__dirname, '..', 'data', 'produtos.json'),
    path.join(__dirname, '..', 'data', 'produtos_sgm.json'),
  ];

  for (const caminho of caminhos) {
    if (fs.existsSync(caminho)) {
      try {
        const stats = fs.statSync(caminho);
        if (cacheCatalogo && stats.mtimeMs === cacheMtimeMs) {
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
        return cacheCatalogo;
      } catch (err) {
        console.error(`[produtosService] Falha ao ler catálogo ${caminho}:`, err.message);
      }
    }
  }

  console.warn('[produtosService] Nenhum arquivo de catálogo SGM encontrado em src/data/.');
  return [];
}

/**
 * Sinônimos regionais de açougue e mercearia (Macaé/RJ) para expandir buscas naturais.
 */
const SINONIMOS_ACOUGUE = {
  cha: ['chã', 'coxao'],
  coxao: ['coxao mole', 'coxao duro', 'cha de dentro', 'cha de fora'],
  contra: ['contra file', 'contrafile'],
  file: ['file mignon', 'contra file', 'peito frango'],
  meio: ['meio da asa', 'tulipa'],
  tulipa: ['meio da asa', 'tulipa'],
  drumet: ['coxinha da asa', 'drumet'],
  coxinha: ['coxinha da asa', 'drumet'],
  linguica: ['linguica toscana', 'linguica frango', 'linguica pernil', 'linguica calabresa'],
  toscana: ['linguica toscana'],
  carvao: ['carvao vegetal'],
  pao: ['pao de alho'],
  alho: ['pao de alho', 'pasta de alho'],
  moida: ['carne moida', 'acem', 'patinho', 'musculo'],
};

/**
 * Extrai termos e bigramas relevantes do texto do cliente, descartando ruído conversacional.
 */
function extrairTermosDeBusca(texto = '') {
  const stopwords = new Set([
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
    'valeu', 'show', 'beleza', 'perfeito', 'sim', 'nao', 'tira', 'tirar', 'coloca', 'colocar'
  ]);

  const limpo = normalizarTexto(texto);
  const tokens = limpo.split(' ').filter((t) => t.length >= 2 && !/^\d+$/.test(t));

  const termos = new Set();

  for (let i = 0; i < tokens.length; i++) {
    const t1 = tokens[i];
    if (t1.length >= 3 && !stopwords.has(t1)) {
      termos.add(t1);
      if (SINONIMOS_ACOUGUE[t1]) {
        for (const sin of SINONIMOS_ACOUGUE[t1]) {
          termos.add(normalizarTexto(sin));
        }
      }
    }

    if (i < tokens.length - 1) {
      const t2 = tokens[i + 1];
      if ((!stopwords.has(t1) || !stopwords.has(t2)) && t1.length >= 2 && t2.length >= 2) {
        const bigrama = `${t1} ${t2}`;
        if (bigrama.length >= 6) {
          termos.add(bigrama);
        }
      }
    }
  }

  return Array.from(termos);
}

/**
 * Pontua um produto do catálogo SGM contra um termo normalizado.
 */
function pontuarProduto(produto, termoNorm) {
  if (!produto || !produto.nome || produto.preco <= 0) return 0;

  const nomeNorm = normalizarTexto(produto.nome);
  const catNorm = normalizarTexto(produto.categoria);

  let score = 0;

  if (nomeNorm === termoNorm) {
    score += 150;
  } else if (nomeNorm.includes(termoNorm)) {
    score += 100;
    if (nomeNorm.startsWith(termoNorm)) {
      score += 25;
    }
  }

  const palavrasTermo = termoNorm.split(' ').filter((p) => p.length >= 3);
  let hits = 0;

  for (const palavra of palavrasTermo) {
    if (nomeNorm.includes(palavra)) {
      hits += 1;
      score += 35;
    } else if (catNorm.includes(palavra)) {
      score += 10;
    }
  }

  if (palavrasTermo.length > 1 && hits === palavrasTermo.length) {
    score += 45;
  }

  return score;
}

/**
 * Busca produtos relevantes no catálogo SGM distribuindo os slots de forma justa
 * entre TODOS os termos pedidos na conversa (evita que um item expulse outro).
 */
function buscarProdutosRelevantes(mensagemAtual = '', historicoConversa = []) {
  const catalogo = carregarCatalogo();
  if (!catalogo.length) return [];

  const mensagensCliente = [];
  if (Array.isArray(historicoConversa)) {
    for (const msg of historicoConversa.slice(-10)) {
      if (msg && (msg.role === 'user' || msg.remetente === 'cliente' || msg.fromMe === false)) {
        const txt = msg.content || msg.texto || msg.body || '';
        if (txt) mensagensCliente.push(txt);
      }
    }
  }
  if (mensagemAtual) {
    mensagensCliente.push(mensagemAtual);
  }

  const termos = extrairTermosDeBusca(mensagensCliente.join(' '));
  if (!termos.length) return [];

  const LIMITE_TOTAL = 16;
  const slotsPorTermo = Math.max(2, Math.floor(LIMITE_TOTAL / Math.min(termos.length, 6)));
  const mapaSelecionados = new Map();

  for (const termo of termos) {
    const candidatos = catalogo
      .map((prod) => ({ prod, score: pontuarProduto(prod, termo) }))
      .filter((x) => x.score >= 35)
      .sort((a, b) => b.score - a.score)
      .slice(0, slotsPorTermo);

    for (const { prod } of candidatos) {
      const chave = prod.codigo || prod.nome;
      if (!mapaSelecionados.has(chave)) {
        mapaSelecionados.set(chave, prod);
      }
    }
  }

  return Array.from(mapaSelecionados.values()).slice(0, LIMITE_TOTAL);
}

/**
 * Formata os produtos encontrados para injeção limpa e inequívoca no System Prompt.
 */
function formatarCatalogoParaPrompt(produtos = []) {
  if (!produtos || produtos.length === 0) {
    return 'NENHUM PRODUTO DO CATÁLOGO SGM CORRESPONDEU EXATAMENTE AOS TERMOS DESTA MENSAGEM.';
  }

  return produtos
    .map((p) => {
      const precoStr = Number(p.preco).toFixed(2).replace('.', ',');
      const un = p.unidade === 'UN' || p.unidade === 'PCT' || p.unidade === 'CX' ? p.unidade : 'KG';
      return `• [Cód ${p.codigo}] ${p.nome} — R$ ${precoStr} / ${un}`;
    })
    .join('\n');
}

module.exports = {
  normalizarTexto,
  carregarCatalogo,
  extrairTermosDeBusca,
  buscarProdutosRelevantes,
  formatarCatalogoParaPrompt,
};
