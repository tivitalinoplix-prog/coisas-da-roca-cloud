/**
 * SERVIÇO DE IMPRESSÃO TÉRMICA ESC/POS 80mm (MP-80M)
 * Açougue e Mercearia Coisas da Roça
 * 
 * Gera comandas físicas de 48 colunas para a ilha de corte dos açougueiros.
 * Suporta: Bluetooth Virtual COM (SPP) e USB Direto.
 */

const fs = require('fs');

// Comandos ESC/POS Padrão
const ESC = '\x1B';
const GS = '\x1D';

const CMD = {
  RESET: `${ESC}@`,
  ALIGN_LEFT: `${ESC}a\x00`,
  ALIGN_CENTER: `${ESC}a\x01`,
  ALIGN_RIGHT: `${ESC}a\x02`,
  BOLD_ON: `${ESC}E\x01`,
  BOLD_OFF: `${ESC}E\x00`,
  DOUBLE_ON: `${GS}!\x11`, // Dupla altura e largura
  DOUBLE_OFF: `${GS}!\x00`,
  LINE_FEED: '\n',
  CUT_PARTIAL: `${GS}V\x01`,
  CUT_FULL: `${GS}V\x00`
};

/**
 * Monta o layout da comanda de corte física de 80mm
 */
function gerarBufferComandaCorte({ idPedido, clienteNome, clienteTelefone, itens, tipoEntrega, formaPagamento, observacoes }) {
  const dataHora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const divisor = '------------------------------------------------\n';

  let txt = '';
  txt += CMD.RESET;
  
  // Cabeçalho Centralizado
  txt += CMD.ALIGN_CENTER;
  txt += CMD.BOLD_ON + CMD.DOUBLE_ON;
  txt += 'COISAS DA ROCA\n';
  txt += CMD.DOUBLE_OFF;
  txt += 'Acougue e Mercearia - Desde 1993\n';
  txt += 'Macaé / RJ - WhatsApp Oficial\n';
  txt += CMD.BOLD_OFF;
  txt += divisor;

  // Identificação da Comanda
  txt += CMD.BOLD_ON;
  txt += `COMANDA DE BALCAO / CORTE #${idPedido || 'NOVO'}\n`;
  txt += CMD.BOLD_OFF;
  txt += `Emissao: ${dataHora}\n`;
  txt += divisor;

  // Dados do Cliente
  txt += CMD.ALIGN_LEFT;
  txt += `Cliente : ${clienteNome || 'Cliente WhatsApp'}\n`;
  txt += `Contato : ${clienteTelefone || '-'}\n`;
  txt += `Destino : ${tipoEntrega || 'Retirada no Balcão'}\n`;
  if (formaPagamento) txt += `Pgto    : ${formaPagamento}\n`;
  txt += divisor;

  // Título dos Cortes
  txt += CMD.ALIGN_CENTER + CMD.BOLD_ON;
  txt += 'ITENS E CORTES SOLICITADOS\n';
  txt += CMD.ALIGN_LEFT + CMD.BOLD_OFF;
  txt += divisor;

  // Lista de Itens detalhada para o açougueiro
  if (Array.isArray(itens) && itens.length > 0) {
    itens.forEach((it, idx) => {
      txt += CMD.BOLD_ON;
      txt += `[${idx + 1}] ${it.produto || it.descricao}\n`;
      txt += CMD.BOLD_OFF;
      txt += `    Qtd / Peso : ${it.qtd || it.quantidade || 'A definir'}\n`;
      if (it.corte) txt += `    Preparo    : >>> ${it.corte} <<<\n`;
      if (it.embalagem) txt += `    Embalagem  : ${it.embalagem}\n`;
      txt += `    Conferido  : [   ] Balança: _____ kg\n`;
      txt += '\n';
    });
  } else {
    txt += `${observacoes || 'Verificar detalhes da conversa no WhatsApp'}\n\n`;
  }

  txt += divisor;
  txt += CMD.ALIGN_CENTER;
  txt += 'CONFERENCIA FINAL DO BALCAO\n';
  txt += 'Assinatura Acougueiro: ________________________\n\n';
  txt += 'Obrigado pela preferencia! ACR Paixao por Carne\n';
  txt += '\n\n\n\n'; // Avanço de papel
  txt += CMD.CUT_PARTIAL;

  return Buffer.from(txt, 'binary');
}

module.exports = {
  gerarBufferComandaCorte,
  CMD
};
