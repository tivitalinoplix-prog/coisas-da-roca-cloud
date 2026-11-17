const fs = require('fs');
const path = require('path');

// Cache em memória do catálogo SGM para evitar leitura repetida de disco a cada mensagem
let cacheProdutos = null;
let ultimaLeituraCache = 0;
const TTL_CACHE_MS = 5 * 60 * 1000; // 5 minutos

/**
 * Normaliza texto removendo acentos, pontuações e convertendo para minúsculas.
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
 * Carrega os produtos do catálogo SGM (JSON local ou integrado).
 * Ajuste o caminho caso seu arquivo SGM esteja em outro diretório (ex: data/produtos.json).
 */
function carregarCatalogoSGM() {
  const agora = Date.now();
  if (cacheProdutos && agora - ultimaLeituraCache < TTL_CACHE_MS) {
    return cacheProdutos;
  }

  const caminhosPossiveis = [
    path.join(__dirname, '..', 'data', 'produtos.json'),
    path.join(__dirname, '..', 'data', 'produtos_sgm.json'),
    path.join(__dirname, '..', 'produtos.json'),
    path.join(__dirname, '..', 'produtos_sgm.json'),
  ];

  for (const caminho of caminhosPossiveis) {
    if (fs.existsSync(caminho)) {
      try {
        const bruto = fs.readFileSync(caminho, 'utf-8');
        const dados = JSON.parse(bruto);
        const lista = Array.isArray(dados) ? dados : dados.produtos || dados.itens || [];
        cacheProdutos = lista;
        ultimaLeituraCache = agora;
        return lista;
      } catch (err) {
        console.error(`[produtosService] Erro ao ler catálogo em ${caminho}:`, err.message);
      }
    }
  }

  console.warn('[produtosService] Nenhum arquivo JSON de catálogo encontrado nos caminhos padrão.');
  return [];
}

/**
 * Extrai termos relevantes de busca a partir do texto do cliente,
 * removendo stopwords de atendimento, quantidades e unidades de medida.
 */
function extrairTermosBusca(textoCliente = '') {
  const stopwords = new Set([
    'oi', 'ola', 'bom', 'dia', 'boa', 'tarde', 'noite', 'tudo', 'bem',
    'quero', 'queria', 'gostaria', 'preciso', 'ver', 'tem', 'voces', 'ai',
    'por', 'favor', 'pfv', 'pode', 'mandar', 'manda', 'me', 've', 'uma', 'um',
    'uns', 'umas', 'de', 'da', 'do', 'das', 'dos', 'para', 'pra', 'pro',
    'com', 'sem', 'mais', 'menos', 'outro', 'outra', 'tambem', 'ja', 'agora',
    'kg', 'kilo', 'kilos', 'quilo', 'quilos', 'grama', 'gramas', 'gr', 'g',
    'unidade', 'unidades', 'un', 'pct', 'pacote', 'bandeja', 'caixa', 'litro', 'litros',
    'corta', 'cortado', 'cortada', 'inteiro', 'inteira', 'limpo', 'limpa',
    'moido', 'moida', 'bife', 'bifes', 'cubos', 'pedacos', 'churrasco', 'panela',
    'rua', 'avenida', 'av', 'numero', 'bairro', 'pix', 'cartao', 'dinheiro', 'credito', 'debito',
    'ok', 'certo', 'fechado', 'isso', 'mesmo', 'pode', 'fechar'
  ]);

  const limpo = normalizarTexto(textoCliente);
  const palavras = limpo
    .split(' ')
    .filter((p) => p.length >= 3 && !stopwords.has(p) && !/^\d+$/.test(p));

  // Agrupa bigramas úteis (ex: "meio asa", "pao alho", "coracao frango", "contra file")
  const termos = new Set(palavras);
  const tokensOriginais = limpo.split(' ').filter((p) => p.length >= 2 && !/^\d+$/.test(p));

  for (let i = 0; i < tokensOriginais.length - 1; i++) {
    const t1 = tokensOriginais[i];
    const t2 = tokensOriginais[i + 1];
    if (!stopwords.has(t1) || !stopwords.has(t2)) {
      const bigrama = `${t1} ${t2}`;
      if (bigrama.length >= 6) {
        termos.add(bigrama);
      }
    }
  }

  return Array.from(termos);
}

/**
 * Calcula relevância de um produto do catálogo SGM para um termo específico.
 * Sem pesos artificiais exclusivos que apaguem outros itens do carrinho.
 */
