const { GoogleGenerativeAI } = require('@google/generative-ai');
const {
  buscarProdutosRelevantes,
  formatarCatalogoParaPrompt,
} = require('./produtosService');

const NOME_LOJA = process.env.NOME_LOJA || 'Açougue e Mercearia Coisas da Roça';

const IDS_TESTADORES = ['998586180', '173679971422247'];

function isTestador(id) {
const texto = String(id || '');
return IDS_TESTADORES.some((t) => texto.includes(t));
}

function isHorarioComercialAberto() {
const agora = new Date();
const partes = new Intl.DateTimeFormat('en-US', {
timeZone: 'America/Sao_Paulo',
weekday: 'short',
hour: '2-digit',
minute: '2-digit',
hour12: false,
}).formatToParts(agora);
const mapa = {};
for (const p of partes) {
mapa[p.type] = p.value;
}
const dia = mapa.weekday;
let hora = Number(mapa.hour);
if (hora === 24) hora = 0;
const minutos = hora * 60 + Number(mapa.minute);
const abertura = 7 * 60 + 30;
if (dia === 'Sun') {
return minutos >= abertura && minutos < 13 * 60;
}
return minutos >= abertura && minutos < 19 * 60 + 30;
}

function obterChavesGemini() {
  return [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_FALLBACK,
    process.env.GOOGLE_API_KEY,
  ].filter((k) => Boolean(k && String(k).trim()));
}

