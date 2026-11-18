/**
 * ============================================================
 * COISAS DA ROÇA - SERVIÇO DE BANCO DE DADOS SUPABASE
 * ============================================================
 * Substitui o PostgreSQL local por Supabase (plano gratuito) na conta do Diogo.
 * 
 * SETUP RÁPIDO:
 * 1. Acessar https://supabase.com com a conta Gmail do Diogo
 * 2. Criar projeto "coisas-da-roca" (região São Paulo)
 * 3. Copiar a SUPABASE_URL e SUPABASE_ANON_KEY do dashboard
 * 4. Colocar no .env
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// Usa a service key se disponível, senão anon key
const AUTH_KEY = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;

/**
 * Wrapper minimalista para chamadas REST do Supabase (sem SDK externo).
 * O Supabase expõe uma API REST via PostgREST, então basta fetch.
 */
async function supabaseRequest(tableName, method = 'GET', body = null, queryParams = '') {
  if (!SUPABASE_URL || !AUTH_KEY) {
    console.warn('[Supabase] ⚠️ Credenciais não configuradas. Operando em modo offline (store.json local).');
    return null;
  }

  const url = `${SUPABASE_URL}/rest/v1/${tableName}${queryParams ? '?' + queryParams : ''}`;
  const headers = {
    'apikey': AUTH_KEY,
    'Authorization': `Bearer ${AUTH_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
  };

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Supabase] Erro ${method} ${tableName}:`, res.status, errText);
      return null;
    }

    if (method === 'DELETE' || res.status === 204) return { success: true };
    return await res.json();
  } catch (err) {
    console.error(`[Supabase] Erro de rede em ${method} ${tableName}:`, err.message);
    return null;
  }
}

// ============================================================
// FUNÇÕES DE NEGÓCIO
// ============================================================

/**
 * Registra ou atualiza um cliente no Supabase.
 */
async function upsertCliente({ telefone, nome, bairro }) {
  return supabaseRequest('clientes', 'POST', {
    telefone,
    nome: nome || null,
    bairro: bairro || null,
    ultima_compra: new Date().toISOString(),
    opt_out: false
  }, 'on_conflict=telefone');
}

/**
 * Registra um novo pedido vindo da IA de atendimento.
 */
async function registrarPedido({ clienteTelefone, itensAcougue, itensMercearia, formaPagamento, respostaIA }) {
  return supabaseRequest('pedidos', 'POST', {
    cliente_telefone: clienteTelefone,
    itens_acougue: itensAcougue || [],
    itens_mercearia: itensMercearia || [],
    forma_pagamento: formaPagamento || 'A combinar',
    resposta_ia: respostaIA || '',
    status: 'RECEBIDO',
    criado_em: new Date().toISOString()
  });
}

/**
 * Registra cada interação de conversa para histórico e treinamento futuro da IA.
 */
async function registrarConversa({ clienteTelefone, nomeCliente, mensagemCliente, tipoMensagem, respostaIA, tempoRespostaMs }) {
  return supabaseRequest('conversas', 'POST', {
    cliente_telefone: clienteTelefone,
    nome_cliente: nomeCliente || null,
    mensagem_cliente: mensagemCliente || '',
    tipo_mensagem: tipoMensagem || 'texto',
    resposta_ia: respostaIA || '',
    tempo_resposta_ms: tempoRespostaMs || 0,
    criado_em: new Date().toISOString()
  });
}

/**
 * Verifica se o cliente deu opt-out (pediu para parar).
 */
async function isClienteOptOut(telefone) {
  const result = await supabaseRequest('clientes', 'GET', null, `telefone=eq.${telefone}&select=opt_out`);
  if (result && result.length > 0) {
    return result[0].opt_out === true;
  }
  return false;
}

/**
 * Marca opt-out para o cliente.
 */
async function marcarOptOut(telefone) {
  return supabaseRequest('clientes', 'PATCH', { opt_out: true }, `telefone=eq.${telefone}`);
}

/**
 * Busca pedidos recentes de um cliente.
 */
async function buscarPedidosRecentes(telefone, limite = 5) {
  return supabaseRequest('pedidos', 'GET', null, `cliente_telefone=eq.${telefone}&order=criado_em.desc&limit=${limite}`);
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
