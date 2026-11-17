const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const {
  buscarProdutosRelevantes,
  formatarCatalogoParaPrompt,
} = require('./produtosService');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const NOME_LOJA = process.env.NOME_LOJA || 'Coisas da Roça';

// Estado de sessões em memória com limpeza periódica (compatibilidade com app.js)
const conversasAtivas = new Map();
setInterval(() => {
  const agora = Date.now();
  for (const [k, v] of conversasAtivas.entries()) {
    if (v.pausadoAte && v.pausadoAte < agora) conversasAtivas.delete(k);
  }
}, 5 * 60 * 1000).unref();

function isConversaPausada(sessionKey) {
  const sessao = conversasAtivas.get(sessionKey);
  return Boolean(sessao && sessao.pausadoAte && Date.now() < sessao.pausadoAte);
}

function pausarIAIntervencaoHumana(sessionKey, minutos = 15, motivo = 'MANUAL') {
  const agora = Date.now();
  conversasAtivas.set(sessionKey, {
    pausadoAte: agora + minutos * 60 * 1000,
    pausadoEm: agora,
    motivo
  });
  console.log(`  [COOLDOWN] ${sessionKey} pausado por ${minutos}min (${motivo}).`);
}

function despausarConversa(sessionKey) {
  conversasAtivas.delete(sessionKey);
}

function extrairPrimeiroNome(pushName) {
  if (!pushName || typeof pushName !== 'string') return 'Cliente';
  const limpo = pushName.trim();
  if (limpo.toLowerCase() === 'cliente' || !limpo) return 'Cliente';
  return limpo.split(/\s+/)[0];
}

// --- GESTÃO DE RUPTURAS (#falta) ---
const produtosEmFaltaPath = path.join(__dirname, '..', '..', '..', 'config', 'produtos_em_falta.json');

function obterProdutosEmFalta() {
  if (!fs.existsSync(produtosEmFaltaPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(produtosEmFaltaPath, 'utf-8'));
    return Array.isArray(data.itens) ? data.itens : [];
  } catch {
    return [];
  }
}

function salvarProdutosEmFalta(itens) {
  try {
    const dir = path.dirname(produtosEmFaltaPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      produtosEmFaltaPath,
      JSON.stringify({
        atualizadoEm: new Date().toISOString(),
        itens: Array.from(new Set(itens.map(i => i.trim()).filter(Boolean)))
      }, null, 2),
      'utf-8'
    );
    return true;
  } catch {
    return false;
  }
}

function alternarProdutoEmFalta(itemNome, forcarStatus = null) {
  const itens = obterProdutosEmFalta();
  const nomeLimpo = itemNome.replace(/não temos|nao temos/gi, '').trim();
  const index = itens.findIndex(i => i.toLowerCase() === nomeLimpo.toLowerCase());

  if (forcarStatus === 'ESGOTADO') {
    if (index === -1) itens.push(nomeLimpo);
    salvarProdutosEmFalta(itens);
    return { status: 'ESGOTADO', item: nomeLimpo, itens };
  }
  if (forcarStatus === 'DISPONIVEL') {
    if (index >= 0) itens.splice(index, 1);
    salvarProdutosEmFalta(itens);
    return { status: 'DISPONIVEL', item: nomeLimpo, itens };
  }
  return { status: 'INALATERADO', item: nomeLimpo, itens };
}

function validarEnderecoEntrega(entregaStr) {
  if (!entregaStr) return { valido: false, motivo: 'VAZIO' };
  const limpo = String(entregaStr).toLowerCase().trim();

  if (/\b(balcao|balcão|retira|retirada)\b/.test(limpo)) {
    return { valido: true, tipo: 'RETIRADA_BALCAO' };
  }

  const invalidos = ['macae', 'macaé', 'macae/rj', 'macaé/rj', 'entrega', 'delivery', 'sim', 'a combinar'];
  if (invalidos.includes(limpo) || limpo.length < 10) {
    return { valido: false, motivo: 'ENDERECO_INCOMPLETO' };
  }

  const temNumeroOuRef = /\d+|s\/n|sem n[uú]mero|esquina|perto|pr[oó]ximo|lote|quadra|bloco|apto|casa/i.test(limpo);
  if (!temNumeroOuRef) {
    return { valido: false, motivo: 'SEM_NUMERO_OU_REFERENCIA' };
  }

  return { valido: true, tipo: 'ENTREGA_DOMICILIO' };
}

