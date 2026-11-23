/**
 * ============================================================
 * COISAS DA ROÇA - MÓDULO DE ATENDIMENTO AUTOMÁTICO
 * ============================================================
 * Integra-se ao whatsapp-operator (Baileys) como middleware.
 * Recebe mensagens de clientes, processa com Gemini 2.5 Flash,
 * e responde automaticamente pelo WhatsApp com delay humanizado.
 * 
 * Grava toda conversa no Supabase para histórico e treinamento.
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIGURAÇÃO
// ============================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-3.5-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// Controle de sessões (previne respostas duplicadas e gerencia pausa humana)
const sessoesAtivas = new Map(); // jid -> { pausadoAte, ultimaResposta, contadorSemResposta }

// JIDs que NUNCA devem receber resposta automática (grupos, status, o próprio número)
const JID_IGNORADOS = new Set();

// Número próprio da instância (preenchido ao conectar)
let meuNumeroJid = null;

// ============================================================
// TABELA DE FRETE (carregada localmente)
// ============================================================
let tabelaFrete = {};
try {
  const p = path.join(__dirname, '..', '..', 'config', 'bairros_macae_frete.json');
  if (fs.existsSync(p)) tabelaFrete = JSON.parse(fs.readFileSync(p, 'utf-8'));
} catch (e) {}

// ============================================================
// SUPABASE REST (sem SDK - zero dependências)
// ============================================================
async function supaREST(table, method = 'GET', body = null, qs = '') {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  const url = `${SUPABASE_URL}/rest/v1/${table}${qs ? '?' + qs : ''}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      const t = await res.text();
      console.error(`[Supabase] ${method} ${table}: ${res.status} ${t}`);
      return null;
    }
    if (res.status === 204) return { ok: true };
    return res.json();
  } catch (e) {
    console.error(`[Supabase] Erro rede ${table}:`, e.message);
    return null;
  }
}

// ============================================================
// PROMPT DO GEMINI
// ============================================================
function buildPrompt(mensagem, tipo, nomeCliente) {
  const bairros = Object.keys(tabelaFrete?.bairros || {}).slice(0, 12).join(', ');
  const saudacao = nomeCliente ? `O(a) cliente se chama ${nomeCliente}.` : '';

  return `Você é a atendente virtual acolhedora do Açougue e Mercearia Coisas da Roça em Macaé/RJ.
${saudacao}

Mensagem recebida (${tipo}): "${mensagem}"

REGRAS OBRIGATÓRIAS:
1. Tom acolhedor de balcão de bairro. Fale como atendente real de Macaé. Emojis comedidos (🥩😊👍). Nada de listas ou bullets.
2. Se o cliente mandou áudio, confirme: "Ouvi seu áudio direitinho!"
3. PERGUNTAS DE CORTE (sempre fazer se pedir carne):
   - Carne moída → moída 1 ou 2 vezes? Saquinhos de 500g ou 1kg?
   - Bife → fininho pro dia a dia ou espessura média?
   - Carne de panela → já cortada em cubos?
4. BALANÇA TOLEDO (sempre mencionar se pedir carne por kg):
   "A carne é fatiada e pesada fresquinha na nossa balança aqui no balcão, então o peso exato e valor final a gente confirma pra você assim que pesar, tá bom?"
5. Se perguntar de entrega, pergunte o bairro em Macaé. Bairros: ${bairros}
6. Se perguntar preço e você não souber, diga que vai confirmar com o balcão rapidinho.
7. Frases curtas, no máximo 4-5 frases. Nunca robótico.
8. Se a mensagem for só "oi", "bom dia", "boa tarde" → cumprimente e pergunte o que vai precisar hoje.
9. Se não entender a mensagem, peça pra repetir com carinho.

Responda direto o texto para WhatsApp:`;
}

// ============================================================
// CHAMADA AO GEMINI
// ============================================================
async function chamarGemini(mensagem, tipo, nomeCliente, base64Audio = null) {
  if (!GEMINI_API_KEY) {
    return 'Olá! Recebemos sua mensagem no Coisas da Roça! Nossa equipe já vai te atender com todo carinho 🥩😊';
  }

  const url = `${GEMINI_ENDPOINT}?key=${GEMINI_API_KEY}`;
  let contents;

  if (base64Audio) {
    contents = [{
      parts: [
        { text: buildPrompt('[ÁUDIO DO CLIENTE]', 'áudio', nomeCliente) },
        { inline_data: { mime_type: 'audio/ogg', data: base64Audio } }
      ]
    }];
  } else {
    contents = [{
      parts: [{ text: buildPrompt(mensagem, 'texto', nomeCliente) }]
    }];
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 1024,
          thinkingConfig: { thinkingBudget: 0 }
        }
      })
    });

    if (!res.ok) {
      const t = await res.text();
      console.error('[Gemini] Erro:', res.status, t);
      return 'Oi! Recebemos sua mensagem aqui no Coisas da Roça, já vamos te responder rapidinho! 🥩😊';
    }

    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
      'Oi! Recebemos sua mensagem, já vamos te atender! 🥩';
  } catch (e) {
    console.error('[Gemini] Falha:', e.message);
    return 'Olá! Recebemos sua mensagem no Coisas da Roça! Nossa equipe já vai te atender com todo carinho 🥩😊';
  }
}

// ============================================================
// DELAY HUMANIZADO (COMPOSING)
// ============================================================
function delayHumanizado(textoResposta) {
  // Base: 3 a 5 segundos, proporcional ao tamanho da resposta
  const base = 3000;
  const extra = Math.min(textoResposta.length * 8, 4000); // max +4s
  const jitter = Math.random() * 1500; // variação aleatória
  return base + extra + jitter;
}

// ============================================================
// CONTROLE DE SESSÃO / PAUSA HUMANA
// ============================================================
function getSessao(jid) {
  if (!sessoesAtivas.has(jid)) {
    sessoesAtivas.set(jid, {
      pausadoAte: 0,
      ultimaResposta: 0,
      contadorSemResposta: 0
    });
  }
  return sessoesAtivas.get(jid);
}

function isPausado(jid) {
  const s = getSessao(jid);
  return Date.now() < s.pausadoAte;
}

function pausarPorIntervencaoHumana(jid, minutos = 15) {
  const s = getSessao(jid);
  s.pausadoAte = Date.now() + (minutos * 60 * 1000);
  console.log(`⏸️ [Atendimento] IA pausada ${minutos}min para ${jid} (atendente humana interveio)`);
}

function isAntiFlood(jid) {
  const s = getSessao(jid);
  const agora = Date.now();
  // Mínimo 8 segundos entre respostas para o mesmo cliente
  if (agora - s.ultimaResposta < 8000) return true;
  return false;
}

function marcarResposta(jid) {
  const s = getSessao(jid);
  s.ultimaResposta = Date.now();
}

// ============================================================
// FUNÇÃO PRINCIPAL: PROCESSAR MENSAGEM RECEBIDA
// ============================================================
/**
 * Chamada pelo whatsapp-operator quando uma mensagem chega.
 * @param {object} params
 * @param {object} params.msg - Objeto de mensagem Baileys
 * @param {object} params.sock - Socket Baileys para enviar resposta
 * @param {function} params.downloadMedia - Função downloadMediaMessage do Baileys
 * @param {function} params.getSenderName - Função para resolver nome do contato
 */