function isSaudacaoPura(texto = '') {
  const limpo = String(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const saudacoes = new Set([
    'oi', 'ola', 'opa', 'bom dia', 'boa tarde', 'boa noite',
    'oi tudo bem', 'ola tudo bem', 'tudo bem', 'e ai', 'eae',
    'oi bom dia', 'oi boa tarde', 'oi boa noite',
    'ola bom dia', 'ola boa tarde', 'ola boa noite',
    'oie', 'alo', 'comecar', 'inicio', 'cardapio', 'menu',
  ]);

  return saudacoes.has(limpo);
}

function montarMensagemBoasVindas(nomeCliente = '', perfilCliente = null) {
  const primeiroNome = nomeCliente
    ? String(nomeCliente).trim().split(' ')[0]
    : '';
  const saudacao = primeiroNome ? `Olá, *${primeiroNome}*!` : 'Olá!';

  if (perfilCliente && perfilCliente.endereco) {
    const pag = perfilCliente.forma_pagamento
      ? ` e pagamento no *${perfilCliente.forma_pagamento}*`
      : '';
    return (
      `${saudacao} Bem-vindo de volta ao *${NOME_LOJA}*! 🥩\n` +
      `_Desde 1993 • Paixão por Carne_\n\n` +
      `O que vamos separar hoje? _(Se quiser, mantemos entrega em *${perfilCliente.endereco}*${pag})_`
    );
  }

  return (
    `${saudacao} Bem-vindo ao *${NOME_LOJA}*! 🥩\n` +
    `_Desde 1993 • Paixão por Carne_\n\n` +
    `Pode mandar áudio ou texto com os itens e quantidades que eu já anoto tudo no balcão! 👍`
  );
}

function validarEnderecoEntrega(entregaStr = '') {
  if (!entregaStr) return { valido: false, motivo: 'VAZIO' };
  const limpo = String(entregaStr).toLowerCase().trim();

  if (limpo.includes('balcao') || limpo.includes('balcão') || limpo.includes('retira')) {
    return { valido: true, tipo: 'RETIRADA_BALCAO' };
  }

  const invalidosExatos = [
    'macae', 'macaé', 'macae/rj', 'macaé/rj', 'entrega', 'delivery',
    'entrega em macae', 'entrega em macaé', 'sim', 'a combinar',
  ];
  if (invalidosExatos.includes(limpo) || limpo.length < 10) {
    return { valido: false, motivo: 'ENDERECO_INCOMPLETO' };
  }

  const temNumeroOuRef = /\d+|s\/n|sem numero|sem número|esquina|perto|proximo|próximo|lote|quadra|bloco|apto|casa/i.test(limpo);
  if (!temNumeroOuRef) {
    return { valido: false, motivo: 'SEM_NUMERO_OU_REFERENCIA' };
  }

  return { valido: true, tipo: 'ENTREGA_DOMICILIO' };
}

function detectarIntencaoDeterministica(texto = '') {
  const limpo = String(texto)
    .toLowerCase()
    .replace(/^\[áudio do cliente\]:\s*/i, '')
    .trim();

  if (
    /^(chamar|quero|falar com|preciso de)?\s*(um\s+)?(humano|atendente|pessoa|algu[eé]m|balc[aã]o)$/i.test(limpo) ||
    limpo === '3' ||
    limpo.includes('falar com balc')
  ) {
    return {
      tipo: 'HUMANO',
      resposta: 'Certo! Já avisei nossa equipe no balcão e um atendente assume sua conversa em instantes. 👍',
      pausaSegundos: 1800,
    };
  }

  if (limpo.includes('jussara') && (limpo.includes('falar') || limpo.includes('chamar') || limpo.length < 25)) {
    return {
      tipo: 'HUMANO',
      resposta: 'Já avisei a Jussara aqui no balcão e em instantes ela te responde! 👍',
      pausaSegundos: 1800,
    };
  }

  if (limpo.includes('diogo') && (limpo.includes('falar') || limpo.includes('chamar') || limpo.length < 25)) {
    return {
      tipo: 'HUMANO',
      resposta: 'Já avisei o Diogo aqui no açougue e em instantes ele te responde! 👍',
      pausaSegundos: 1800,
    };
  }

  const isPosEntrega =
    /^(j[aá]\s+recebi|recebi|j[aá]\s+paguei|tudo\s+certo|obrigad[oa]|valeu|por\s+nada|de\s+nada)[!.\s]*$/i.test(limpo) ||
    ((limpo.includes('ja recebi') || limpo.includes('já recebi') || limpo.includes('tudo certo')) && limpo.length < 40);

  if (isPosEntrega) {
    return {
      tipo: 'POS_ENTREGA',
      resposta: 'Perfeito! Agradecemos a preferência. Qualquer novo pedido, estamos à disposição no balcão! 🥩👍',
      pausaSegundos: 1800,
    };
  }

  return null;
}

function sanitizarRespostaWhatsApp(texto = '') {
  if (!texto) return '';

  let out = String(texto);

  out = out.replace(/<ESTADO_CARRINHO_JSON>[\s\S]*?(?:<\/ESTADO_CARRINHO_JSON>|$)/gi, '');
  out = out.replace(/<COMANDA_JSON>[\s\S]*?(?:<\/COMANDA_JSON>|$)/gi, '');
  out = out.replace(/\[TRANSBORDO_ATENDENTE\]/gi, '');
  out = out.replace(/\[PEDIDO_FECHADO\]/gi, '');
  out = out.replace(/\[BOTOES_PAGAMENTO\]/gi, '');
  out = out.replace(/\[BOTOES_CONFIRMACAO\]/gi, '');
  out = out.replace(/\[ENVIAR_LOCALIZACAO\]/gi, '');
  out = out.replace(/~\s*R\$/gi, 'R$');
  out = out.replace(/.*(inst[aâ]ncia de teste|ambiente de homologa[cç][aã]o|aten[cç][aã]o:\s*inst[aâ]ncia).*\n?/gi, '');
  out = out.replace(/```(?:json)?[\s\S]*?(?:```|$)/gi, '');
  out = out.replace(/\*\*(.*?)\*\*/g, '*$1*');
  out = out.replace(/🌾/g, '🥩');
  out = out.replace(/\b(meu querido|minha querida|meu amor|minha flor|querido|querida)\b/gi, '');
  out = out.replace(/\bbalan[cç]a\s+toledo(\s+prix\s*4)?\b/gi, 'balança');
  out = out.replace(/\n{3,}/g, '\n\n').trim();

  return out;
}

