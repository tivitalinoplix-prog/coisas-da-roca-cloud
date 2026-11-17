/**
 * SERVIÇO DE FORMATAÇÃO E FILA DE IMPRESSÃO ESC/POS (CAIXA 1 PDV)
 * Padrão: MP-80M / RPP02N (48 Colunas, ASCII Puro Sanitizado)
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
  BEEP: `${ESC}B${String.fromCharCode(2)}${String.fromCharCode(5)}`
};

/**
 * Converte qualquer string UTF-8 acentuada para ASCII puro compatível com bobina térmica ESC/POS
 */
function sanitizarParaTermica(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove diacríticos (ã -> a, ç -> c, é -> e)
    .replace(/[•·]/g, '-')
    .replace(/[^\x20-\x7E]/g, '')    // Remove emojis e bytes fora da tabela ASCII (32-126)
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

  escpos += COMANDOS.INIT;

  // Cabeçalho Compacto Econômico de Bobina
  appendTexto('COISAS DA ROCA - MACAE/RJ', 'CENTER', true, 'DOUBLE_HEIGHT');
  appendTexto('DESDE 1993 - PAIXAO POR CARNE', 'CENTER', false, 'NORMAL');
  appendTexto('================================================', 'CENTER', false, 'NORMAL');
  appendTexto('*** COMANDA DE PREPARO (BALCAO) ***', 'CENTER', true, 'NORMAL');
  appendTexto('================================================', 'CENTER', false, 'NORMAL');

  // Dados do Cliente e Entrega Sanitizados
  appendTexto(`PEDIDO : #${pedido.pedidoId}`, 'LEFT', true, 'DOUBLE_HEIGHT');
  appendTexto(`DATA   : ${new Date().toLocaleString('pt-BR')}`, 'LEFT', false, 'NORMAL');
  appendTexto(`CLIENTE: ${pedido.clienteNome}`, 'LEFT', true, 'DOUBLE_HEIGHT');
  appendTexto(`CONTATO: ${pedido.clienteTelefone}`, 'LEFT', false, 'NORMAL');
  appendTexto(`ENTREGA: ${pedido.enderecoEntrega || 'Retirada no Balcao'}`, 'LEFT', true, 'NORMAL');
  appendTexto(`PGTO   : ${pedido.formaPagamento || 'A combinar'}`, 'LEFT', true, 'NORMAL');
  appendTexto('------------------------------------------------', 'CENTER', false, 'NORMAL');

  appendTexto(formatarLinhaDupla('CORTES / ITENS', 'QTD', 48), 'LEFT', true, 'NORMAL');
  appendTexto('------------------------------------------------', 'CENTER', false, 'NORMAL');

  (pedido.itens || []).forEach((item, idx) => {
    const desc = `${idx + 1}. ${sanitizarParaTermica(item.descricao)}`;
    const qtdStr = sanitizarParaTermica(item.quantidade || '1 un');
    appendTexto(formatarLinhaDupla(desc, qtdStr, 48), 'LEFT', true, 'DOUBLE_HEIGHT');
    if (item.preparo) {
      appendTexto(`   >> Preparo: ${sanitizarParaTermica(item.preparo)}`, 'LEFT', false, 'NORMAL');
    }
  });

  appendTexto('------------------------------------------------', 'CENTER', false, 'NORMAL');
  appendTexto('PESO REAL BALANCA / CONFERENCIA:', 'LEFT', true, 'NORMAL');
  appendTexto('[  ] Peso conferido: ____________ R$: __________', 'LEFT', false, 'NORMAL');
  appendTexto('================================================', 'CENTER', false, 'NORMAL');

  escpos += '\n\n\n';
  escpos += COMANDOS.BEEP;
  escpos += COMANDOS.CUT_FULL;

  return escpos;
}

async function enfileirarImpressaoPedido(pedido) {
  const dadosEscpos = montarComandaEscPos(pedido);
  const base64Escpos = Buffer.from(dadosEscpos, 'ascii').toString('base64');

  const res = await pool.query(`
    INSERT INTO fila_impressao (
      pedido_id, cliente_telefone, cliente_nome, tipo_comanda, 
      dados_formatados_escpos, status, criado_em, atualizado_em
    ) VALUES ($1, $2, $3, $4, $5, 'PENDENTE', NOW(), NOW())
    RETURNING id, pedido_id, status;
  `, [
    pedido.pedidoId,
    pedido.clienteTelefone,
    sanitizarParaTermica(pedido.clienteNome),
    'ACOUGUE',
    base64Escpos
  ]);

  return res.rows[0];
}

/**
 * Busca atômica com FOR UPDATE SKIP LOCKED para impedir impressão duplicada no polling do Caixa 1
 */
async function buscarProximoPedidoFila() {
  // Destrava eventuais jobs que ficaram em IMPRIMINDO há mais de 2 minutos por falha de rede local
  await pool.query(`
    UPDATE fila_impressao
    SET status = 'PENDENTE', atualizado_em = NOW()
    WHERE status = 'IMPRIMINDO'
      AND atualizado_em < NOW() - INTERVAL '2 minutes';
  `).catch(() => {});

  const res = await pool.query(`
    UPDATE fila_impressao
    SET status = 'IMPRIMINDO', atualizado_em = NOW()
    WHERE id = (
      SELECT id
      FROM fila_impressao
      WHERE status = 'PENDENTE'
      ORDER BY criado_em ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, pedido_id, cliente_nome, dados_formatados_escpos;
  `);

  return res.rows[0] || null;
}

async function confirmarImpressaoJob(id) {
  const res = await pool.query(`
    UPDATE fila_impressao 
    SET status = 'IMPRESSO', impresso_em = NOW(), atualizado_em = NOW() 
    WHERE id = $1;
  `, [id]);
  return res.rowCount > 0;
}

module.exports = {
  sanitizarParaTermica,
  montarComandaEscPos,
  enfileirarImpressaoPedido,
  buscarProximoPedidoFila,
  confirmarImpressaoJob
};
