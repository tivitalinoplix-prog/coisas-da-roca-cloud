const { GoogleGenerativeAI } = require('@google/generative-ai');
const {
  buscarProdutosRelevantes,
  formatarCatalogoParaPrompt,
} = require('./produtosService');

const NOME_LOJA = process.env.NOME_LOJA || 'Açougue e Mercearia Coisas da Roça';

/**
 * Retorna as chaves Gemini configuradas no ambiente (principal + secundária de fallback).
 */
function obterChavesGemini() {
  return [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_FALLBACK,
    process.env.GOOGLE_API_KEY,
  ].filter((k) => Boolean(k && String(k).trim()));
}

/**
 * Identifica se a mensagem é apenas uma saudação inicial sem intenção de compra ainda.
 */
function isSaudacaoPura(texto = '') {
  const limpo = String(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s]/g, '')
    .trim();

  const saudacoes = new Set([
    'oi', 'ola', 'opa', 'bom dia', 'boa tarde', 'boa noite',
    'oi tudo bem', 'ola tudo bem', 'tudo bem', 'e ai', 'eae',
    'oi bom dia', 'oi boa tarde', 'oi boa noite',
    'ola bom dia', 'ola boa tarde', 'ola boa noite'
  ]);

  return saudacoes.has(limpo);
}

/**
 * Saudação inicial limpa, acolhedora e sem qualquer aviso de homologação/teste.
 * Aproveita dados do CRM (Supabase) se o cliente já tiver histórico na loja.
 */
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
      `${saudacao} Bom te ver de novo aqui no *${NOME_LOJA}*.\n\n` +
      `O que vamos separar no balcão hoje? _Se quiser, já mantemos a entrega em *${perfilCliente.endereco}*${pag}._`
    );
  }

  return (
    `${saudacao} Bem-vindo ao *${NOME_LOJA}*.\n\n` +
    `Pode me mandar os itens e quantidades que você precisa (ex: _1kg de costela para churrasco e 1kg de meio da asa_) que eu já anoto tudo por aqui!`
  );
}

/**
 * Sanitiza a saída do modelo para garantir tipografia perfeita no WhatsApp
 * e eliminar qualquer resquício de texto técnico ou aviso indevido.
 */
function sanitizarRespostaWhatsApp(texto = '') {
  if (!texto) return '';

  let out = String(texto);

  // Remove qualquer linha contendo aviso de teste/homologação
  out = out.replace(/.*(inst[aâ]ncia de teste|ambiente de homologa[cç][aã]o|aten[cç][aã]o:\s*inst[aâ]ncia).*\n?/gi, '');

  // Converte negrito Markdown web (**texto**) para negrito nativo WhatsApp (*texto*)
  out = out.replace(/\*\*(.*?)\*\*/g, '*$1*');

  // Remove marca específica da balança mantendo apenas "balança"
  out = out.replace(/\bbalan[cç]a\s+toledo(\s+prix\s*4)?\b/gi, 'balança');

  // Limpa blocos de código JSON/tags técnicas que possam vazar
  out = out.replace(/```json[\s\S]*?```/gi, '');

  // Evita excesso de linhas em branco
  out = out.replace(/\n{3,}/g, '\n\n').trim();

  return out;
}

/**
 * Extrai e limpa o bloco JSON estruturado de comanda emitido pelo modelo no fechamento,
 * garantindo que o cliente receba apenas o texto limpo do WhatsApp.
 */
function extrairMetadadosResposta(textoBruto = '') {
  let textoLimpo = String(textoBruto);

  const transbordoHumano = textoLimpo.includes('[TRANSBORDO_ATENDENTE]');
  const pedidoFechado = textoLimpo.includes('[PEDIDO_FECHADO]');

  textoLimpo = textoLimpo
    .replace(/\[TRANSBORDO_ATENDENTE\]/g, '')
    .replace(/\[PEDIDO_FECHADO\]/g, '');

  let dadosPedido = null;
  const matchComanda = textoLimpo.match(/<COMANDA_JSON>([\s\S]*?)<\/COMANDA_JSON>/i);

  if (matchComanda && matchComanda[1]) {
    try {
      dadosPedido = JSON.parse(matchComanda[1].trim());
    } catch (err) {
      console.warn('[atendimentoReceptivoService] Falha ao parsear <COMANDA_JSON>:', err.message);
    }
    textoLimpo = textoLimpo.replace(/<COMANDA_JSON>[\s\S]*?<\/COMANDA_JSON>/gi, '');
  }

  return {
    textoCliente: sanitizarRespostaWhatsApp(textoLimpo),
    transbordoHumano,
    pedidoFechado,
    dadosPedido,
  };
}

/**
 * Monta o System Prompt definitivo do atendente de balcão do açougue.
 */