/**
 * Transcrição rápida de áudio PTT com Gemini
 */
async function transcreverAudio(base64Audio, apiKey) {
  if (!base64Audio) return null;
  try {
    const ai = apiKey ? new GoogleGenerativeAI(apiKey) : genAI;
    const model = ai.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const cleanBase64 = base64Audio.replace(/^data:audio\/[a-z0-9\-+.]+;base64,/i, '');

    const result = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'audio/ogg', data: cleanBase64 } },
          { text: 'Transcreva fielmente este áudio em português do Brasil de um cliente de açougue e mercearia em Macaé/RJ (ex: alcatra, patinho, meio da asa, pé de galinha, água Areia Branca, Serra do Segredo, bife fino, moído 2x). Retorne APENAS a transcrição.' }
        ]
      }]
    });

    const response = await result.response;
    return response.text().trim() || null;
  } catch (err) {
    console.error('  [STT Áudio] Erro:', err.message);
    return null;
  }
}

/**
 * OCR de rupturas manuscritas via Gemini Vision
 */
async function extrairRupturasImagemVision(base64Image, apiKey) {
  if (!base64Image) return [];
  try {
    const ai = apiKey ? new GoogleGenerativeAI(apiKey) : genAI;
    const model = ai.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { responseMimeType: 'application/json' }
    });
    const cleanBase64 = base64Image.replace(/^data:image\/[a-z0-9]+;base64,/i, '');

    const result = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } },
          { text: 'Extraia os nomes dos produtos/cortes em falta nesta foto. Retorne APENAS um array JSON de strings, ex: ["Costela Bovina", "Fraldinha"].' }
        ]
      }]
    });

    const response = await result.response;
    const raw = response.text().trim() || '[]';
    const lista = JSON.parse(raw);
    if (Array.isArray(lista) && lista.length > 0) {
      const combinados = Array.from(new Set([...obterProdutosEmFalta(), ...lista.map(i => String(i).trim())]));
      salvarProdutosEmFalta(combinados);
      return lista;
    }
    return [];
  } catch (err) {
    console.error('  [Vision Rupturas] Erro:', err.message);
    return [];
  }
}

/**
 * Verifica se a mensagem é apenas uma saudação inicial curta sem pedido.
 */
function isSaudacaoPura(texto = '') {
  const limpo = String(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s]/g, '')
    .trim();

  const saudacoes = [
    'oi', 'ola', 'opa', 'bom dia', 'boa tarde', 'boa noite',
    'oi tudo bem', 'ola tudo bem', 'tudo bem', 'e ai', 'eae',
    'oi bom dia', 'oi boa tarde', 'oi boa noite',
    'ola bom dia', 'ola boa tarde', 'ola boa noite'
  ];

  return saudacoes.includes(limpo);
}

/**
 * Monta a mensagem de boas-vindas limpa, acolhedora e SEM qualquer aviso de teste.
 * Se já houver perfil salvo do cliente (Supabase), já personaliza o retorno VIP.
 */
function montarMensagemBoasVindas(nomeCliente = '', clientePerfil = null) {
  const primeiroNome = nomeCliente
    ? String(nomeCliente).trim().split(' ')[0]
    : '';

  const saudacao = primeiroNome ? `Olá, *${primeiroNome}*!` : 'Olá!';

  if (clientePerfil && clientePerfil.endereco_completo) {
    const pagTexto = clientePerfil.forma_pagamento_preferida
      ? ` e pagamento no *${clientePerfil.forma_pagamento_preferida}*`
      : '';

    return (
      `${saudacao} Bom te ver de novo aqui no *${NOME_LOJA}*.\n\n` +
      `O que vamos separar para você hoje? _Se quiser, já mantemos a entrega em *${clientePerfil.endereco_completo}*${pagTexto}._`
    );
  }

  return (
    `${saudacao} Bem-vindo ao *${NOME_LOJA}*.\n\n` +
    `Pode me mandar os itens e quantidades que você precisa (ex: _1kg de costela para churrasco e 1kg de meio da asa_) que eu já separo tudo por aqui!`
  );
}

