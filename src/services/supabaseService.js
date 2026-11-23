/**
 * ============================================================
 * COISAS DA ROÇA - SERVIÇO DE BANCO DE DADOS SUPABASE (POSTGRESQL)
 * ============================================================
 * Conexão direta via PostgreSQL (DATABASE_URL) com pool de alta resiliência.
 * Elimina 100% a dependência de SUPABASE_ANON_KEY e chamadas REST lentas.
 * ============================================================
 */

const { pool } = require('../database');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

/**
 * Registra ou atualiza um cliente no Supabase (PostgreSQL direto).
 */
async function upsertCliente({ telefone, nome, bairro }) {
  if (!telefone) return null;
  const cleanPhone = String(telefone).replace(/[^0-9]/g, '');
  const telFormatado = cleanPhone || String(telefone).trim();
  const nomeSeguro = (nome && nome.trim() && nome.trim() !== 'Cliente') ? nome.trim() : null;
  const bairroSeguro = bairro && bairro.trim() ? bairro.trim() : null;

  try {
    const res = await pool.query(
      `INSERT INTO clientes (telefone, nome, bairro, ultima_compra, opt_out)
       VALUES ($1, $2, $3, NOW(), false)
       ON CONFLICT (telefone) 
       DO UPDATE SET 
         nome = COALESCE(EXCLUDED.nome, clientes.nome),
         bairro = COALESCE(EXCLUDED.bairro, clientes.bairro),
         ultima_compra = NOW()
       RETURNING *;`,
      [telFormatado, nomeSeguro, bairroSeguro]
    );
    return res.rows[0];
  } catch (err) {
    console.error('[Supabase PostgreSQL] Erro em upsertCliente:', err.message);
    return null;
  }
}

/**
 * Registra um novo pedido no Supabase (PostgreSQL direto).
 */
async function registrarPedido({ clienteTelefone, itensAcougue, itensMercearia, formaPagamento, respostaIA, valorEstimado }) {
  if (!clienteTelefone) return null;
  try {
    const res = await pool.query(
      `INSERT INTO pedidos (
         cliente_telefone, itens_acougue, itens_mercearia,
         valor_estimado, forma_pagamento, resposta_ia,
         status, criado_em
       ) VALUES ($1, $2, $3, $4, $5, $6, 'RECEBIDO', NOW())
       RETURNING *;`,
      [
        String(clienteTelefone).trim(),
        JSON.stringify(itensAcougue || []),
        JSON.stringify(itensMercearia || []),
        valorEstimado ? Number(valorEstimado) : null,
        formaPagamento || 'A combinar',
        respostaIA || ''
      ]
    );
    return res.rows[0];
  } catch (err) {
    console.error('[Supabase PostgreSQL] Erro em registrarPedido:', err.message);
    return null;
  }
}

/**
 * Registra interação de conversa para histórico e auditoria (PostgreSQL direto).
 */
async function registrarConversa({ clienteTelefone, nomeCliente, mensagemCliente, tipoMensagem, respostaIA, tempoRespostaMs }) {
  if (!clienteTelefone) return null;
  try {
    const res = await pool.query(
      `INSERT INTO conversas (
         cliente_telefone, nome_cliente, mensagem_cliente,
         tipo_mensagem, resposta_ia, tempo_resposta_ms, criado_em
       ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING id;`,
      [
        String(clienteTelefone).trim(),
        nomeCliente || 'Cliente',
        mensagemCliente || '',
        tipoMensagem || 'texto',
        respostaIA || '',
        tempoRespostaMs || 0
      ]
    );
    return res.rows[0];
  } catch (err) {
    console.error('[Supabase PostgreSQL] Erro em registrarConversa:', err.message);
    return null;
  }
}

/**
 * Verifica se o cliente deu opt-out (pediu para parar).
 */
async function isClienteOptOut(telefone) {
  if (!telefone) return false;
  const cleanPhone = String(telefone).replace(/[^0-9]/g, '');
  try {
    const res = await pool.query(
      `SELECT opt_out FROM clientes WHERE telefone = $1 LIMIT 1;`,
      [cleanPhone]
    );
    return res.rows[0]?.opt_out === true;
  } catch (err) {
    console.error('[Supabase PostgreSQL] Erro em isClienteOptOut:', err.message);
    return false;
  }
}