function calcularScoreProduto(produto, termoNormalizado) {
  const nomeBruto =
    produto.descricao ||
    produto.nome ||
    produto.produto ||
    produto.DESCRICAO ||
    produto.NOME ||
    '';
  const categoriaBruta = produto.categoria || produto.grupo || produto.GRUPO || '';

  const nomeNorm = normalizarTexto(nomeBruto);
  const catNorm = normalizarTexto(categoriaBruta);

  if (!nomeNorm) return 0;

  let score = 0;

  // Match exato da expressão (ex: "meio da asa", "costela", "pao de alho")
  if (nomeNorm.includes(termoNormalizado)) {
    score += 100;
    if (nomeNorm.startsWith(termoNormalizado)) {
      score += 30;
    }
  }

  // Match por palavras individuais do termo
  const partesTermo = termoNormalizado.split(' ').filter((p) => p.length >= 3);
  let matchesParciais = 0;

  for (const parte of partesTermo) {
    if (nomeNorm.includes(parte)) {
      matchesParciais += 1;
      score += 35;
    } else if (catNorm.includes(parte)) {
      score += 10;
    }
  }

  // Bônus se todas as palavras do termo aparecerem no nome do produto
  if (partesTermo.length > 1 && matchesParciais === partesTermo.length) {
    score += 50;
  }

  // Penaliza levemente itens inativos ou sem preço válido
  const preco = Number(produto.preco || produto.valor || produto.PRECO || produto.preco_venda || 0);
  if (preco <= 0) {
    score = 0;
  }

  return score;
}

/**
 * Busca produtos relevantes garantindo distribuição justa entre TODOS os itens
 * mencionados na mensagem atual e no histórico recente da conversa.
 *
 * @param {string} mensagemAtual - Última mensagem enviada pelo cliente
 * @param {Array} historicoMensagens - Histórico recente da conversa [{ role, content }]
 * @param {Array} catalogoOpcional - Lista de produtos se já carregada externamente
 * @returns {Array} Lista deduplicada e balanceada de produtos do SGM
 */
function buscarProdutosRelevantes(mensagemAtual = '', historicoMensagens = [], catalogoOpcional = null) {
  const catalogo = Array.isArray(catalogoOpcional) && catalogoOpcional.length > 0
    ? catalogoOpcional
    : carregarCatalogoSGM();

  if (!catalogo || catalogo.length === 0) {
    return [];
  }

  // Considera a mensagem atual + últimas 8 mensagens do usuário para nunca perder itens já pedidos
  const textosUsuario = [];
  if (Array.isArray(historicoMensagens)) {
    const ultimasDoUsuario = historicoMensagens
      .filter((m) => m && (m.role === 'user' || m.remetente === 'cliente' || !m.fromMe))
      .slice(-8)
      .map((m) => m.content || m.texto || m.body || '');
    textosUsuario.push(...ultimasDoUsuario);
  }
  if (mensagemAtual) {
    textosUsuario.push(mensagemAtual);
  }

  const textoConsolidado = textosUsuario.join(' ');
  const termos = extrairTermosBusca(textoConsolidado);

  if (termos.length === 0) {
    return [];
  }

  const maxTotalProdutos = 14;
  // Garante slots reservados por termo para evitar que "asa" expulse "costela"
  const slotsPorTermo = Math.max(2, Math.floor(maxTotalProdutos / Math.min(termos.length, 5)));

  const selecionadosMap = new Map();

  for (const termo of termos) {
    const ranqueados = catalogo
      .map((prod) => ({
        produto: prod,
        score: calcularScoreProduto(prod, termo),
      }))
      .filter((item) => item.score >= 35)
      .sort((a, b) => b.score - a.score)
      .slice(0, slotsPorTermo);

    for (const item of ranqueados) {
      const p = item.produto;
      const chave = String(
        p.codigo || p.id || p.CODIGO || p.descricao || p.nome || p.DESCRICAO
      ).trim();

      if (!selecionadosMap.has(chave)) {
        selecionadosMap.set(chave, {
          codigo: p.codigo || p.id || p.CODIGO || '',
          descricao_sgm: p.descricao || p.nome || p.DESCRICAO || p.NOME || '',
          preco: Number(p.preco || p.valor || p.PRECO || p.preco_venda || 0),
          unidade: p.unidade || p.un || p.UNIDADE || 'KG',
          categoria: p.categoria || p.grupo || p.GRUPO || '',
          termo_origem: termo,
        });
      }
    }
  }

  return Array.from(selecionadosMap.values()).slice(0, maxTotalProdutos);
}

/**
 * Formata a lista de produtos SGM para injeção limpa no prompt do modelo.
 */
function formatarCatalogoParaPrompt(produtos = []) {
  if (!produtos || produtos.length === 0) {
    return 'NENHUM ITEM ESPECÍFICO LOCALIZADO NO CATÁLOGO SGM PARA ESTA BUSCA.';
  }

  return produtos
    .map((p) => {
      const precoFormatado = Number(p.preco || 0).toFixed(2).replace('.', ',');
      const un = String(p.unidade || 'KG').toUpperCase();
      return `- [Cód: ${p.codigo || 'S/N'}] ${p.descricao_sgm} | Preço SGM: R$ ${precoFormatado} (${un})`;
    })
    .join('\n');
}

module.exports = {
  normalizarTexto,
  carregarCatalogoSGM,
  extrairTermosBusca,
  buscarProdutosRelevantes,
  formatarCatalogoParaPrompt,
  sincronizarSgmComSupabase: carregarCatalogoSGM
};