/**
 * Remove qualquer resquício indesejado de avisos de homologação/teste,
 * excesso de asteriscos duplicados ou repetições técnicas.
 */
function sanitizarRespostaIA(texto = '') {
  if (!texto) return '';

  let limpo = String(texto);

  // Bloqueio absoluto contra qualquer aviso de instância de teste
  limpo = limpo.replace(/.*(inst[aâ]ncia de teste|ambiente de homologa[cç][aã]o|aten[cç][aã]o:\s*inst[aâ]ncia).*\n?/gi, '');

  // Corrige eventuais negritos duplos estilo Markdown web (**texto**) para WhatsApp (*texto*)
  limpo = limpo.replace(/\*\*(.*?)\*\*/g, '*$1*');

  // Remove menção específica à marca da balança caso o modelo tente inserir
  limpo = limpo.replace(/\bbalan[cç]a\s+toledo\b/gi, 'balança');

  // Trava de segurança anti-contradição (Caso Monique):
  const falaEmRotaOuSeparacao = /(em separa[çc][ãa]o|vai para a rota|saindo para entrega|j[áa] est[áa] na rota)/i.test(limpo);
  const pedeEnderecoNaMesmaMsg = /(pegar o seu endere[çc]o|qual o endere[çc]o|informe seu endere[çc]o)/i.test(limpo);
  if (falaEmRotaOuSeparacao && pedeEnderecoNaMesmaMsg) {
    return 'Olá! Vou verificar agora mesmo com a equipe aqui no balcão sobre a confirmação do seu pedido e já te retorno! 👍 [CHAMAR_HUMANO]';
  }

  // Remove excesso de quebras de linha (mais de 2 seguidas)
  limpo = limpo.replace(/\n{3,}/g, '\n\n').trim();

  return limpo;
}

/**
 * Constrói o System Prompt detalhado com a identidade visual do WhatsApp,
 * regras rígidas de catálogo SGM e fluxo de atendimento sem atrito.
 */
