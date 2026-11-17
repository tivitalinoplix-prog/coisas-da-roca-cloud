/**
 * ADAPTADOR UNIVERSAL DE WHATSAPP GATEWAY - COISAS DA ROÇA
 * Normalização unificada (W-API / Evolution), suporte nativo a @lid, PTT Audio e Imagens.
 */

const GATEWAY_TYPE = process.env.WHATSAPP_GATEWAY_TYPE || 'WAPI';
const WAPI_BASE_URL = process.env.WAPI_BASE_URL || 'https://api.w-api.app/v1';
const WAPI_INSTANCE_ID = process.env.WAPI_INSTANCE_ID;
const WAPI_TOKEN = process.env.WAPI_TOKEN;

const EVOLUTION_URL = process.env.EVOLUTION_API_URL || 'http://localhost:8080';
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE_NAME || 'coisasdaroca_balcao';

/**
 * Formata o identificador de destino preservando @lid quando aplicável.
 * @param {string} target
 * @returns {string}
 */
function formatarDestinoGateway(target) {
  const raw = String(target || '').trim();
  if (raw.includes('@lid')) return raw;
  return raw.replace(/@s\.whatsapp\.net$/i, '').replace(/[^0-9]/g, '');
}

/**
 * Gera chave única canônica para locks em memória e banco (preserva prefixo lid:).
 * @param {string} target
 * @returns {string}
 */
function extrairChaveSessao(target) {
  const raw = String(target || '').trim();
  if (raw.includes('@lid')) {
    return `lid:${raw.split('@')[0].replace(/[^0-9]/g, '')}`;
  }
  return raw.replace(/@s\.whatsapp\.net$/i, '').replace(/[^0-9]/g, '');
}

/**
 * Envia mensagem de texto com timeout e suporte a @lid.
 */
async function enviarTextoUniversal(telefone, texto) {
  const destino = formatarDestinoGateway(telefone);
  if (!destino || !texto) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    if (GATEWAY_TYPE === 'WAPI') {
      const url = `${WAPI_BASE_URL}/message/send-text?instanceId=${WAPI_INSTANCE_ID}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${WAPI_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ phone: destino, message: texto, delayMessage: 0 }),
        signal: controller.signal
      });
      return await res.json();
    }

    if (GATEWAY_TYPE === 'EVOLUTION') {
      const url = `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY },
        body: JSON.stringify({ number: destino, text: texto, delay: 0 }),
        signal: controller.signal
      });
      return await res.json();
    }
    throw new Error(`Gateway não suportado: ${GATEWAY_TYPE}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Envia imagem (base64 ou URL) com legenda.
 */
async function enviarImagemUniversal(telefone, base64OuUrl, caption = '') {
  const destino = formatarDestinoGateway(telefone);
  if (!destino || !base64OuUrl) return null;

  if (GATEWAY_TYPE === 'WAPI') {
    const url = `${WAPI_BASE_URL}/message/send-image?instanceId=${WAPI_INSTANCE_ID}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WAPI_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ phone: destino, image: base64OuUrl, caption })
    });
    return await res.json();
  }
  return null;
}

/**
 * Baixa e descriptografa mídia (áudio ou imagem) da W-API.
 */