function construirSystemPrompt({ nomeCliente, catalogoFormatado, perfilCliente }) {
  const blocoCliente = [
    `Nome do cliente: ${nomeCliente || 'Não informado'}`,
    perfilCliente?.endereco
      ? `Endereço cadastrado no CRM: ${perfilCliente.endereco}`
      : 'Endereço cadastrado no CRM: Nenhum (perguntar ao cliente)',
    perfilCliente?.forma_pagamento
      ? `Forma de pagamento habitual: ${perfilCliente.forma_pagamento}`
      : 'Forma de pagamento habitual: Nenhuma (perguntar ao cliente)',
  ].join('\n');

  return `Você é o atendente digital de balcão do *${NOME_LOJA}* (Macaé/RJ).
Seu jeito de falar é o de um balconista de açougue de confiança: acolhedor, ágil, claro e natural no WhatsApp. Sem formalismo robótico, sem textões cansativos e sem interrogatório picado.

DADOS DO CLIENTE:
${blocoCliente}

====================================================================
1. REGRAS DE CATÁLOGO SGM E MEMÓRIA DE CARRINHO (TOLERÂNCIA ZERO A ERROS)
====================================================================
- ANCORAGEM FIEL: Use EXCLUSIVAMENTE os preços reais listados no CATÁLOGO SGM abaixo. Jamais invente valores.
- MEMÓRIA PERSISTENTE MULTI-TURN: Nunca apague ou esqueça um item pedido nos turnos anteriores da conversa. Se o cliente pediu costela no início e depois pediu meio da asa ou carvão, mantenha TODOS os itens acumulados na comanda até que o cliente peça explicitamente para remover ou substituir algum.
- HUMANIZAÇÃO DOS NOMES SGM: Nunca copie o texto bruto em CAIXA ALTA do ERP (ex: nunca escreva "MEIO DA ASA DE FRANGO RESFRIADA KG"). Converta para leitura natural de balcão em *Negrito* (ex: *Meio da Asa de Frango* ou *Costela Bovina*), mantendo o preço exato do SGM.
- UNIDADES (KG vs UN): Respeite a unidade do SGM. Para itens por *KG*, calcule o valor estimado multiplicando o peso pedido pelo preço/kg e exiba com til (~), ex: *~R$ 29,90*. Para itens por *UN* ou *PCT*, exiba o valor exato multiplicado pela quantidade, ex: *R$ 14,90*.
- ITEM AUSENTE OU DÚVIDA DE VITRINE: Se o cliente pedir algo que NÃO consta no CATÁLOGO SGM abaixo ou perguntar algo que exija olhar a vitrine física:
  1. Diga com simpatia que você não tem a confirmação imediata daquele item no sistema rápido.
  2. Avise que está chamando uma atendente para verificar direto no balcão e responder por aqui em instantes.
  3. Insira a tag [TRANSBORDO_ATENDENTE] no final da resposta.

====================================================================
2. TIPOGRAFIA NATIVA DO WHATSAPP (HIERARQUIA VISUAL OBRIGATÓRIA)
====================================================================
- *Negrito* (1 asterisco de cada lado, NUNCA dois): Use exclusivamente em nomes de produtos, valores em reais (*~R$ 29,90*), totais/subtotais e títulos de etapa.
- _Itálico_ (underline): Use para observações de corte/preparo (ex: _(cortada p/ churrasco)_), observações curtas e para a nota da balança.
- > Citação (sinal > seguido de espaço): Use para envelopar os blocos de *Resumo do Pedido*, *Comanda Atualizada* e *Resumo Final*.
- ~Tachado~ (til): Use APENAS quando o cliente remover ou trocar um item (ex: • ~1kg de Meio da Asa~ _(removido)_).
- \`Monoespaçado\` (crase): Use exclusivamente no código da comanda fechada (ex: \`Pedido #408\`).

====================================================================
3. FLUXO CONVERSACIONAL SEM ATRITO
====================================================================
- ANOTAÇÃO IMEDIATA: Quando o cliente pedir um ou mais itens, anote TODOS na hora com seus valores estimados. Nunca pergunte "posso anotar?".
- NOTA ÚNICA DA BALANÇA: Sempre que houver itens pesáveis (KG), coloque esta frase curta em _itálico_ UMA ÚNICA VEZ logo abaixo do subtotal (nunca repita várias vezes na mesma mensagem e nunca escreva "Toledo"):
  _Valores aproximados; o peso exato sai na balança com o cupom._
- PERGUNTA CONSOLIDADA:
  * Se faltar preparo/corte, endereço e pagamento, peça tudo junto de forma leve em uma única pergunta.
  * Se o cliente já tiver endereço e pagamento no CRM, confirme direto: "Mantemos a entrega em *[Endereço]* e pagamento no *[Pagamento]*?"
- SUGESTÃO SUTIL DE COMPLEMENTO ("FALTANDO ALGO?"):
  * Quando itens, endereço e pagamento já estiverem definidos (antes do fechamento final), faça UMA ÚNICA sugestão leve de acompanhamentos que combinam com o pedido (ex: *carvão*, *sal grosso*, *pão de alho* ou *bebida gelada*) e peça um *"ok"* para fechar. Nunca repita se já perguntou antes.
- FECHAMENTO FINAL E DESPACHO PARA IMPRESSÃO:
  * Quando o cliente confirmar o fechamento ("ok", "pode fechar", "pode mandar", "tá ótimo" com tudo definido), gere um código curto de 3 dígitos em crase (ex: \`Pedido #314\`), apresente o bloco > *Resumo Final*, informe que a equipe já recebeu a comanda para separação e enviará o cupom da balança (e a chave Pix, se aplicável) antes do motoboy sair.
  * Inclua a tag [PEDIDO_FECHADO] e, logo abaixo dela (invisível ao cliente), o bloco JSON exato:
<COMANDA_JSON>
{
  "codigo_pedido": "314",
  "cliente_nome": "Nome do Cliente",
  "endereco": "Endereço completo com bairro",
  "forma_pagamento": "Pix | Cartão | Dinheiro",
  "troco_para": null,
  "total_estimado": 56.80,
  "itens": [
    {
      "codigo_sgm": "123",
      "nome": "Costela Bovina",
      "quantidade": 1,
      "unidade": "KG",
      "preco_unitario": 29.90,
      "subtotal": 29.90,
      "observacao_corte": "Cortada p/ churrasco"
    }
  ]
}
</COMANDA_JSON>

====================================================================
CATÁLOGO SGM PARA ESTA CONVERSA:
====================================================================
${catalogoFormatado}`;
}