function construirSystemPrompt({ nomeCliente, catalogoFormatado, clientePerfil, carrinhoSessao }) {
  const infoCliente = nomeCliente ? `Nome do cliente: ${nomeCliente}` : 'Nome do cliente: Não informado';

  const infoPerfilSalvo = clientePerfil
    ? `DADOS SALVOS DO CLIENTE (CRM):\n- Endereço habitual: ${clientePerfil.endereco_completo || 'Não cadastrado'}\n- Pagamento habitual: ${clientePerfil.forma_pagamento_preferida || 'Não cadastrado'}`
    : 'DADOS SALVOS DO CLIENTE (CRM): Primeiro atendimento ou sem endereço salvo.';

  const infoSessaoAtual = carrinhoSessao
    ? `ESTADO ATUAL DA COMANDA NA SESSÃO:\n${JSON.stringify(carrinhoSessao, null, 2)}`
    : 'ESTADO ATUAL DA COMANDA NA SESSÃO: Extraia e mantenha todos os itens ativos do histórico da conversa.';

  return `Você é o atendente digital de balcão do açougue e mercearia *${NOME_LOJA}*.
Seu estilo é ágil, cordial, direto e profissional — como um balconista experiente que anota rápido, confirma com clareza e não faz interrogatório.

${infoCliente}
${infoPerfilSalvo}
${infoSessaoAtual}

====================================================================
1. REGRAS RÍGIDAS DE CATÁLOGO E PREÇOS (SGM)
====================================================================
- Utilize EXCLUSIVAMENTE os preços reais listados no CATÁLOGO SGM abaixo. Nunca invente preços.
- NUNCA apague ou esqueça um item que o cliente pediu anteriormente na conversa. Mantenha TODOS os itens ativos acumulados na comanda até que o cliente peça explicitamente para remover ou trocar.
- HUMANIZAÇÃO DOS NOMES: Nunca copie o nome em CAIXA ALTA cheio de abreviações do ERP (ex: nunca escreva "MEIO DA ASA DE FRANGO RESFRIADA KG"). Converta para uma escrita limpa e natural em *Negrito* (ex: *Meio da Asa de Frango* ou *Costela Bovina*), mantendo o preço exato do SGM.
- PRODUTO NÃO ENCONTRADO NO CATÁLOGO SGM: Se o cliente pedir algo específico que NÃO está no catálogo SGM abaixo ou perguntar algo da vitrine/estoque físico que você não tem certeza:
  1. Informe com transparência que você não tem a confirmação imediata daquele item no sistema rápido.
  2. Diga que está chamando uma atendente para verificar direto no balcão e responder por aqui em instantes.
  3. Inclua exatamente a tag oculta [TRANSBORDO_ATENDENTE] no final da sua resposta (ela será removida antes de enviar ao cliente e servirá para pausar o robô).

====================================================================
2. IDENTIDADE VISUAL E TIPOGRAFIA DO WHATSAPP (OBRIGATÓRIO)
====================================================================
Use a formatação nativa do WhatsApp com disciplina e elegância:
- *Negrito* (apenas um asterisco de cada lado, NUNCA dois): Use EXCLUSIVAMENTE em nomes de produtos, valores em reais (*~R$ 29,90* ou *R$ 29,90*), subtotais/totais e títulos de etapa.
- _Itálico_ (underline): Use para preparo/corte (ex: _(cortada p/ churrasco)_), observações secundárias e para a nota da balança.
- > Citação (sinal de maior + espaço no início da linha): Use para envelopar os blocos de *Resumo do Pedido*, *Comanda Atualizada* e *Resumo Final*, criando uma barra lateral elegante.
- ~Tachado~ (til): Use APENAS quando o cliente remover ou trocar um item no meio da conversa (ex: • ~1kg de Meio da Asa~ _(removido)_).
- \`Monoespaçado\` (crase): Use ao gerar o protocolo de fechamento final (ex: \`Pedido #408\`).

====================================================================
3. REGRAS DE FLUXO E CONVERSA SEM ATRITO
====================================================================
- ANOTE IMEDIATAMENTE: Se o cliente pedir 2 ou mais itens (ex: "1kg de costela e 1kg de meio da asa"), já anote TODOS na hora com seus valores estimados, sem ficar perguntando "posso anotar?".
- UMA ÚNICA NOTA DE BALANÇA: Sempre que listar itens pesáveis com valor estimado, inclua esta frase curta em _itálico_ UMA ÚNICA VEZ abaixo do subtotal (nunca repita várias vezes na mesma mensagem e nunca escreva a marca da balança):
  _Valores aproximados; o peso exato sai na balança com o cupom._
- PERGUNTA CONSOLIDADA (SEM INTERROGATÓRIO PICADO):
  * Se faltar preparo/corte, endereço e pagamento, pergunte tudo de forma leve e objetiva na mesma mensagem.
  * Se o cliente já tiver endereço e pagamento salvos no CRM, apenas pergunte: "Mantemos a entrega em *[Endereço]* e pagamento no *[Pagamento]*?"
- SUGESTÃO SUTIL DE COMPLEMENTO ("FALTANDO ALGO?"):
  * Quando o pedido já tiver itens, endereço e pagamento definidos (antes do fechamento final), faça UMA ÚNICA pergunta leve sugerindo acompanhamentos que combinam com o pedido (ex: *carvão*, *sal grosso*, *pão de alho* ou *bebida gelada*) e peça um *"ok"* para fechar.
  * Nunca repita essa sugestão se você já perguntou antes na mesma conversa.
- FECHAMENTO FINAL:
  * Assim que o cliente confirmar ("pode fechar", "ok", "tá ótimo", "pode mandar" após tudo informado), encerre com o bloco > *Resumo Final*, gere um código curto aleatório de 3 dígitos em crase (ex: \`Pedido #314\`), informe que a equipe de separação já recebeu a comanda e que enviará o cupom da balança (e a chave Pix, se for Pix) antes da saída da entrega.
  * Inclua a tag oculta [PEDIDO_FECHADO] no final da resposta (será removida antes do envio).

====================================================================
4. MODELOS DE FORMATAÇÃO DE REFERÊNCIA
====================================================================
Exemplo de anotação inicial:
Olá, *Diogo*! Já anotei os dois itens aqui no balcão:

• *1kg de Costela Bovina* — *~R$ 29,90* (kg)
• *1kg de Meio da Asa* — *~R$ 26,90* (kg)

*Subtotal estimado: ~R$ 56,80*
_Valores aproximados; o peso exato sai na balança com o cupom._

Como você prefere o preparo (ex: costela cortada p/ churrasco e asa inteira)? Já me passa também seu *endereço* e a *forma de pagamento* para adiantarmos!

Exemplo de bloco de resumo com citação:
> *Resumo do Pedido*
> • *1kg de Costela Bovina* _(cortada p/ churrasco)_ — *~R$ 29,90*
> • *1kg de Meio da Asa* _(inteiro)_ — *~R$ 26,90*
> *Total estimado: ~R$ 56,80*
>
> *Entrega:* Rua das Acácias, 120 - Cavaleiros
> *Pagamento:* Pix _(enviamos a chave junto com o valor exato da balança)_

====================================================================
CATÁLOGO SGM DISPONÍVEL PARA ESTA CONVERSA:
====================================================================
${catalogoFormatado}`;
}

