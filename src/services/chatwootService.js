const { pool } = require('../database');

const CHATWOOT_URL = process.env.CHATWOOT_URL || 'http://localhost:3000';
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN || process.env.CHATWOOT_SECRET_KEY;
const ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || 1;

function formatarComandaBalcao(pedido) {
  let texto = `🥩 ========================================\n`;
  texto += `   COMANDA DE CORTE - COISAS DA ROÇA\n`;
  texto += `========================================\n`;
  texto += `👤 Cliente: ${pedido.cliente_telefone || 'Balcão'}\n`;
  texto += `📍 Bairro: ${pedido.bairro_macae || 'Macaé'} | Pgto: ${pedido.forma_pagamento || 'A combinar'}\n`;
  texto += `----------------------------------------\n`;

  if (pedido.itens_acougue && pedido.itens_acougue.length > 0) {
    texto += `📋 ITENS DO AÇOUGUE (Câmara/Balcão):\n`;
    for (const item of pedido.itens_acougue) {
      const saq = item.quantidade_saquinhos ? ` (Fracionar em ${item.quantidade_saquinhos} saquinhos)` : '';
      const corte = item.especificacao_corte ? ` [${item.especificacao_corte}]` : '';
      texto += `• [ ] ${item.peso_total_estimado_gramas || 0}g ${item.produto}${saq}${corte}\n`;
    }
  }

  if (pedido.itens_mercearia && pedido.itens_mercearia.length > 0) {
    texto += `\n🥫 ITENS DE MERCEARIA (Prateleira):\n`;
    for (const item of pedido.itens_mercearia) {
      texto += `• [ ] ${item.unidades || 1} un ${item.produto}\n`;
    }
  }

  if (pedido.observacoes) {
    texto += `\nObs: ${pedido.observacoes}\n`;
  }
  texto += `========================================\n`;
  texto += `Status: Aguardando Pesagem Toledo Prix 4 (MGV5)`;
  return texto;
}

async function enviarNotaPrivadaChatwoot(conversationId, conteudoTexto) {
  if (!conversationId || !CHATWOOT_API_TOKEN) return;
  try {
    const url = `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversationId}/messages`;
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api_access_token': CHATWOOT_API_TOKEN
      },
      body: JSON.stringify({ content: conteudoTexto, private: true })
    });
    console.log(`✅ Nota privada injetada no Chatwoot (conversa ${conversationId})`);
  } catch (err) {
    console.error('Falha silenciosa Chatwoot:', err.message);
  }
}

async function processarComandoRuptura(comando, conversationId) {
  console.log('Comando de ruptura:', comando);
}

module.exports = {
  formatarComandaBalcao,
  enviarNotaPrivadaChatwoot,
  processarComandoRuptura
};
