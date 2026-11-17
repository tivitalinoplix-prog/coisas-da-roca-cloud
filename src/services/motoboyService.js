const { pool } = require('../database');
const { enviarTextoUniversal } = require('./whatsappUniversalAdapter');

const TELEFONE_MOTOBOY = process.env.TELEFONE_MOTOBOY_PROPRIO || '5522998586180';

async function enviarMensagemWhatsApp(numero, texto) {
  try {
    await enviarTextoUniversal(numero, texto);
    console.log(`📤 Mensagem WhatsApp enviada para ${numero}`);
  } catch (err) {
    console.error(`❌ Erro ao enviar WhatsApp para ${numero}:`, err.message);
  }
}

async function despacharPedidoParaMotoboy(pedido) {
  const fichaMotoboy = `🛵 *NOVA CORRIDA - COISAS DA ROÇA*\n` +
    `--------------------------------------\n` +
    `👤 *Cliente:* ${pedido.nome_cliente || 'Cliente'}\n` +
    `📞 *Telefone:* ${pedido.telefone_cliente}\n` +
    `📍 *Endereço:* ${pedido.endereco || 'Centro'}, ${pedido.bairro || 'Macaé'}\n` +
    `📦 *Volumes:* ${pedido.volumes || 1} sacola(s)\n` +
    `💰 *VALOR A COBRAR:* R$ ${Number(pedido.valor_total || 0).toFixed(2)}\n` +
    `💳 *Forma Pgto:* ${pedido.forma_pagamento || 'Maquininha'}\n` +
    `--------------------------------------\n` +
    `Obs: ${pedido.observacoes || 'Nenhuma'}`;

  await enviarMensagemWhatsApp(TELEFONE_MOTOBOY, fichaMotoboy);

  const msgCliente = `Olá, ${pedido.nome_cliente || 'Dona Maria'}! 🛵 Seu pedido foi preparado, pesado na balança e acabou de sair para entrega com nosso entregador próprio!\n\n` +
    `💰 Valor Total: R$ ${Number(pedido.valor_total || 0).toFixed(2)}\n` +
    `💳 Pagamento: ${pedido.forma_pagamento}\n\n` +
    `Logo ele chega aí. Qualquer dúvida, é só nos chamar por aqui!`;

  await enviarMensagemWhatsApp(pedido.telefone_cliente, msgCliente);

  return { success: true, status: 'DESPACHADO' };
}

module.exports = {
  enviarMensagemWhatsApp,
  despacharPedidoParaMotoboy
};