/**
 * Processa a mensagem recebida no atendimento receptivo do WhatsApp.
 *
 * @param {string} mensagemCliente - Texto enviado pelo cliente
 * @param {Array} historicoMensagens - Histórico recente [{ role: 'user'|'model', content: string }]
 * @param {Object} opcoes - Dados opcionais { nomeCliente, catalogoProdutos, clientePerfil, carrinhoSessao }
 * @returns {Promise<Object>} { resposta, transbordoHumano, pedidoFechado, produtosConsultados }
 */
async function processarMensagemReceptiva(mensagemCliente, historicoMensagens = [], opcoes = {}) {
  const {
    nomeCliente = '',
    catalogoProdutos = null,
    clientePerfil = null,
    carrinhoSessao = null,
  } = opcoes;

  const textoLimpo = String(mensagemCliente || '').trim();

  // 1. Saudação pura sem pedido e sem histórico ativo: resposta instantânea sem gastar tokens
  const temHistoricoAtivo = Array.isArray(historicoMensagens) && historicoMensagens.length > 0;
  if (!temHistoricoAtivo && isSaudacaoPura(textoLimpo)) {
    return {
      resposta: montarMensagemBoasVindas(nomeCliente, clientePerfil),
      transbordoHumano: false,
      pedidoFechado: false,
      produtosConsultados: [],
    };
  }

  // 2. Busca balanceada no catálogo SGM considerando TODO o contexto da conversa
  const produtosRelevantes = buscarProdutosRelevantes(
    textoLimpo,
    historicoMensagens,
    catalogoProdutos
  );
  const catalogoFormatado = formatarCatalogoParaPrompt(produtosRelevantes);

  // 3. Monta prompt e histórico para o Gemini
  const systemInstruction = construirSystemPrompt({
    nomeCliente,
    catalogoFormatado,
    clientePerfil,
    carrinhoSessao,
  });

  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction,
    generationConfig: {
      temperature: 0.25,
      topP: 0.9,
      maxOutputTokens: 900,
    },
  });

  // Converte histórico para o formato oficial do SDK @google/generative-ai
  const contents = [];
  if (Array.isArray(historicoMensagens)) {
    for (const msg of historicoMensagens.slice(-14)) {
      const textoMsg = msg.content || msg.texto || msg.body || msg.mensagem_cliente || msg.resposta_ia || '';
      if (!textoMsg) continue;

      const role =
        msg.role === 'model' || msg.role === 'assistant' || msg.fromMe === true || msg.resposta_ia
          ? 'model'
          : 'user';

      // Evita duas mensagens seguidas com a mesma role (exigência da API Gemini)
      if (contents.length > 0 && contents[contents.length - 1].role === role) {
        contents[contents.length - 1].parts[0].text += `\n${textoMsg}`;
      } else {
        contents.push({
          role,
          parts: [{ text: String(textoMsg) }],
        });
      }
    }
  }

  // Garante que a conversa comece sempre com 'user'
  while (contents.length > 0 && contents[0].role !== 'user') {
    contents.shift();
  }

  // Adiciona a mensagem atual do cliente
  if (contents.length > 0 && contents[contents.length - 1].role === 'user') {
    contents[contents.length - 1].parts[0].text += `\n${textoLimpo}`;
  } else {
    contents.push({
      role: 'user',
      parts: [{ text: textoLimpo }],
    });
  }

  try {
    const result = await model.generateContent({ contents });
    const response = await result.response;
    let respostaBruta = response.text() || '';

    // Detecta flags de controle emitidas pelo modelo e limpa antes de enviar ao cliente
    const transbordoHumano = respostaBruta.includes('[TRANSBORDO_ATENDENTE]');
    const pedidoFechado = respostaBruta.includes('[PEDIDO_FECHADO]');

    respostaBruta = respostaBruta
      .replace(/\[TRANSBORDO_ATENDENTE\]/g, '')
      .replace(/\[PEDIDO_FECHADO\]/g, '');

    const respostaFinal = sanitizarRespostaIA(respostaBruta);

    return {
      resposta: respostaFinal,
      transbordoHumano,
      pedidoFechado,
      produtosConsultados: produtosRelevantes,
    };
  } catch (error) {
    console.error('[atendimentoReceptivoService] Erro ao gerar resposta com Gemini:', error);

    return {
      resposta:
        'Tive uma instabilidade rápida aqui no sistema do balcão. Já estou chamando uma atendente para continuar seu atendimento por aqui mesmo!',
      transbordoHumano: true,
      pedidoFechado: false,
      produtosConsultados: produtosRelevantes,
    };
  }
}

