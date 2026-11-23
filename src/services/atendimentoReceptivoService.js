const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const redisService = require('./redisService');
const {
  buscarProdutosRelevantes,
  formatarCatalogoParaPrompt,
  carregarProdutosEmFalta,
  isProdutoEmFalta,
} = require('./produtosService');

const NOME_LOJA = process.env.NOME_LOJA || 'Açougue e Mercearia Coisas da Roça';
const ENDERECO_OFICIAL_LOJA = 'Rua Ferreira Viana, 136 - Centro, Macaé/RJ';

function isConfirmacaoCurtaPedido(texto = '') {
  const t = String(texto || '').trim().toLowerCase();
  if (!t || t.length > 28) return false;
  return /^(1|sim|s|ok|okay|confirmar|confirmo|confirmado|pode fechar|fechar|fechado|pode mandar|manda|mandar|isso|isso mesmo|ta otimo|tá ótimo|certo|certinho|✅|👍|👌|☑️|✔️)+$/i.test(t);
}

function normalizarMensagemConfirmacao(texto = '', temHistorico = false) {
  if (temHistorico && isConfirmacaoCurtaPedido(texto)) {
    return '[CONFIRMAÇÃO DO CLIENTE]: O cliente enviou "' + String(texto).trim() + '" (Opção 1 - Confirmar Pedido). NÃO busque novos itens no catálogo e NÃO diga que o item não foi encontrado! Feche imediatamente o pedido com os itens, endereço e pagamento do Resumo do Pedido anterior, emitindo a tag [PEDIDO_FECHADO] e o bloco <COMANDA_JSON>.';
  }
  return texto;
}

function obterResumoFreteMacaeZesto() {
  const caminhos = [
    path.resolve(__dirname, '../../config/bairros_macae_frete.json'),
    path.resolve(__dirname, '../../../config/bairros_macae_frete.json'),
    path.resolve(process.cwd(), 'config/bairros_macae_frete.json'),
    path.resolve(process.cwd(), 'app/config/bairros_macae_frete.json'),
  ];
  for (const p of caminhos) {
    if (fs.existsSync(p)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const min = Number(cfg?.regras_especiais?.frete_gratis_valor_minimo || 200).toFixed(2).replace('.', ',');
        const lista = Object.entries(cfg.bairros || {})
          .map(([b, v]) => b + ': R$ ' + Number(v).toFixed(2).replace('.', ','))
          .join(' | ');
        return 'FRETE GRÁTIS em compras acima de R$ ' + min + '. Taxas por bairro em Macaé: ' + lista;
      } catch (_) {}
    }
  }
  return 'FRETE GRÁTIS acima de R$ 200,00. Taxas Macaé: Centro R$ 5,00 | Imbetiba R$ 8,00 | Cavaleiros/Miramar/Glória/Aroeira R$ 13,00 | Aeroporto/Granja R$ 15,00 | Ajuda/Imboassica R$ 25,00 | Vale das Palmeiras R$ 30,00.';
}

