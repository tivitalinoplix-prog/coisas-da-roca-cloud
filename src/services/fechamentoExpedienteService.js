const supabaseService = require('./supabaseService');
const redisService = require('./redisService');
const whatsappAdapter = require('./whatsappUniversalAdapter');
const impressaoTermicaService = require('./impressaoTermicaService');

const TELEFONE_DIOGO = process.env.TELEFONE_GERENCIA_DIOGO || process.env.WAPI_CONNECTED_PHONE || '5522997621921';

/**
 * Consolida os pedidos do dia no Supabase, envia relatório no WhatsApp do Diogo
 * e enfileira fita de conferência na impressora térmica do Caixa 1 às 19h30.
 */
async function executarFechamentoExpediente() {
  const hojeIso = new Date().toISOString().slice(0, 10);
  const dataFormatada = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  let pedidosHoje = [];
  if (supabaseService && typeof supabaseService.supabaseRequest === 'function') {
    const res = await supabaseService.supabaseRequest(
      'pedidos',
      'GET',
      null,
      `criado_em=gte.${hojeIso}T00:00:00Z&select=*`
    );
    if (Array.isArray(res)) pedidosHoje = res;
  }

  let faturamentoTotal = 0;
  const porPagamento = { PIX: 0, CARTAO: 0, DINHEIRO: 0, OUTROS: 0 };
  const rankingCortes = new Map();

  for (const ped of pedidosHoje) {
    const itens = [
      ...(Array.isArray(ped.itens_acougue) ? ped.itens_acougue : []),
      ...(Array.isArray(ped.itens_mercearia) ? ped.itens_mercearia : []),
    ];

    let totalPedido = Number(ped.valor_final_etiqueta || ped.valor_estimado || 0);
    if (!totalPedido && itens.length > 0) {
      totalPedido = itens.reduce((acc, it) => acc + (Number(it.subtotal) || 0), 0);
    }

    faturamentoTotal += totalPedido;

    const pgtoNorm = String(ped.forma_pagamento || '').toLowerCase();
    if (pgtoNorm.includes('pix')) porPagamento.PIX += totalPedido;
    else if (pgtoNorm.includes('cart')) porPagamento.CARTAO += totalPedido;
    else if (pgtoNorm.includes('dinh')) porPagamento.DINHEIRO += totalPedido;
    else porPagamento.OUTROS += totalPedido;

    for (const it of itens) {
      const nome = it.nome || it.descricao || 'Item';
      const qtd = Number(it.quantidade) || 1;
      rankingCortes.set(nome, (rankingCortes.get(nome) || 0) + qtd);
    }
  }

  const topCortes = Array.from(rankingCortes.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([nome, qtd]) => `• *${nome}*: ${qtd}`)
    .join('\n') || '• _Sem itens registrados hoje_';

  const faltasDia = await redisService.listarFaltas();
  const blocoFaltas = faltasDia.length > 0 ? faltasDia.join(', ') : 'Nenhuma ruptura ativa';

  const relatorioTexto =
    `📊 *FECHAMENTO DE EXPEDIENTE — COISAS DA ROÇA*\n` +
    `📅 Data: *${dataFormatada} (19h30)*\n\n` +
    `> *Resumo Financeiro WhatsApp*\n` +
    `• Pedidos Finalizados: *${pedidosHoje.length}*\n` +
    `• Faturamento Estimado: *R$ ${faturamentoTotal.toFixed(2).replace('.', ',')}*\n\n` +
    `> *Por Forma de Pagamento*\n` +
    `• Pix: *R$ ${porPagamento.PIX.toFixed(2).replace('.', ',')}*\n` +
    `• Cartão: *R$ ${porPagamento.CARTAO.toFixed(2).replace('.', ',')}*\n` +
    `• Dinheiro: *R$ ${porPagamento.DINHEIRO.toFixed(2).replace('.', ',')}*\n\n` +
    `> *Top Cortes/Produtos do Dia*\n` +
    `${topCortes}\n\n` +
    `🚨 *Faltas registradas hoje:* _${blocoFaltas}_`;

  if (TELEFONE_DIOGO && whatsappAdapter?.enviarTextoUniversal) {
    await whatsappAdapter.enviarTextoUniversal(TELEFONE_DIOGO, relatorioTexto).catch((err) => {
      console.warn('[fechamentoExpedienteService] Falha ao enviar relatório no WhatsApp:', err.message);
    });
  }

  if (impressaoTermicaService?.enfileirarFitaFechamento) {
    await impressaoTermicaService
      .enfileirarFitaFechamento({
        data: dataFormatada,
        totalPedidos: pedidosHoje.length,
        faturamentoTotal,
        porPagamento,
      })
      .catch((err) => {
        console.warn('[fechamentoExpedienteService] Falha ao enfileirar fita térmica:', err.message);
      });
  }

  return {
    ok: true,
    data: dataFormatada,
    totalPedidos: pedidosHoje.length,
    faturamentoTotal,
    porPagamento,
  };
}

module.exports = { executarFechamentoExpediente };
