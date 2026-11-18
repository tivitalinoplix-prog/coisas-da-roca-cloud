/**
 * CAMADA DE PERSISTÊNCIA E POOL DE CONEXÕES SUPABASE (POSTGRESQL)
 * Configurado para alta resiliência em Arquitetura Frugal Node.js
 * Suporta Pooler Supabase (porta 6543 Transaction / 5432 Session)
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: parseInt(process.env.DB_POOL_MAX || '10', 10),
  min: 1,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000
});

// Impede que quedas momentâneas de rede com o Supabase derrubem o processo Node.js
pool.on('error', (err) => {
  console.error('⚠️ [PostgreSQL Pool] Erro inesperado em cliente ocioso:', err.message);
});

async function upsertCliente({ telefone, nome }) {
  if (!telefone) return;
  const cleanPhone = String(telefone).replace(/[^0-9]/g, '');
  const telefoneFormatado = cleanPhone || String(telefone).trim();
  const nomeSeguro = (nome && nome.trim() && nome.trim() !== 'Cliente') ? nome.trim() : 'Cliente';

  try {
    await pool.query(
      `INSERT INTO clientes (telefone, nome, ultima_compra)
       VALUES ($1, $2, NOW())
       ON CONFLICT (telefone) 
       DO UPDATE SET 
         nome = CASE 
                  WHEN EXCLUDED.nome IS NOT NULL AND EXCLUDED.nome <> 'Cliente' THEN EXCLUDED.nome 
                  ELSE clientes.nome 
                END,
         ultima_compra = NOW()`,
      [telefoneFormatado, nomeSeguro]
    );
  } catch (err) {
    console.error('Erro em upsertCliente:', err.message);
  }
}

async function registrarConversa({ clienteTelefone, nomeCliente, mensagemCliente, tipoMensagem, respostaIA, tempoMs, tempoRespostaMs }) {
  if (!clienteTelefone) return;
  const duracao = tempoRespostaMs || tempoMs || 0;
  try {
    await pool.query(
      `INSERT INTO conversas (
         cliente_telefone, nome_cliente, mensagem_cliente, 
         tipo_mensagem, resposta_ia, tempo_resposta_ms, criado_em
       ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        String(clienteTelefone).trim(),
        nomeCliente || 'Cliente',
        mensagemCliente || '',
        tipoMensagem || 'texto',
        respostaIA || '',
        duracao
      ]
    );
  } catch (err) {
    console.error('Erro em registrarConversa:', err.message);
  }
}

module.exports = {
  pool,
  upsertCliente,
  registrarConversa
};