function selecionarModelosSwarm(textoMensagem = '', contexto = []) {
  const txt = String(textoMensagem || '').toLowerCase();
  const matchesPesos = txt.match(/\b(\d+([.,]\d+)?\s*(kg|kilo|quilo|g|gr|gramas|un|pct|pacote|bandeja|galao))\b/gi) || [];
  const temMultiplosPesos = matchesPesos.length >= 3;
  const temTrocaOuRevisao = /\b(tira|tirar|troca|trocar|muda|mudar|substitui|cancela|menos|sem o|sem a|releia|faltou|faltam|esqueceu|errado|repetir|ultimo pedido|último pedido)\b/i.test(txt);
  const isFotoListaOuAudioLongo = txt.includes('[foto de lista') || txt.length >= 150 || (txt.includes('[áudio') && txt.length >= 100);
  const tamanhoContexto = Array.isArray(contexto) ? contexto.length : (Array.isArray(contexto?.itens) ? contexto.itens.length : 0);

  if (temMultiplosPesos || temTrocaOuRevisao || isFotoListaOuAudioLongo || tamanhoContexto >= 4) {
    console.log('[Swarm Router] Turno COMPLEXO -> Maestro (gemini-4-hydrogen / gemini-3.5-flash-lite)');
    return [
      process.env.GEMINI_MODEL_MAESTRO || 'gemini-4-hydrogen',
      'gemini-3.5-flash-lite',
      'gemini-3-flash-preview',
      'gemini-3.8-flash',
      'gemini-1.5-flash',
    ];
  }
  console.log('[Swarm Router] Turno PADRÃO -> Executor Rápido (gemini-3.5-flash-lite / gemini-3-flash-preview)');
  return [
    process.env.GEMINI_MODEL_EXECUTOR || 'gemini-3.5-flash-lite',
    'gemini-3-flash-preview',
    'gemini-3.8-flash',
    'gemini-4-hydrogen',
    'gemini-1.5-flash',
  ];
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

function validarEnderecoEntrega(entregaStr = '', isEncomendaFutura = false) {
  if (!entregaStr) {
    if (isEncomendaFutura) {
      return { valido: true, tipo: 'ENCOMENDA_AGENDADA' };
    }
    return { valido: false, motivo: 'VAZIO' };
  }
  const limpo = String(entregaStr).toLowerCase().trim();

  if (
    isEncomendaFutura ||
    limpo.includes('encomenda') ||
    limpo.includes('agendad') ||
    limpo.includes('agendar') ||
    limpo.includes('quinta') ||
    limpo.includes('sexta') ||
    limpo.includes('sabado') ||
    limpo.includes('sábado') ||
    limpo.includes('segunda') ||
    limpo.includes('terça') ||
    limpo.includes('terca') ||
    limpo.includes('quarta') ||
    limpo.includes('26/11') ||
    limpo.includes('proxima semana') ||
    limpo.includes('próxima semana')
  ) {
    return { valido: true, tipo: 'ENCOMENDA_AGENDADA' };
  }

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

function extrairMetadadosResposta(textoBruto = '', sessaoAtual = {}) {
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

  const textoParaAnalise = (bruto + ' ' + (sessaoAtualizada.endereco || '')).toLowerCase();
  const isEncomenda = /quinta|sexta|sabado|sábado|segunda|terça|terca|quarta|26\/11|encomenda|agendad/i.test(textoParaAnalise);

  if (pedidoFechadoTag && sessaoAtualizada.itens.length > 0) {
    const checkEnd = validarEnderecoEntrega(sessaoAtualizada.endereco, isEncomenda);
    if (checkEnd.valido) {
      pedidoFechado = true;
      dadosPedido = {
        codigo_pedido: String(deltaEstado?.codigo_pedido || Math.floor(100 + Math.random() * 900)).trim(),
        cliente_nome: sessaoAtualizada.clienteNome || 'Cliente WhatsApp',
        endereco: sessaoAtualizada.endereco || (isEncomenda ? 'Encomenda Agendada (A combinar entrega)' : 'Retirada no Balcão'),
        forma_pagamento: sessaoAtualizada.forma_pagamento || 'A combinar',
        troco_para: sessaoAtualizada.troco_para ?? null,
        total_estimado: Number(somaItens.toFixed(2)),
        itens: sessaoAtualizada.itens,
        isEncomendaFutura: isEncomenda,
      };
    }
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

function verificarExpedienteLojaBRT() {
  const agora = new Date();
  const opcoes = { timeZone: 'America/Sao_Paulo', hour12: false };
  const hora = parseInt(agora.toLocaleTimeString('pt-BR', { ...opcoes, hour: '2-digit' }), 10);
  const minuto = parseInt(agora.toLocaleTimeString('pt-BR', { ...opcoes, minute: '2-digit' }), 10);
  const diaSemana = agora.toLocaleDateString('en-US', { ...opcoes, weekday: 'short' });
  const mes = agora.toLocaleDateString('en-US', { ...opcoes, month: 'numeric' });
  const diaDoMes = parseInt(agora.toLocaleDateString('pt-BR', { ...opcoes, day: 'numeric' }), 10);
  const minutos = hora * 60 + minuto;

  let aberto = false;
  let proximaAbertura = 'amanhã às 07h00';

  if (diaSemana === 'Sun') {
    // Domingo FECHADO o ano todo, EXCETO domingos de dezembro (dias 06, 13, 20 e 27 das 09h às 14h)
    const isDezembro = mes === '12';
    const domingoDezembroValido = isDezembro && [6, 13, 20, 27].includes(diaDoMes);
    if (domingoDezembroValido && minutos >= 9 * 60 && minutos <= 14 * 60) {
      aberto = true;
    } else {
      aberto = false;
      proximaAbertura = 'segunda-feira às 07h00';
    }
  } else if (diaSemana === 'Sat') {
    // Sábado: 08h às 17h (480 a 1020 min)
    if (minutos >= 8 * 60 && minutos <= 17 * 60) {
      aberto = true;
    } else {
      aberto = false;
      proximaAbertura = 'segunda-feira às 07h00';
    }
  } else {
    // Segunda a Sexta: 07h às 19h (420 a 1140 min)
    if (minutos >= 7 * 60 && minutos <= 19 * 60) {
      aberto = true;
    } else {
      aberto = false;
      proximaAbertura = minutos < 7 * 60 ? 'hoje às 07h00' : 'amanhã às 07h00';
    }
  }

  return { aberto, proximaAbertura, hora, minuto, diaSemana };
}

function isHorarioComercialAberto() {
  return verificarExpedienteLojaBRT().aberto;
}

function construirSystemPrompt({ nomeCliente, catalogoFormatado, perfilCliente, sessaoAtiva, faltasBalcao = [], isForaDeExpediente = false }) {
  const primeiroNome = nomeCliente && nomeCliente !== 'Cliente'
    ? String(nomeCliente).trim().split(' ')[0]
    : '';

  const jaCumprimentou = Boolean(sessaoAtiva?.boasVindasEnviada || (sessaoAtiva?.historico?.length || 0) > 0);
  const regraSaudacao = jaCumprimentou
    ? 'PROIBIDO repetir "Olá", "Boa noite", "Tudo bem" ou qualquer saudação. Vá 100% direto ao ponto (ex: "Anotado, Txai:").'
    : `Esta é a primeira resposta com itens. Seja breve ("Olá${primeiroNome ? ', ' + primeiroNome : ''}! Já anotei:").`;

  const expediente = verificarExpedienteLojaBRT();
  const blocoNoturno = isForaDeExpediente ? `
====================================================================
⚠️ LOJA FECHADA AGORA / ATENDIMENTO FORA DO EXPEDIENTE
====================================================================
ATENÇÃO CRÍTICA: O balcão do açougue e mercearia está FECHADO neste momento.
- Horário de Atendimento da Loja Física:
  • Segunda a Sexta: 07h às 19h
  • Sábado: 08h às 17h
  • Domingo: FECHADO (abrindo exclusivamente nos domingos de dezembro: dias 06, 13, 20 e 27 das 09h às 14h)
DIRETIVAS OBRIGATÓRIAS QUANDO A LOJA ESTÁ FECHADA:
1. NUNCA finalize o pedido para entrega imediata agora, NUNCA gere a tag [PEDIDO_FECHADO] para envio hoje e NUNCA gere ou prometa envio de chave Pix imediato.
2. Explique gentilmente ao cliente que o nosso balcão está fechado no momento e que reabriremos ${expediente.proximaAbertura}, com cortes frescos selecionados pelo Diogo.
3. Diga que você já está deixando o pedido dele pré-anotado para separação logo na abertura (${expediente.proximaAbertura}).
4. Se o cliente estiver encomendando para uma data futura (ex: quinta-feira, 26/11, sábado), confirme com naturalidade e emita [ENCOMENDA AGENDADA].
` : '';

  const estadoCarrinhoJson = JSON.stringify({
    itens: sessaoAtiva?.itens || [],
    endereco: sessaoAtiva?.endereco || perfilCliente?.endereco || '',
    forma_pagamento: sessaoAtiva?.forma_pagamento || perfilCliente?.forma_pagamento || '',
    etapa: sessaoAtiva?.etapa || 'COLETANDO',
  }, null, 2);

  const blocoFaltas = faltasBalcao.length > 0
    ? `\n====================================================================\n🚫 CORTES ESGOTADOS HOJE — PROIBIDO VENDER:\n====================================================================\n${faltasBalcao.map((f) => `• ${f} (TOTALMENTE ESGOTADO HOJE NO BALCÃO! NUNCA AFIRME QUE TEMOS E NUNCA INCLUA NO PEDIDO)`).join('\n')}\nSe o cliente pedir um desses cortes esgotados, explique com simpatia que já acabou tudo hoje e sugira um corte alternativo de primeira linha ou anote para o dia seguinte!\n`
    : '';

  return `Você é o atendente de balcão do *${NOME_LOJA}* (Macaé/RJ).
📍 ENDEREÇO OFICIAL DA LOJA: ${ENDERECO_OFICIAL_LOJA}
Fale como um balconista de confiança: direto, simpático e enxuto (15 a 35 palavras fora da lista). Sem formalismo robótico, sem adjetivos melosos ("vai ficar uma delícia", "com todo carinho"), sem "meu querido(a)" e NUNCA use emoji de trigo. Use apenas 🥩, 👍, 📍, 🛵.

${regraSaudacao}
${blocoNoturno}
${blocoFaltas}

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
6. ENDEREÇO OFICIAL DA LOJA E LOCALIZAÇÃO:
   - Nosso endereço oficial é SEMPRE "${ENDERECO_OFICIAL_LOJA}". Se o cliente pedir o endereço ou localização da loja para retirada, informe exatamente "${ENDERECO_OFICIAL_LOJA}" e adicione [ENVIAR_LOCALIZACAO]. NUNCA invente outro endereço ou bairro diferente.
   - Para entrega em domicílio em Macaé, exija *Rua, Número e Bairro* (nunca aceite só "Macaé").
   - Se for encomenda agendada para data futura (ex: quinta-feira, 26/11, sábado), aceite o agendamento mesmo sem endereço imediato, emitindo [ENCOMENDA AGENDADA].
7. BOTÕES INTERATIVOS:
   - Se já tem os itens e o endereço, mas falta apenas a forma de pagamento, pergunte a forma de pagamento e adicione [BOTOES_PAGAMENTO] ao final.
   - Se já tem itens, endereço completo e forma de pagamento, mostre o > *Resumo do Pedido* limpo e peça confirmação para enviar ao balcão, adicionando [BOTOES_CONFIRMACAO] ao final.
8. ITEM AUSENTE OU ESGOTADO: Se o item não existir no SGM ou estiver na lista de esgotados, avise com naturalidade que vai confirmar no balcão e adicione [TRANSBORDO_ATENDENTE].
9. MAPEAMENTO CULINÁRIO INTELIGENTE (SINÔNIMOS DE BALCÃO):
   - "Carne moída" / "Carne moída de 1ª" ➔ Mapeie para Patinho Bovino (ou Chã Bovino). Se o cliente pedir moída de 2ª, use Acém Bovino.
   - "Chã de dentro" / "Carne em tiras" ➔ Mapeie para Chã Bovino KG (adicionando observação de corte: "Em tiras").
   - "Batata" ➔ Mapeie para Batata Inglesa KG.
   - "Farinha de mandioca" / "Farinha de trigo" ➔ Mapeie para os pacotes de 1kg disponíveis no catálogo (ex: Farinha Rosa/Yasmim e Farinha Dona Benta/Boa Sorte).
   - "Óleo" ➔ Mapeie para Óleo de Soja 900ml (Soya/Liza).
   - "Rocambole" ➔ Mapeie para Rocambole de Frango Recheado do catálogo.
   - NUNCA afirme que esses produtos "não constam no catálogo" se houver itens correspondentes no CATÁLOGO SGM fornecido abaixo!
10. RELEITURA E RECUPERAÇÃO DE ITENS (TOLERÂNCIA ZERO À OMISSÃO):
    - Se o cliente disser que "está faltando item", "releia o pedido" ou enviar uma lista com vários itens:
      LEIA CADA LINHA DA LISTA COM RIGOR TOTAL.
      É PROIBIDO dizer que "adicionou com o gerente" sem de fato acrescentar os itens faltantes no resumo e no JSON!
      Adicione TODOS os itens solicitados pelo cliente que faltavam, preservando rigorosamente as quantidades exatas de cada linha (ex: 8kg para o que foi pedido 8kg, 3kg para o que foi pedido 3kg).
11. FRETE MACAÉ, FRETE GRÁTIS R$ 200 E CONFIRMAÇÃO 1/✅:
    - Tabela de Frete Macaé: ${obterResumoFreteMacaeZesto()}
    - Se o total estimado dos produtos atingir ou passar de *R$ 200,00* (como no exemplo de R$ 294,92), destaque no resumo: *🚚 Frete: GRÁTIS (pedido acima de R$ 200,00)*! Se ficar entre R$ 145,00 e R$ 199,99, mostre quanto falta para ganhar *Frete Grátis*. Caso contrário, exiba a taxa do bairro do cliente.
    - Quando o cliente responder "1", "✅", "sim", "ok" ou "[CONFIRMAÇÃO DO CLIENTE]" após você ter exibido o Resumo do Pedido com opções "1 - Confirmar Pedido / 2 - Ajustar Itens", JAMAIS diga que não encontrou o item no catálogo! Feche o pedido imediatamente com [PEDIDO_FECHADO] e gere o código de 3 dígitos em crase (ex: \`Pedido #314\`).
    - Se a mensagem vier com "[Foto de lista de compras enviada pelo cliente]:", anote todos os itens extraídos da foto no carrinho.

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

async function chamarGeminiComResiliencia(systemInstruction, contents, modelosPrioritarios = null) {
  const chaves = obterChavesGemini();
  if (!chaves.length) {
    throw new Error('Nenhuma GEMINI_API_KEY configurada no ambiente.');
  }

  const modelos = Array.isArray(modelosPrioritarios) && modelosPrioritarios.length
    ? Array.from(new Set(modelosPrioritarios.filter(Boolean)))
    : ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-4-hydrogen', 'gemini-2.5-flash', 'gemini-2.0-flash'];

  let ultimoErro = null;

  for (const apiKey of chaves) {
    const genAI = new GoogleGenerativeAI(apiKey);

    for (const modelName of modelos) {
      const controller = new AbortController();
      const timeoutMs = modelName.includes("hydrogen") ? 10500 : 15000;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

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
    telefoneReal = '',
  } = opcoes;

  // Compatibilidade: aceita tanto objeto sessaoAtiva (Redis) quanto array de histórico legado
  const sessaoAtiva = Array.isArray(sessaoOuHistorico)
    ? { historico: sessaoOuHistorico, itens: [], boasVindasEnviada: sessaoOuHistorico.length > 0 }
    : (sessaoOuHistorico || {});

  let historicoMensagens = Array.isArray(sessaoAtiva.historico) ? [...sessaoAtiva.historico] : [];
  const textoBruto = String(mensagemCliente || '').trim();
  const temHistoricoPre = Array.isArray(historicoMensagens) && historicoMensagens.length > 0;
  const textoAtual = normalizarMensagemConfirmacao(textoBruto, temHistoricoPre);

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

  if (temItensNoCarrinho && temEnderecoValido && isConfirmacaoCurta) {
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

  // Se a mensagem atual for curta ou de revisão/reclamação ("faltando", "releia", áudio de correção), busca termos das mensagens anteriores
  let textoHistoricoRelevante = '';
  const ehMensagemRevisao = /(falta|faltando|releia|reler|esqueceu|cade|resto|conferir|audio)/i.test(textoAtual) || textoAtual.length < 50;
  if (ehMensagemRevisao && Array.isArray(historicoMensagens)) {
    const msgsCliente = historicoMensagens
      .filter((m) => m && (m.role === 'user' || m.fromMe === false))
      .slice(-3)
      .map((m) => m.content || m.texto || m.body || '')
      .join('\n');
    textoHistoricoRelevante = msgsCliente;
  }

  const contextoBusca = `${textoAtual}\n${textoHistoricoRelevante}\n${nomesItensCarrinho}`.trim();
  const produtosRelevantes = buscarProdutosRelevantes(contextoBusca, historicoMensagens);
  const catalogoFormatado = formatarCatalogoParaPrompt(produtosRelevantes);

  const aberto = isHorarioComercialAberto();
  const testador = redisService && typeof redisService.isNumeroTestador === 'function'
    ? redisService.isNumeroTestador(telefoneReal || sessaoAtiva.clienteTelefone || '')
    : false;
  const isForaDeExpediente = !aberto && !testador;

  const emFaltaSet = typeof carregarProdutosEmFalta === 'function' ? carregarProdutosEmFalta() : new Set();
  const faltasEfetivas = Array.from(new Set([...(faltasBalcao || []), ...Array.from(emFaltaSet)]));

  const systemInstruction = construirSystemPrompt({
    nomeCliente,
    catalogoFormatado,
    perfilCliente,
    sessaoAtiva,
    faltasBalcao: faltasEfetivas,
    isForaDeExpediente,
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
    const respostaBruta = await chamarGeminiComResiliencia(
      systemInstruction,
      contents,
      selecionarModelosSwarm(textoAtual, historicoMensagens)
    );
    const metadados = extrairMetadadosResposta(respostaBruta, {
      ...sessaoAtiva,
      boasVindasEnviada: true,
    });

    if (isForaDeExpediente) {
      metadados.pedidoFechado = false;
      metadados.tipoBotoes = null;
    }

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

/**
 * Transcreve foto de lista de compras enviada pelo cliente usando Gemini Vision
 */
async function extrairListaComprasClienteVision(base64Image, apiKey = null) {
  if (!base64Image) return null;
  const modelosVision = ['gemini-4-hydrogen', 'gemini-3.5-flash-lite', 'gemini-3-flash-preview', 'gemini-3.8-flash'];
  const cleanBase64 = base64Image.replace(/^data:image\/[a-z0-9]+;base64,/i, '');
  const keyToUse = apiKey || process.env.GEMINI_API_KEY || '';

  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const ai = new GoogleGenerativeAI(keyToUse);

  for (const modNome of modelosVision) {
    try {
      const model = ai.getGenerativeModel({ model: modNome });
      const result = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } },
            { text: 'Transcreva fielmente todos os itens e quantidades desta lista de compras de açougue/mercearia enviada pelo cliente. Retorne apenas os itens em texto simples separados por linhas.' }
          ]
        }]
      });
      const txt = result.response.text().trim();
      if (txt) return txt;
    } catch (eMod) {
      console.warn(`[Vision OCR] Modelo ${modNome} falhou:`, eMod.message);
    }
  }
  return null;
}

module.exports = {
  ENDERECO_OFICIAL_LOJA,
  verificarExpedienteLojaBRT,
  isHorarioComercialAberto,
  isSaudacaoPura,
  montarMensagemBoasVindas,
  validarEnderecoEntrega,
  sanitizarRespostaWhatsApp,
  extrairMetadadosResposta,
  processarMensagemReceptiva,
  extrairListaComprasClienteVision,
};