async function processarMensagemRecebida({ msg, sock, downloadMedia, getSenderName: resolverNome }) {
  if (!msg?.key?.remoteJid) return;

  const jid = msg.key.remoteJid;

  // Ignorar mensagens do próprio bot, status broadcast, e grupos
  if (msg.key.fromMe) return;
  if (jid === 'status@broadcast') return;
  if (jid.endsWith('@g.us')) return; // Grupos - não responder automaticamente
  if (JID_IGNORADOS.has(jid)) return;

  // Ignorar se a IA está pausada por intervenção humana
  if (isPausado(jid)) {
    console.log(`[Atendimento] ${jid} pausado por atendente humana. Ignorando.`);
    return;
  }

  // Anti-flood: não responder se já respondeu nos últimos 8s
  if (isAntiFlood(jid)) {
    console.log(`[Atendimento] Anti-flood ativo para ${jid}. Ignorando.`);
    return;
  }

  // Extrair conteúdo da mensagem
  const m = msg.message || {};
  let textoCliente = m.conversation || m.extendedTextMessage?.text || '';
  let tipoMsg = 'texto';
  let base64Audio = null;

  // Opt-Out
  if (['SAIR', 'PARAR', 'CANCELAR'].includes(textoCliente.trim().toUpperCase())) {
    await supaREST('clientes', 'PATCH', { opt_out: true }, `telefone=eq.${jid.split('@')[0]}`);
    console.log(`🛑 [Atendimento] ${jid} solicitou opt-out.`);
    return;
  }

  // Processar ÁUDIO
  if (m.audioMessage) {
    tipoMsg = 'audio';
    try {
      const buffer = await downloadMedia(msg, 'buffer', {});
      if (buffer) {
        base64Audio = buffer.toString('base64');
        textoCliente = '[Áudio de voz]';
        console.log(`🎙️ [Atendimento] Áudio recebido de ${jid} (${(buffer.length / 1024).toFixed(1)} KB)`);
      }
    } catch (e) {
      console.error(`[Atendimento] Falha ao baixar áudio de ${jid}:`, e.message);
      textoCliente = '[Áudio - erro ao processar]';
    }
  }

  // Processar IMAGEM (apenas log, não responde automaticamente a fotos)
  if (m.imageMessage) {
    tipoMsg = 'imagem';
    textoCliente = m.imageMessage.caption || '[Foto enviada]';
  }

  // Se não tem texto nem áudio, ignorar
  if (!textoCliente && !base64Audio) return;

  const nomeCliente = msg.pushName || resolverNome?.(jid) || null;
  const telefone = jid.split('@')[0];

  console.log(`📩 [Atendimento] ${nomeCliente || telefone}: "${textoCliente.substring(0, 80)}"`);

  const t0 = Date.now();

  // 1. Chamar Gemini para gerar resposta
  const respostaIA = await chamarGemini(textoCliente, tipoMsg, nomeCliente, base64Audio);
  const tempoGemini = Date.now() - t0;

  if (!respostaIA) return;

  // 2. Simular digitação humana (composing)
  const delayMs = delayHumanizado(respostaIA);
  console.log(`⏳ [Atendimento] Digitando para ${nomeCliente || telefone}... (${(delayMs / 1000).toFixed(1)}s)`);

  try {
    await sock.sendPresenceUpdate('composing', jid);
  } catch (e) {}

  await new Promise(r => setTimeout(r, delayMs));

  try {
    await sock.sendPresenceUpdate('paused', jid);
  } catch (e) {}

  // 3. Enviar resposta
  try {
    await sock.sendMessage(jid, { text: respostaIA });
    marcarResposta(jid);
    console.log(`✅ [Atendimento] Respondido para ${nomeCliente || telefone} em ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.error(`❌ [Atendimento] Falha ao enviar para ${jid}:`, e.message);
  }

  // 4. Gravar no Supabase (Nuvem do Diogo)
  try {
    const dbPath = path.join(__dirname, '..', 'database.js');
    if (fs.existsSync(dbPath)) {
      const db = require(dbPath);
      db.upsertCliente({ telefone, nome: nomeCliente }).catch(e => console.warn('[DB] upsertCliente falhou:', e.message));
      db.registrarConversa({
        clienteTelefone: telefone,
        nomeCliente,
        mensagemCliente: textoCliente,
        tipoMensagem: tipoMsg,
        respostaIA,
        tempoMs: Date.now() - t0
      }).catch(e => console.warn('[DB] registrarConversa falhou:', e.message));
    }
  } catch (dbErr) {
    console.warn('[DB] Fallback silencioso ao gravar no Supabase:', dbErr.message);
  }
}

/**
 * Registra o JID do próprio número para não responder a si mesmo.
 */
function setMeuNumero(jid) {
  meuNumeroJid = jid;
  if (jid) JID_IGNORADOS.add(jid);
}

module.exports = {
  processarMensagemRecebida,
  pausarPorIntervencaoHumana,
  setMeuNumero,
  isPausado
};