/**
 * Executa a chamada ao Gemini com fallback automático entre modelos e chaves API,
 * protegida por timeout via AbortController para nunca travar a fila do WhatsApp.
 */
async function chamarGeminiComResiliencia(systemInstruction, contents) {
  const chaves = obterChavesGemini();
  if (!chaves.length) {
    throw new Error('Nenhuma GEMINI_API_KEY configurada no ambiente.');
  }

  const modelos = [
    process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    'gemini-2.0-flash',
  ];

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
            temperature: 0.2,
            topP: 0.9,
            maxOutputTokens: 1100,
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

/**
 * Função principal de atendimento receptivo no WhatsApp.
 */
async function processarMensagemReceptiva(mensagemCliente, historicoMensagens = [], opcoes = {}) {
  const {
    nomeCliente = '',
    perfilCliente = null,
  } = opcoes;

  const textoAtual = String(mensagemCliente || '').trim();
  const temHistorico = Array.isArray(historicoMensagens) && historicoMensagens.length > 0;

  // Saudação pura no início da conversa responde instantaneamente sem gastar API
  if (!temHistorico && isSaudacaoPura(textoAtual)) {
    return {
      resposta: montarMensagemBoasVindas(nomeCliente, perfilCliente),
      transbordoHumano: false,
      pedidoFechado: false,
      dadosPedido: null,
      produtosConsultados: [],
    };
  }

  // Busca balanceada no catálogo SGM cobrindo todo o histórico recente + mensagem atual
  const produtosRelevantes = buscarProdutosRelevantes(textoAtual, historicoMensagens);
  const catalogoFormatado = formatarCatalogoParaPrompt(produtosRelevantes);

  const systemInstruction = construirSystemPrompt({
    nomeCliente,
    catalogoFormatado,
    perfilCliente,
  });

  // Monta histórico alternado estritamente entre 'user' e 'model'
  const contents = [];
  if (Array.isArray(historicoMensagens)) {
    for (const msg of historicoMensagens.slice(-16)) {
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
    const metadados = extrairMetadadosResposta(respostaBruta);

    return {
      resposta: metadados.textoCliente,
      transbordoHumano: metadados.transbordoHumano,
      pedidoFechado: metadados.pedidoFechado,
      dadosPedido: metadados.dadosPedido,
      produtosConsultados: produtosRelevantes,
    };
  } catch (err) {
    console.error('[atendimentoReceptivoService] Erro crítico na orquestração:', err);
    return {
      resposta:
        'Tive uma instabilidade rápida aqui no sistema do balcão. Já chamei uma atendente para continuar seu pedido por aqui mesmo!',
      transbordoHumano: true,
      pedidoFechado: false,
      dadosPedido: null,
      produtosConsultados: produtosRelevantes,
    };
  }
}

module.exports = {
  isSaudacaoPura,
  montarMensagemBoasVindas,
  sanitizarRespostaWhatsApp,
  extrairMetadadosResposta,
  processarMensagemReceptiva,
};
