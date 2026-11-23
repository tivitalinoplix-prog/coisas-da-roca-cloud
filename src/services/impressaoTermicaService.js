/**
 * SERVIÇO DE FORMATAÇÃO E FILA DE IMPRESSÃO ESC/POS (CAIXA 1 PDV)
 * Padrão: MP-80M / Bematech 80mm (48 Colunas, ASCII Puro Sanitizado)
 * Emite 2 vias por pedido (Via 1: Bancada de Corte em DOUBLE_HEIGHT+BOLD | Via 2: Caixa/Entrega)
 */

const { pool } = require('../database');

const ESC = '\x1B';
const GS = '\x1D';

const COMANDOS = {
  INIT: `${ESC}@`,
  TEXT_NORMAL: `${ESC}!${String.fromCharCode(0)}`,
  TEXT_BOLD: `${ESC}E${String.fromCharCode(1)}`,
  TEXT_NO_BOLD: `${ESC}E${String.fromCharCode(0)}`,
  DOUBLE_HEIGHT: `${ESC}!${String.fromCharCode(16)}`,
  DOUBLE_WIDTH: `${ESC}!${String.fromCharCode(32)}`,
  DOUBLE_BOTH: `${ESC}!${String.fromCharCode(48)}`,
  ALIGN_LEFT: `${ESC}a${String.fromCharCode(0)}`,
  ALIGN_CENTER: `${ESC}a${String.fromCharCode(1)}`,
  ALIGN_RIGHT: `${ESC}a${String.fromCharCode(2)}`,
  CUT_FULL: `${GS}V${String.fromCharCode(0)}`,
  CUT_PARTIAL: `${GS}V${String.fromCharCode(1)}`,
  BEEP: `${ESC}B${String.fromCharCode(2)}${String.fromCharCode(5)}`,
};

function sanitizarParaTermica(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[•·]/g, '-')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

function formatarLinhaDupla(colunaEsquerda, colunaDireita, larguraMaxima = 48) {
  const dir = sanitizarParaTermica(colunaDireita);
  const maxEsq = Math.max(10, larguraMaxima - dir.length - 2);
  let esq = sanitizarParaTermica(colunaEsquerda);
  if (esq.length > maxEsq) {
    esq = esq.substring(0, maxEsq);
  }
  const espacos = Math.max(1, larguraMaxima - esq.length - dir.length);
  return `${esq}${' '.repeat(espacos)}${dir}`;
}