function mesclarEstadoSessao(sessaoAtual = {}, delta = null) {
  const base = {
    ...sessaoAtual,
    clienteNome: sessaoAtual.clienteNome || '',
    itens: Array.isArray(sessaoAtual.itens) ? [...sessaoAtual.itens] : [],
    endereco: sessaoAtual.endereco || '',
    bairro: sessaoAtual.bairro || '',
    forma_pagamento: sessaoAtual.forma_pagamento || '',
    troco_para: sessaoAtual.troco_para ?? null,
    etapa: sessaoAtual.etapa || 'COLETANDO',
    boasVindasEnviada: Boolean(sessaoAtual.boasVindasEnviada),
    historico: Array.isArray(sessaoAtual.historico) ? [...sessaoAtual.historico] : [],
  };

  if (!delta || typeof delta !== 'object') return base;

  if (delta.cliente_nome && String(delta.cliente_nome).trim()) {
    base.clienteNome = String(delta.cliente_nome).trim();
  }

  // Só substitui os itens se o delta trouxer uma lista não-vazia (ou se explicitamente limpou com acao === 'LIMPAR')
  if (Array.isArray(delta.itens) && delta.itens.length > 0) {
    base.itens = delta.itens
      .filter((it) => it && (it.nome || it.descricao))
      .map((it) => {
        const quantidade = Number(it.quantidade) > 0 ? Number(it.quantidade) : 1;
        const precoUnit = Number(it.preco_unitario) >= 0 ? Number(it.preco_unitario) : 0;
        const subtotalCalc =
          Number(it.subtotal) >= 0
            ? Number(it.subtotal)
            : Number((quantidade * precoUnit).toFixed(2));
        return {
          codigo_sgm: String(it.codigo_sgm || it.codigo || '').trim(),
          nome: String(it.nome || it.descricao || '').trim(),
          quantidade,
          unidade: String(it.unidade || 'KG').trim().toUpperCase(),
          preco_unitario: precoUnit,
          subtotal: subtotalCalc,
          observacao_corte: String(it.observacao_corte || it.preparo || 'Padrão da casa').trim(),
        };
      });
  } else if (delta.acao === 'LIMPAR') {
    base.itens = [];
  }

  if (delta.endereco && String(delta.endereco).trim()) {
    base.endereco = String(delta.endereco).trim();
  }
  if (delta.bairro && String(delta.bairro).trim()) {
    base.bairro = String(delta.bairro).trim();
  }
  if (delta.forma_pagamento && String(delta.forma_pagamento).trim()) {
    base.forma_pagamento = String(delta.forma_pagamento).trim();
  }
  if (delta.troco_para !== undefined && delta.troco_para !== null) {
    base.troco_para = delta.troco_para;
  }
  if (delta.etapa && String(delta.etapa).trim()) {
    base.etapa = String(delta.etapa).trim();
  }

  return base;
}

function extrairMetadadosResposta(textoBruto = '', sessaoAtual = {}), opcoes = {} {
  const bruto = String(textoBruto || '');

  const transbordoHumano = /\[TRANSBORDO_ATENDENTE\]/i.test(bruto);
  const pedidoFechadoTag = /\[PEDIDO_FECHADO\]/i.test(bruto);

  const enviarLocalizacao = /\[ENVIAR_LOCALIZACAO\]/i.test(bruto);
  let tipoBotoes = null;
  if (/\[BOTOES_PAGAMENTO\]/i.test(bruto)) tipoBotoes = 'PAGAMENTO';
  else if (/\[BOTOES_CONFIRMACAO\]/i.test(bruto)) tipoBotoes = 'CONFIRMACAO';

  let deltaEstado = null;
  const matchEstado = bruto.match(/<ESTADO_CARRINHO_JSON>([\s\S]*?)<\/ESTADO_CARRINHO_JSON>/i);
  const matchComanda = bruto.match(/<COMANDA_JSON>([\s\S]*?)<\/COMANDA_JSON>/i);
  const rawJson = matchEstado?.[1] || matchComanda?.[1] || '';

  if (rawJson) {
    const jsonLimpo = rawJson
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .replace(/,\s*([}\]])/g, '$1')
      .trim();
    try {
      deltaEstado = JSON.parse(jsonLimpo);
    } catch (err) {
      console.warn('[atendimentoReceptivoService] Falha ao parsear JSON de estado/comanda:', err.message);
    }
  }

  const sessaoAtualizada = mesclarEstadoSessao(sessaoAtual, deltaEstado);
  const somaItens = sessaoAtualizada.itens.reduce((acc, it) => acc + (Number(it.subtotal) || 0), 0);

  let dadosPedido = null;
  let pedidoFechado = false;

  if (pedidoFechadoTag && sessaoAtualizada.itens.length > 0) {
    const checkEnd = validarEnderecoEntrega(sessaoAtualizada.endereco);
    if (checkEnd.valido) {
      pedidoFechado = true;
      dadosPedido = {
        codigo_pedido: String(deltaEstado?.codigo_pedido || Math.floor(100 + Math.random() * 900)).trim(),
        cliente_nome: sessaoAtualizada.clienteNome || 'Cliente WhatsApp',
        endereco: sessaoAtualizada.endereco,
        forma_pagamento: sessaoAtualizada.forma_pagamento || 'A combinar',
        troco_para: sessaoAtualizada.troco_para ?? null,
        total_estimado: Number(somaItens.toFixed(2)),
        itens: sessaoAtualizada.itens,
      };
   
   
    }
  }
  const idClienteSanitizacao = opcoes?.chatId || opcoes?.clienteId || opcoes?.telefone || opcoes?.perfilCliente?.id || opcoes?.perfilCliente?.telefone || sessaoAtualizada?.chatId || sessaoAtualizada?.clienteId || sessaoAtualizada?.telefone || sessaoAtualizada?.id || '';