/**
 * Marca opt-out para o cliente.
 */
async function marcarOptOut(telefone) {
  if (!telefone) return false;
  const cleanPhone = String(telefone).replace(/[^0-9]/g, '');
  try {
    await pool.query(
      `UPDATE clientes SET opt_out = true WHERE telefone = $1;`,
      [cleanPhone]
    );
    return true;
  } catch (err) {
    console.error('[Supabase PostgreSQL] Erro em marcarOptOut:', err.message);
    return false;
  }
}

/**
 * Busca pedidos recentes de um cliente.
 */
async function buscarPedidosRecentes(telefone, limite = 5) {
  if (!telefone) return [];
  const cleanPhone = String(telefone).replace(/[^0-9]/g, '');
  try {
    const res = await pool.query(
      `SELECT * FROM pedidos 
       WHERE cliente_telefone = $1 
       ORDER BY criado_em DESC 
       LIMIT $2;`,
      [cleanPhone, limite]
    );
    return res.rows;
  } catch (err) {
    console.error('[Supabase PostgreSQL] Erro em buscarPedidosRecentes:', err.message);
    return [];
  }
}

/**
 * Adaptador de compatibilidade para chamadas genéricas legadas (supabaseRequest).
 * Mapeia tabelas comuns diretamente para SQL de alta performance.
 */
async function supabaseRequest(tableName, method = 'GET', body = null, queryParams = '') {
  const table = String(tableName || '').toLowerCase().trim();
  const metodo = String(method || 'GET').toUpperCase();

  try {
    if (metodo === 'GET') {
      if (table === 'clientes') {
        const matchTel = queryParams.match(/telefone=eq\.([^&]+)/);
        if (matchTel) {
          const tel = matchTel[1].replace(/[^0-9]/g, '');
          const res = await pool.query('SELECT * FROM clientes WHERE telefone = $1 LIMIT 1', [tel]);
          return res.rows;
        }
        const res = await pool.query('SELECT * FROM clientes ORDER BY ultima_compra DESC LIMIT 50');
        return res.rows;
      }

      if (table === 'pedidos') {
        const matchData = queryParams.match(/criado_em=gte\.([^&]+)/);
        if (matchData) {
          const dataFiltro = decodeURIComponent(matchData[1]);
          const res = await pool.query('SELECT * FROM pedidos WHERE criado_em >= $1 ORDER BY criado_em DESC', [dataFiltro]);
          return res.rows;
        }
        const matchTel = queryParams.match(/cliente_telefone=eq\.([^&]+)/);
        if (matchTel) {
          const tel = matchTel[1].replace(/[^0-9]/g, '');
          const res = await pool.query('SELECT * FROM pedidos WHERE cliente_telefone = $1 ORDER BY criado_em DESC LIMIT 20', [tel]);
          return res.rows;
        }
        const res = await pool.query('SELECT * FROM pedidos ORDER BY criado_em DESC LIMIT 50');
        return res.rows;
      }
    }

    if (metodo === 'POST' && body) {
      if (table === 'clientes') {
        const row = await upsertCliente(body);
        return row ? [row] : null;
      }
      if (table === 'pedidos') {
        const row = await registrarPedido(body);
        return row ? [row] : null;
      }
      if (table === 'conversas') {
        const row = await registrarConversa(body);
        return row ? [row] : null;
      }
    }
  } catch (err) {
    console.error(`[Supabase PostgreSQL] Erro em supabaseRequest (${table}):`, err.message);
  }

  // Fallback REST apenas se credenciais explícitas existirem
  const authKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (SUPABASE_URL && authKey) {
    const url = `${SUPABASE_URL}/rest/v1/${tableName}${queryParams ? '?' + queryParams : ''}`;
    const headers = {
      'apikey': authKey,
      'Authorization': `Bearer ${authKey}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
    };
    try {
      const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      if (!res.ok) return null;
      if (method === 'DELETE' || res.status === 204) return { success: true };
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  return null;
}

module.exports = {
  supabaseRequest,
  upsertCliente,
  registrarPedido,
  registrarConversa,
  isClienteOptOut,
  marcarOptOut,
  buscarPedidosRecentes,
  SUPABASE_URL,
  SUPABASE_ANON_KEY
};