function montarComandaEscPos(pedido) {
  let escpos = '';
  const appendTexto = (txt, align = 'LEFT', bold = false, size = 'NORMAL') => {
    if (align === 'CENTER') escpos += COMANDOS.ALIGN_CENTER;
    else if (align === 'RIGHT') escpos += COMANDOS.ALIGN_RIGHT;
    else escpos += COMANDOS.ALIGN_LEFT;

    if (size === 'DOUBLE_HEIGHT') escpos += COMANDOS.DOUBLE_HEIGHT;
    else if (size === 'DOUBLE_BOTH') escpos += COMANDOS.DOUBLE_BOTH;
    else escpos += COMANDOS.TEXT_NORMAL;

    if (bold) escpos += COMANDOS.TEXT_BOLD;
    else escpos += COMANDOS.TEXT_NO_BOLD;

    escpos += `${sanitizarParaTermica(txt)}\n`;
  };

  const dataHora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  escpos += COMANDOS.INIT;

  // =========================================================================
  // VIA ÚNICA: CAIXA / BALCÃO / EXPEDIÇÃO (ÁREA LIVRE DE ESCRITA)
  // =========================================================================
  appendTexto('COISAS DA ROCA - PEDIDO WHATSAPP', 'CENTER', true, 'DOUBLE_HEIGHT');
  appendTexto('================================================', 'CENTER', false, 'NORMAL');
  appendTexto(`PEDIDO : #${pedido.pedidoId}`, 'LEFT', true, 'DOUBLE_HEIGHT');
  appendTexto(`DATA   : ${dataHora}`, 'LEFT', false, 'NORMAL');
  appendTexto(`CLIENTE: ${pedido.clienteNome}`, 'LEFT', true, 'DOUBLE_HEIGHT');
  if (pedido.clienteTelefone) {
    appendTexto(`CONTATO: ${pedido.clienteTelefone}`, 'LEFT', false, 'NORMAL');
  }
  appendTexto(`ENTREGA: ${pedido.enderecoEntrega || 'Retirada no Balcao'}`, 'LEFT', true, 'NORMAL');
  appendTexto(`PGTO   : ${pedido.formaPagamento || 'A combinar'}`, 'LEFT', true, 'DOUBLE_HEIGHT');
  appendTexto('------------------------------------------------', 'CENTER', false, 'NORMAL');

  const temItemPesavel = (pedido.itens || []).some(i => {
    const d = (i.descricao || '').toLowerCase();
    const q = (i.quantidade || '').toLowerCase();
    return q.includes('kg') || /(carne|bife|moida|moída|alcatra|contra|frango|linguica|linguiça|costela|picanha|bovino|suino|suíno)/i.test(d);
  });

  (pedido.itens || []).forEach((item, idx) => {
    const desc = `${idx + 1}. ${sanitizarParaTermica(item.descricao)}`;
    const qtdStr = sanitizarParaTermica(item.quantidade || '1 un');
    appendTexto(formatarLinhaDupla(desc, qtdStr, 48), 'LEFT', true, 'NORMAL');
    if (item.preparo) {
      const isCarne = /(carne|bife|moida|moída|alcatra|contra|frango|linguica|linguiça|costela|picanha|bovino|suino|suíno)/i.test(item.descricao || '') ||
                      /(bife|moer|cortar|limpar|iscas|picadinho|cubos|peca|peça)/i.test(item.preparo || '');
      const rotulo = isCarne ? '>> CORTE/OBS:' : '>> OBS:';
      appendTexto(`   ${rotulo} ${sanitizarParaTermica(item.preparo)}`, 'LEFT', true, 'NORMAL');
    }
  });

  appendTexto('------------------------------------------------', 'CENTER', false, 'NORMAL');
  if (temItemPesavel) {
    appendTexto('PESO REAL: _______________  VALOR R$: __________', 'LEFT', true, 'NORMAL');
    appendTexto('', 'LEFT', false, 'NORMAL');
  }
  appendTexto('ANOTACOES LIVRES:', 'LEFT', true, 'NORMAL');
  appendTexto('________________________________________________', 'LEFT', false, 'NORMAL');
  appendTexto('', 'LEFT', false, 'NORMAL');
  appendTexto('________________________________________________', 'LEFT', false, 'NORMAL');
  appendTexto('', 'LEFT', false, 'NORMAL');
  appendTexto('________________________________________________', 'LEFT', false, 'NORMAL');
  appendTexto('================================================', 'CENTER', false, 'NORMAL');

  escpos += '\n\n\n';
  escpos += COMANDOS.BEEP;
  escpos += COMANDOS.CUT_FULL;

  return escpos;
}

function montarFitaFechamentoEscPos(resumo) {
  let escpos = COMANDOS.INIT;
  const append = (txt, align = 'LEFT', bold = false, size = 'NORMAL') => {
    escpos += align === 'CENTER' ? COMANDOS.ALIGN_CENTER : COMANDOS.ALIGN_LEFT;
    escpos += size === 'DOUBLE_HEIGHT' ? COMANDOS.DOUBLE_HEIGHT : COMANDOS.TEXT_NORMAL;
    escpos += bold ? COMANDOS.TEXT_BOLD : COMANDOS.TEXT_NO_BOLD;
    escpos += `${sanitizarParaTermica(txt)}\n`;
  };

  append('COISAS DA ROCA - FECHAMENTO DO DIA', 'CENTER', true, 'DOUBLE_HEIGHT');
  append(`DATA: ${resumo.data || new Date().toLocaleDateString('pt-BR')}`, 'CENTER', false, 'NORMAL');
  append('================================================', 'CENTER', false, 'NORMAL');
  append(formatarLinhaDupla('TOTAL DE PEDIDOS WHATSAPP:', String(resumo.totalPedidos || 0)), 'LEFT', true, 'DOUBLE_HEIGHT');
  append(formatarLinhaDupla('FATURAMENTO ESTIMADO:', `R$ ${Number(resumo.faturamentoTotal || 0).toFixed(2)}`), 'LEFT', true, 'DOUBLE_HEIGHT');
  append('------------------------------------------------', 'CENTER', false, 'NORMAL');
  append('DIVISAO POR PAGAMENTO:', 'LEFT', true, 'NORMAL');
  append(formatarLinhaDupla('- Pix:', `R$ ${Number(resumo.porPagamento?.PIX || 0).toFixed(2)}`), 'LEFT', false, 'NORMAL');
  append(formatarLinhaDupla('- Cartao:', `R$ ${Number(resumo.porPagamento?.CARTAO || 0).toFixed(2)}`), 'LEFT', false, 'NORMAL');
  append(formatarLinhaDupla('- Dinheiro:', `R$ ${Number(resumo.porPagamento?.DINHEIRO || 0).toFixed(2)}`), 'LEFT', false, 'NORMAL');
  append('================================================', 'CENTER', false, 'NORMAL');
  escpos += '\n\n\n' + COMANDOS.CUT_FULL;
  return escpos;
}