if (pedidoFechado && !isHorarioComercialAberto() && !isTestador(idClienteSanitizacao)) {
pedidoFechado = false;
dadosPedido = null;
}
  

  return {
    textoCliente: sanitizarRespostaWhatsApp(bruto),
    transbordoHumano,
    pedidoFechado,
    enviarLocalizacao,
    dadosPedido,
    sessaoAtualizada,
    tipoBotoes,
  };
}

function construirSystemPrompt({ nomeCliente, catalogoFormatado, perfilCliente, sessaoAtiva, faltasBalcao = [] }) {
  const primeiroNome = nomeCliente && nomeCliente !== 'Cliente'
    ? String(nomeCliente).trim().split(' ')[0]
    : '';

  const jaCumprimentou = Boolean(sessaoAtiva?.boasVindasEnviada || (sessaoAtiva?.historico?.length || 0) > 0);
  const regraSaudacao = jaCumprimentou
    ? 'PROIBIDO repetir "Olá", "Boa noite", "Tudo bem" ou qualquer saudação. Vá 100% direto ao ponto (ex: "Anotado, Txai:").'
    : `Esta é a primeira resposta com itens. Seja breve ("Olá${primeiroNome ? ', ' + primeiroNome : ''}! Já anotei:").`;

  const estadoCarrinhoJson = JSON.stringify({
    itens: sessaoAtiva?.itens || [],
    endereco: sessaoAtiva?.endereco || perfilCliente?.endereco || '',
    forma_pagamento: sessaoAtiva?.forma_pagamento || perfilCliente?.forma_pagamento || '',
    etapa: sessaoAtiva?.etapa || 'COLETANDO',
  }, null, 2);

  const blocoFaltas = faltasBalcao.length > 0
    ? `\nITENS ESGOTADOS HOJE NO BALCÃO (PROIBIDO VENDER):\n${faltasBalcao.map((f) => `• ${f}`).join('\n')}\n`
    : '';

  return `Você é o atendente de balcão do *${NOME_LOJA}* (Macaé/RJ).
Fale como um balconista de confiança: direto, simpático e enxuto (15 a 35 palavras fora da lista). Sem formalismo robótico, sem adjetivos melosos ("vai ficar uma delícia", "com todo carinho"), sem "meu querido(a)" e NUNCA use emoji de trigo. Use apenas 🥩, 👍, 📍, 🛵.

${regraSaudacao}

====================================================================
TIPOGRAFIA NATIVA DO WHATSAPP (OBRIGATÓRIA PARA LIMPEZA VISUAL)
====================================================================
- *Negrito* (1 asterisco de cada lado, NUNCA dois): nomes de produtos, preços, totais e títulos de bloco.
- _Itálico_ (underline): observações de corte/preparo e nota da balança.
- > Citação (sinal > seguido de espaço): use para envolver os blocos de > *Resumo do Pedido* e > *Resumo Final*.).
- ~Tachado~ (til): use APENAS quando o cliente remover ou trocar um item (ex: • ~1kg de Costela~ _(removido)_).
- NUNCA coloque o símbolo til (~) antes de R$ (pois o WhatsApp confunde com texto tachado e polui a leitura; exiba o valor limpo *R$ 55,99*).
- \`Monoespaçado\` (crase): use exclusivamente no código do pedido fechado (ex: \`Pedido #314\`).

====================================================================
ESTADO ATUAL DO CARRINHO PERSISTIDO NO REDIS (NUNCA ESQUEÇA ESTES DADOS)
====================================================================
${estadoCarrinhoJson}

REGRAS DO CARRINHO MULTI-TURN (TOLERÂNCIA ZERO À AMNÉSIA):
- Se o cliente responder apenas com emojis (✅, 👍, 🥩) ou números (1, 2, 3), NUNCA trate o emoji como um produto em falta no catálogo; interprete como confirmação do pedido ou escolha da opção numerada.
1. SEMPRE preserve os itens já listados no ESTADO ATUAL DO CARRINHO acima. Se o cliente mandar apenas o endereço ou forma de pagamento nesta mensagem, MANTENHA todos os itens intactos e mostre o resumo atualizado! dentro de bloco > *Resumo do Pedido*!
2. PREÇO UNITÁRIO + TOTAL OBRIGATÓRIO: Em todo item listado, exiba o preço por kg/un do SGM junto ao subtotal:
   > *Resumo do Pedido*
   • *2kg - Patinho Bovino* (R$ 55,99/kg — 1kg moído + 1kg picado) — *R$ 111,98*
3. NOTA DE BALANÇA: Quando houver item por KG, coloque UMA única vez abaixo do subtotal:
   _Valores das carnes são estimados; o valor exato sai na balança com o cupom._
4. ANCORAGEM NO SGM: Use EXCLUSIVAMENTE produtos e preços do CATÁLOGO SGM abaixo. Nunca invente marcas ou valores.
5. ÁGUA MINERAL 20L: Sempre priorize e informe primeiro o preço do *Refil/Reposição* (troca do galão vazio) antes do galão completo, e pergunte se o cliente já possui o vasilhame vazio para troca.
6. ENDEREÇO COMPLETO E LOCALIZAÇÃO: Para entrega em Macaé, exija *Rua, Número e Bairro* (nunca aceite só "Macaé"). Se o cliente pedir o endereço ou localização da loja para retirada, informe e adicione [ENVIAR_LOCALIZACAO].
7. BOTÕES INTERATIVOS:
   - Se já tem os itens e o endereço, mas falta apenas a forma de pagamento, pergunte a forma de pagamento e adicione [BOTOES_PAGAMENTO] ao final.
   - Se já tem itens, endereço completo e forma de pagamento, mostre o > *Resumo do Pedido* limpo e peça confirmação para enviar ao balcão, adicionando [BOTOES_CONFIRMACAO] ao final.
8. ITEM AUSENTE OU ESGOTADO: Se o item não existir no SGM ou estiver na lista de esgotados, avise com naturalidade que vai confirmar no balcão e adicione [TRANSBORDO_ATENDENTE].

====================================================================
SAÍDA ESTRUTURADA OBRIGATÓRIA EM TODO TURNO (INVISÍVEL AO CLIENTE)
====================================================================
Sempre termine sua resposta com o bloco abaixo contendo o estado completo e acumulado (mesmo que o pedido ainda esteja em andamento). Quando o cliente confirmar o fechamento ("ok", "pode fechar", "confirmar", "1") com itens + endereço completo + pagamento, gere um código de 3 dígitos em crase (ex: \`Pedido #314\`) no > *Resumo Final* e adicione [PEDIDO_FECHADO]]:

<ESTADO_CARRINHO_JSON>
{
  "codigo_pedido": "314",
  "cliente_nome": "${primeiroNome || 'Cliente'}",
  "endereco": "Rua, Número - Bairro ou Retirada no Balcão",
  "forma_pagamento": "Pix | Cartão | Dinheiro | ",
  "etapa": "COLETANDO | AGUARDANDO_PAGAMENTO | AGUARDANDO_CONFIRMACAO | FECHADO",
  "itens": [
    {
      "codigo_sgm": "123",
      "nome": "Patinho Bovino",
      "quantidade": 2,
      "unidade": "KG",
      "preco_unitario": 55.99,
      "subtotal": 111.98,
      "observacao_corte": "1kg moído + 1kg picado"
    }
  ]
}
</ESTADO_CARRINHO_JSON>
${blocoFaltas}
====================================================================
CATÁLOGO SGM DISPONÍVEL:
====================================================================
${catalogoFormatado}`;
}