async function baixarMidiaWAPI(mediaObj, tipo = 'audio') {
  if (!mediaObj || !mediaObj.mediaKey) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const url = `${WAPI_BASE_URL}/message/download-media?instanceId=${WAPI_INSTANCE_ID}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WAPI_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        mediaKey: mediaObj.mediaKey,
        directPath: mediaObj.directPath,
        url: mediaObj.URL || mediaObj.url,
        mimetype: mediaObj.mimetype || (tipo === 'audio' ? 'audio/ogg; codecs=opus' : 'image/jpeg'),
        type: tipo
      }),
      signal: controller.signal
    });

    if (!res.ok) return null;
    const data = await res.json();
    if (!data.fileLink) return null;

    const mediaRes = await fetch(data.fileLink, { signal: controller.signal });
    if (!mediaRes.ok) return null;
    const arrayBuffer = await mediaRes.arrayBuffer();
    return Buffer.from(arrayBuffer).toString('base64');
  } catch (err) {
    console.warn(`[WAPI Media] Falha ao baixar ${tipo}:`, err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Normaliza cargas de W-API e Evolution API em contrato único.
 */
async function normalizarPayloadWebhook(reqBody) {
  if (!reqBody || typeof reqBody !== 'object') return null;

  // Ignora receipts de status (ACK, delivered, read, composing)
  if (reqBody.status && !reqBody.message && !reqBody.msg && !reqBody.body && !reqBody.text && !reqBody.msgContent) {
    return null;
  }

  // W-API
  if (reqBody.event === 'webhookReceived' || reqBody.instanceId || reqBody.msgContent || reqBody.connectedPhone) {
    if (reqBody.isGroup || reqBody.chat?.isGroup) return null;
    if (reqBody.fromApi || reqBody.data?.fromApi) return null; // Ignora eco das próprias mensagens do bot

    const fromMe = Boolean(reqBody.fromMe || reqBody.data?.key?.fromMe);
    const lojaNum = String(reqBody.connectedPhone || '').replace(/[^0-9]/g, '');

    let rawTarget = fromMe
      ? (reqBody.chat?.id || reqBody.data?.key?.remoteJid || reqBody.phone || '')
      : (reqBody.sender?.phone || reqBody.sender?.id || reqBody.chat?.id || reqBody.senderLid || reqBody.phone || '');

    // Proteção contra inversão de remetente
    if (lojaNum && String(rawTarget).replace(/[^0-9]/g, '') === lojaNum) {
      rawTarget = reqBody.chat?.id || '';
    }

    const replyTarget = formatarDestinoGateway(rawTarget);
    const sessionKey = extrairChaveSessao(rawTarget);
    if (!replyTarget || !sessionKey) return null;

    const messageId = reqBody.messageId || reqBody.msgId || reqBody.id || reqBody.data?.key?.id || null;

    // Se fromMe === true (e !fromApi), indica operador humano respondendo no celular/WhatsApp Web da loja
    if (fromMe) {
      return { origem: 'WAPI', fromMe: true, messageId, replyTarget, sessionKey };
    }

    const msgContent = reqBody.msgContent || reqBody.message || reqBody.msg || {};
    const imageObj = msgContent.imageMessage || reqBody.data?.message?.imageMessage || null;
    const audioObj = msgContent.audioMessage || reqBody.data?.message?.audioMessage || null;

    const text = (
      msgContent.extendedTextMessage?.text ||
      msgContent.conversation ||
      imageObj?.caption ||
      reqBody.body ||
      reqBody.text ||
      (typeof reqBody.message === 'string' ? reqBody.message : '') ||
      ''
    ).trim();

    const isAudio = Boolean(audioObj || reqBody.isAudio || ['audio', 'ptt'].includes(reqBody.type));
    const isImage = Boolean(imageObj || reqBody.isImage || reqBody.type === 'image');

    let base64Audio = audioObj?.base64 || reqBody.base64 || reqBody.audioBase64 || null;
    if (isAudio && !base64Audio && audioObj) {
      base64Audio = await baixarMidiaWAPI(audioObj, 'audio');
    }

    let base64Image = imageObj?.base64 || null;
    if (isImage && !base64Image && imageObj && text.toLowerCase().startsWith('#')) {
      // Só baixa imagem em alta resolução se for comando operacional (#falta), economizando banda
      base64Image = (await baixarMidiaWAPI(imageObj, 'image')) || imageObj.jpegThumbnail || null;
    }

    const pushName = reqBody.sender?.pushName || reqBody.sender?.name || reqBody.chat?.name || reqBody.pushName || 'Cliente';

    if (!text && !base64Audio && !isImage) return null;

    return {
      origem: 'WAPI',
      fromMe: false,
      messageId,
      replyTarget,
      sessionKey,
      pushName,
      text,
      isAudio,
      isImage,
      base64Audio,
      base64Image
    };
  }

  // Suporte a Evolution API / Baileys Padrão
  if (reqBody.event === 'messages.upsert' || reqBody.data?.key) {
    const msgData = reqBody.data || reqBody;
    const remoteJid = msgData.key?.remoteJid || reqBody.remoteJid || '';
    const fromMe = Boolean(msgData.key?.fromMe ?? reqBody.fromMe ?? false);
    if (msgData.key?.fromApi || reqBody.fromApi) return null;

    const replyTarget = formatarDestinoGateway(remoteJid);
    const sessionKey = extrairChaveSessao(remoteJid);
    if (!replyTarget || !sessionKey) return null;

    const messageId = msgData.key?.id || reqBody.messageId || reqBody.id || null;
    if (fromMe) {
      return { origem: 'EVOLUTION', fromMe: true, messageId, replyTarget, sessionKey };
    }

    const text = (msgData.message?.conversation || msgData.message?.extendedTextMessage?.text || reqBody.message || reqBody.text || '').trim();
    const isAudio = Boolean(msgData.messageType === 'audioMessage' || reqBody.type === 'audio' || reqBody.type === 'ptt');
    const isImage = Boolean(msgData.messageType === 'imageMessage' || reqBody.type === 'image');
    const base64Audio = msgData.message?.base64 || reqBody.base64 || null;
    const pushName = msgData.pushName || reqBody.pushName || reqBody.senderName || 'Cliente';

    if (!text && !base64Audio && !isImage) return null;

    return {
      origem: 'EVOLUTION',
      fromMe: false,
      messageId,
      replyTarget,
      sessionKey,
      pushName,
      text,
      isAudio,
      isImage,
      base64Audio,
      base64Image: null
    };
  }

  return null;
}

module.exports = {
  enviarTextoUniversal,
  enviarImagemUniversal,
  normalizarPayloadWebhook,
  baixarMidiaWAPI,
  formatarDestinoGateway,
  extrairChaveSessao
};