async function enfileirarImpressaoPedido(pedido) {
  const dadosEscpos = montarComandaEscPos(pedido);
  const base64Escpos = Buffer.from(dadosEscpos, 'ascii').toString('base64');

  const res = await pool.query(
    `INSERT INTO fila_impressao (
      pedido_id, cliente_telefone, cliente_nome, tipo_comanda,
      dados_formatados_escpos, status, criado_em, atualizado_em
    ) VALUES ($1, $2, $3, $4, $5, 'PENDENTE', NOW(), NOW())
    RETURNING id, pedido_id, status;`,
    [
      pedido.pedidoId,
      pedido.clienteTelefone,
      sanitizarParaTermica(pedido.clienteNome),
      'ACOUGUE',
      base64Escpos,
    ]
  );

  return res.rows[0];
}

async function enfileirarFitaFechamento(resumo) {
  const dadosEscpos = montarFitaFechamentoEscPos(resumo);
  const base64Escpos = Buffer.from(dadosEscpos, 'ascii').toString('base64');

  const res = await pool.query(
    `INSERT INTO fila_impressao (
      pedido_id, cliente_telefone, cliente_nome, tipo_comanda,
      dados_formatados_escpos, status, criado_em, atualizado_em
    ) VALUES ($1, $2, $3, 'FECHAMENTO', $4, 'PENDENTE', NOW(), NOW())
    RETURNING id, pedido_id, status;`,
    [
      `FECH-${new Date().toISOString().slice(0, 10)}`,
      'LOJA',
      'FECHAMENTO EXPEDIENTE 19H30',
      base64Escpos,
    ]
  );

  return res.rows[0];
}

async function buscarProximoPedidoFila() {
  await pool
    .query(
      `UPDATE fila_impressao
       SET status = 'PENDENTE', atualizado_em = NOW()
       WHERE status = 'IMPRIMINDO'
         AND atualizado_em < NOW() - INTERVAL '2 minutes';`
    )
    .catch(() => {});

  const res = await pool.query(
    `UPDATE fila_impressao
     SET status = 'IMPRIMINDO', atualizado_em = NOW()
     WHERE id = (
       SELECT id
       FROM fila_impressao
       WHERE status = 'PENDENTE'
       ORDER BY criado_em ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, pedido_id, cliente_nome, dados_formatados_escpos;`
  );

  return res.rows[0] || null;
}

async function confirmarImpressaoJob(id) {
  const res = await pool.query(
    `UPDATE fila_impressao
     SET status = 'IMPRESSO', impresso_em = NOW(), atualizado_em = NOW()
     WHERE id = $1
     RETURNING id, pedido_id, cliente_nome, cliente_telefone, status;`,
    [id]
  );
  return res.rows[0] || null;
}

module.exports = {
  sanitizarParaTermica,
  montarComandaEscPos,
  montarFitaFechamentoEscPos,
  enfileirarImpressaoPedido,
  enfileirarFitaFechamento,
  buscarProximoPedidoFila,
  confirmarImpressaoJob,
};