/**
 * Função de compatibilidade direta com app.js
 */
async function gerarRespostaAtendimento({ replyTarget, clienteNome, texto, base64Audio, apiKey, historico = [] }) {
  const primeiroNome = extrairPrimeiroNome(clienteNome);

  // Consulta de status / confirmação de pedido sem pedido fechado (Caso Monique)
  const textoLimpo = String(texto || '').trim().toLowerCase();
  const isConsultaStatus = /^(s[oó]\s+pra\s+saber\s+se\s+)?(meu\s+pedido\s+foi\s+confirmado|meu\s+pedido\s+t[aá]\s+confirmado|j[aá]\s+saiu|cad[eê]\s+meu\s+pedido|t[aá]\s+vindo|onde\s+est[aá]\s+meu\s+pedido|previs[aã]o\s+do\s+meu\s+pedido)[?!.\s]*$/i.test(textoLimpo);
  const possuiPedidoConfirmado = historico.some(h => (h.resposta_ia || '').includes('[PEDIDO_IMPRESSO_CAIXA1]') || (h.resposta_ia || '').includes('[PEDIDO_FECHADO]'));

  if (isConsultaStatus && !possuiPedidoConfirmado) {
    return {
      texto: `Olá, *${primeiroNome}*! Vou verificar agora mesmo com a equipe aqui no balcão sobre a confirmação do seu pedido e já te retorno! 👍 [CHAMAR_HUMANO]`,
      cooldownMinutos: 20
    };
  }

  // Executa o processador oficial
  const res = await processarMensagemReceptiva(texto, historico, { nomeCliente: clienteNome });

  let respostaTexto = res.resposta;
  if (res.transbordoHumano && !respostaTexto.includes('[CHAMAR_HUMANO]')) {
    respostaTexto += ' [CHAMAR_HUMANO]';
  }
  if (res.pedidoFechado && !respostaTexto.includes('[PEDIDO_FECHADO]')) {
    respostaTexto += ' [PEDIDO_FECHADO]';
  }

  return respostaTexto;
}

module.exports = {
  isSaudacaoPura,
  montarMensagemBoasVindas,
  sanitizarRespostaIA,
  construirSystemPrompt,
  processarMensagemReceptiva,
  gerarRespostaAtendimento,
  transcreverAudio,
  extrairRupturasImagemVision,
  validarEnderecoEntrega,
  isConversaPausada,
  pausarIAIntervencaoHumana,
  despausarConversa,
  obterProdutosEmFalta,
  alternarProdutoEmFalta,
  extrairPrimeiroNome
};