async function chamarGeminiComResiliencia(systemInstruction, contents) {
  const chaves = obterChavesGemini();
  if (!chaves.length) {
    throw new Error('Nenhuma GEMINI_API_KEY configurada no ambiente.');
  }

  const modelos = Array.from(
    new Set([
      process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      'gemini-2.5-flash',
      'gemini-3.5-flash-lite',
    ].filter(Boolean))
  );

  let ultimoErro = null;

  for (const apiKey of chaves) {
    const genAI = new GoogleGenerativeAI(apiKey);

    for (const modelName of modelos) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 22000);

      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction,
          generationConfig: {
            temperature: 0.15,
            topP: 0.9,
            maxOutputTokens: 2048,
          },
        });

        const result = await model.generateContent(
          { contents },
          { signal: controller.signal }
        );
        clearTimeout(timeoutId);

        const texto = result?.response?.text?.() || '';
        if (texto.trim()) {
          return texto;
        }
      } catch (err) {
        clearTimeout(timeoutId);
        ultimoErro = err;
        console.warn(
          `[atendimentoReceptivoService] Falha no modelo ${modelName} (${err.message}). Tentando fallback...`
        );
      }
    }
  }

  throw ultimoErro || new Error('Todos os modelos Gemini falharam.');
}

async function processarMensagemReceptiva(mensagemCliente, sessaoOuHistorico = {}, opcoes = {}) {
  const {
    nomeCliente = '',
    perfilCliente = null,
    faltasBalcao = [],
  } = opcoes;

  // Compatibilidade: aceita tanto objeto sessaoAtiva (Redis) quanto array de histórico legado
  const sessaoAtiva = Array.isArray(sessaoOuHistorico)
    ? { historico: sessaoOuHistorico, itens: [], boasVindasEnviada: sessaoOuHistorico.length > 0 }
    : (sessaoOuHistorico || {});

  let historicoMensagens = Array.isArray(sessaoAtiva.historico) ? [...sessaoAtiva.historico] : [];
  const textoAtual = String(mensagemCliente || '').trim();

  // Reset de sessão por inatividade (> 45 minutos) ou pedido anterior já fechado
  const QUARENTA_E_CINCO_MIN_MS = 45 * 60 * 1000;
  const agora = Date.now();
  let ultimaMsgTimestamp = null;

  if (historicoMensagens.length > 0) {
    const ultimaMsg = historicoMensagens[historicoMensagens.length - 1];
    if (ultimaMsg?.timestamp) {
      ultimaMsgTimestamp = Number(ultimaMsg.timestamp);
    }
  }

  if (!ultimaMsgTimestamp && sessaoAtiva.atualizadoEm) {
    const t = new Date(sessaoAtiva.atualizadoEm).getTime();
    if (!Number.isNaN(t)) {
      ultimaMsgTimestamp = t;
    }
  }

  const tempoInativoMs = ultimaMsgTimestamp ? (agora - ultimaMsgTimestamp) : 0;
  const pedidoJaFechado = sessaoAtiva.etapa === 'FECHADO';
  const deveResetarInatividade = tempoInativoMs > QUARENTA_E_CINCO_MIN_MS;

  if (pedidoJaFechado || deveResetarInatividade) {
    console.log(`[atendimentoReceptivoService] Resetando sessão (motivo: ${pedidoJaFechado ? 'PEDIDO_FECHADO' : 'INATIVIDADE'}).`);
    sessaoAtiva.boasVindasEnviada = false;
    sessaoAtiva.historico = [];
    sessaoAtiva.itens = [];
    sessaoAtiva.etapa = 'INICIO';
    historicoMensagens = [];
  }

  // Atalho determinístico de confirmação de pedido (emojis ou número 1)
  const limpoAtalho = textoAtual.toLowerCase().trim();
  const temItensNoCarrinho = Array.isArray(sessaoAtiva.itens) && sessaoAtiva.itens.length > 0;
  const temEnderecoValido = validarEnderecoEntrega(sessaoAtiva.endereco).valido;
  const isConfirmacaoCurta = /^(1|sim|s|ok|confirmar|confirmo|confirmado|pode fechar|fechar|fechado|pode mandar|manda|isso|isso mesmo|perfeito|certo|👍+|✅+|☑️+|✔️+|🥩+|🙏+|👏+|💯+)$/i.test(limpoAtalho);

  if (temItensNoCarrinho && temEnderecoValido && isConfirmacaoCurta)  {
const idCliente = opcoes.chatId || opcoes.clienteId || opcoes.telefone || sessaoAtiva.chatId || sessaoAtiva.clienteId || sessaoAtiva.telefone || sessaoAtiva.id || perfilCliente?.id || perfilCliente?.telefone || '';
if (!isHorarioComercialAberto() && !isTestador(idCliente)) {
return {
resposta: '📝 Seu pedido e endereço já ficaram anotados aqui no balcão! Como estamos fora do horário de expediente agora, assim que abrirmos às *07h30* nossa equipe já pesa os seus cortes na balança e te envia o valor exato com o Pix para confirmar a entrega, combinado? 🥩👍',
transbordoHumano: false,
pedidoFechado: false,
enviarLocalizacao: false,
dadosPedido: null,
sessaoAtualizada: { ...sessaoAtiva, boasVindasEnviada: true },
enviarLogo: false,
tipoBotoes: null,
produtosConsultados: [],
};
}
      const codigoPedido = String(Math.floor(100 + Math.random() * 900));
    const somaItens = sessaoAtiva.itens.reduce((acc, it) => acc + (Number(it.subtotal) || 0), 0);
    const pgtoFinal = sessaoAtiva.forma_pagamento || perfilCliente?.forma_pagamento || 'Pix';
    const listaResumo = sessaoAtiva.itens.map((it) => `• *${it.quantidade}${it.unidade} - ${it.nome}* (_${it.observacao_corte || 'Padrão'}_) — *R$ ${Number(it.subtotal).toFixed(2).replace('.', ',')}*`).join('\n');
    const msgFechamento = `Pedido confirmado e enviado para o balcão separar! 🥩\n` +
      `\`Pedido #${codigoPedido}\`\n\n` +
      `> *Resumo Final*\n` +
      `${listaResumo}\n\n` +
      `📍 *Entrega:* ${sessaoAtiva.endereco}\n` +
      `💳 *Pagamento:* ${pgtoFinal}\n` +
      `💰 *Total Estimado:* *R$ ${somaItens.toFixed(2).replace('.', ',')}*\n` +
      `_O peso e valor exatos saem na balança física com o cupom antes do motoboy sair!_ 🛵`;

    return {
      resposta: msgFechamento,
      transbordoHumano: false,
      pedidoFechado: true,
      enviarLocalizacao: false,
      dadosPedido: {
        codigo_pedido: codigoPedido,
        cliente_nome: nomeCliente || sessaoAtiva.clienteNome || 'Cliente WhatsApp',
        endereco: sessaoAtiva.endereco,
        forma_pagamento: pgtoFinal,
        troco_para: sessaoAtiva.troco_para ?? null,
        total_estimado: Number(somaItens.toFixed(2)),
        itens: sessaoAtiva.itens,
      },
      sessaoAtualizada: { ...sessaoAtiva, forma_pagamento: pgtoFinal, etapa: 'FECHADO', boasVindasEnviada: true },
      enviarLogo: false,
      tipoBotoes: null,
      produtosConsultados: [],
    };
  }

  // 1. Atalhos determinísticos (falar com balcão / pós-entrega)
  const det = detectarIntencaoDeterministica(textoAtual);
  if (det) {
    return {
      resposta: det.resposta,
      transbordoHumano: det.tipo === 'HUMANO',
      pausaSegundos: det.pausaSegundos,
      pedidoFechado: false,
      enviarLocalizacao: false,
      dadosPedido: null,
      sessaoAtualizada: sessaoAtiva,
      enviarLogo: false,
      tipoBotoes: null,
      produtosConsultados: [],
    };
  }

  const primeiraRespostaSessao = !sessaoAtiva.boasVindasEnviada;
  const semItensNoCarrinho = !Array.isArray(sessaoAtiva.itens) || sessaoAtiva.itens.length === 0;

  // 2. Saudação pura -> envia Logo Oficial + boas-vindas oficiais
  if (isSaudacaoPura(textoAtual) && (primeiraRespostaSessao || semItensNoCarrinho)) {
    return {
      resposta: montarMensagemBoasVindas(nomeCliente, perfilCliente),
      transbordoHumano: false,
      pedidoFechado: false,
      enviarLocalizacao: false,
      dadosPedido: null,
      sessaoAtualizada: { ...sessaoAtiva, boasVindasEnviada: true },
      enviarLogo: true,
      tipoBotoes: null,
      produtosConsultados: [],
    };
  }

  // 3. Busca produtos no SGM incluindo os nomes dos itens já no carrinho para manter ancoragem de preço
  const nomesItensCarrinho = (sessaoAtiva.itens || []).map((i) => i.nome).join(' ');
  const contextoBusca = `${textoAtual} ${nomesItensCarrinho}`.trim();
  const produtosRelevantes = buscarProdutosRelevantes(contextoBusca, historicoMensagens);
  const catalogoFormatado = formatarCatalogoParaPrompt(produtosRelevantes);

  const systemInstruction = construirSystemPrompt({
    nomeCliente,
    catalogoFormatado,
    perfilCliente,
    sessaoAtiva,
    faltasBalcao,
  });

  const contents = [];
  for (const msg of historicoMensagens.slice(-12)) {
    const txt = msg?.content || msg?.texto || msg?.body || '';
    if (!txt) continue;

    const role =
      msg.role === 'model' || msg.role === 'assistant' || msg.fromMe === true
        ? 'model'
        : 'user';

    if (contents.length > 0 && contents[contents.length - 1].role === role) {
      contents[contents.length - 1].parts[0].text += `\n${txt}`;
    } else {
      contents.push({ role, parts: [{ text: String(txt) }] });
    }
  }

  while (contents.length > 0 && contents[0].role !== 'user') {
    contents.shift();
  }

  if (contents.length > 0 && contents[contents.length - 1].role === 'user') {
    contents[contents.length - 1].parts[0].text += `\n${textoAtual}`;
  } else {
    contents.push({ role: 'user', parts: [{ text: textoAtual }] });
  }

  try {
    const respostaBruta = await chamarGeminiComResiliencia(systemInstruction, contents);
    const metadados = extrairMetadadosResposta(respostaBruta, {
      ...sessaoAtiva,
      boasVindasEnviada: true,
    }), opcoes;

    return {
      resposta: metadados.textoCliente,
      transbordoHumano: metadados.transbordoHumano,
      pedidoFechado: metadados.pedidoFechado,
      enviarLocalizacao: metadados.enviarLocalizacao,
      dadosPedido: metadados.dadosPedido,
      sessaoAtualizada: metadados.sessaoAtualizada,
      enviarLogo: primeiraRespostaSessao,
      tipoBotoes: metadados.tipoBotoes,
      produtosConsultados: produtosRelevantes,
    };
  } catch (err) {
    console.error('[atendimentoReceptivoService] Erro crítico na orquestração:', err);
    return {
      resposta:
        'Tive uma instabilidade rápida aqui no balcão. Já chamei uma atendente para continuar seu pedido por aqui!',
      transbordoHumano: true,
      pedidoFechado: false,
      enviarLocalizacao: false,
      dadosPedido: null,
      sessaoAtualizada: sessaoAtiva,
      enviarLogo: false,
      tipoBotoes: null,
      produtosConsultados: produtosRelevantes,
    };
  }
}

module.exports = {
  isSaudacaoPura,
  montarMensagemBoasVindas,
  validarEnderecoEntrega,
  sanitizarRespostaWhatsApp,
  extrairMetadadosResposta,
  processarMensagemReceptiva,
};
