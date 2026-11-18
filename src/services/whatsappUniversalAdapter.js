const GATEWAY_TYPE = (process.env.WHATSAPP_GATEWAY_TYPE || 'WAPI').toUpperCase();
const WAPI_BASE_URL = (process.env.WAPI_BASE_URL || 'https://api.w-api.app/v1').replace(/\/$/, '');
const WAPI_INSTANCE_ID = process.env.WAPI_INSTANCE_ID || '';
const WAPI_TOKEN = process.env.WAPI_TOKEN || '';

const EVOLUTION_URL = (process.env.EVOLUTION_API_URL || 'http://localhost:8080').replace(/\/$/, '');
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY || '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE_NAME || 'coisasdaroca_balcao';

function formatarDestinoGateway(target) {
  const raw = String(target || '').trim();
  if (!raw) return '';
  if (/@lid/i.test(raw)) {
    const lidDigits = raw.split('@')[0].replace(/[^0-9]/g, '');
    return lidDigits ? `${lidDigits}@lid` : raw;
  }
  return raw.replace(/@s\.whatsapp\.net|@c\.us/gi, '').replace(/[^0-9]/g, '');
}

function extrairChaveSessao(target) {
  const raw = String(target || '').trim();
  if (!raw) return '';
  if (/@lid/i.test(raw)) {
    const lidDigits = raw.split('@')[0].replace(/[^0-9]/g, '');
    return lidDigits ? `lid:${lidDigits}` : '';
  }
  return raw.replace(/@s\.whatsapp\.net|@c\.us/gi, '').replace(/[^0-9]/g, '');
}

async function lerRespostaGatewaySegura(res, contexto) {
  const rawText = await res.text();
  let parsed = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : {};
  } catch {
    parsed = { raw: rawText };
  }

  if (!res.ok) {
    throw new Error(`[${contexto}] HTTP ${res.status}: ${rawText.slice(0, 200)}`);
  }
  return parsed;
}

async function enviarTextoUniversal(telefone, texto) {
  const destino = formatarDestinoGateway(telefone);
  if (!destino || !texto) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    if (GATEWAY_TYPE === 'WAPI') {
      if (!WAPI_INSTANCE_ID || !WAPI_TOKEN) {
        throw new Error('Credenciais WAPI_INSTANCE_ID / WAPI_TOKEN não configuradas.');
      }
      const url = `${WAPI_BASE_URL}/message/send-text?instanceId=${WAPI_INSTANCE_ID}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WAPI_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ phone: destino, message: texto, delayMessage: 0 }),
        signal: controller.signal,
      });
      return await lerRespostaGatewaySegura(res, 'WAPI send-text');
    }

    if (GATEWAY_TYPE === 'EVOLUTION') {
      const url = `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_KEY },
        body: JSON.stringify({ number: destino, text: texto, delay: 0 }),
        signal: controller.signal,
      });
      return await lerRespostaGatewaySegura(res, 'EVOLUTION sendText');
    }

    throw new Error(`Gateway não suportado: ${GATEWAY_TYPE}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function enviarBotoesUniversal(telefone, texto, botoes = [], rodape = 'Coisas da Roça • Macaé/RJ') {
  const destino = formatarDestinoGateway(telefone);
  if (!destino || !texto) return null;
  if (!Array.isArray(botoes) || botoes.length === 0) {
    return enviarTextoUniversal(telefone, texto);
  }

  if (GATEWAY_TYPE === 'WAPI' && WAPI_INSTANCE_ID && WAPI_TOKEN) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const url = `${WAPI_BASE_URL}/message/send-button-actions?instanceId=${WAPI_INSTANCE_ID}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WAPI_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          phone: destino,
          message: texto,
          footer: rodape,
          buttonActions: botoes.slice(0, 3).map((b, idx) => ({
            id: b.id || `btn_${idx + 1}`,
            type: 'REPLY',
            label: String(b.label || b.texto || '').slice(0, 20),
          })),
        }),
        signal: controller.signal,
      });
      if (res.ok) {
        return await lerRespostaGatewaySegura(res, 'WAPI send-button-actions');
      }
      console.warn(`[WAPI Botoes] HTTP ${res.status}, aplicando fallback para texto.`);
    } catch (err) {
      console.warn('[WAPI Botoes] Falha no envio interativo, aplicando fallback para texto:', err.message);
    } finally {
      clearTimeout(timeout);
    }
  }

  // Fallback gracioso em texto limpo numerado
  const opcoesTexto = botoes
    .slice(0, 3)
    .map((b, idx) => `*${idx + 1}* - ${b.label || b.texto}`)
    .join('\n');
  return enviarTextoUniversal(telefone, `${texto}\n\n${opcoesTexto}`);
}

async function enviarImagemUniversal(telefone, base64OuUrl, caption = '') {
  const destino = formatarDestinoGateway(telefone);
  if (!destino || !base64OuUrl) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    if (GATEWAY_TYPE === 'WAPI') {
      if (!WAPI_INSTANCE_ID || !WAPI_TOKEN) {
        throw new Error('Credenciais WAPI_INSTANCE_ID / WAPI_TOKEN não configuradas.');
      }
      const url = `${WAPI_BASE_URL}/message/send-image?instanceId=${WAPI_INSTANCE_ID}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WAPI_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ phone: destino, image: base64OuUrl, caption }),
        signal: controller.signal,
      });
      return await lerRespostaGatewaySegura(res, 'WAPI send-image');
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function baixarMidiaWAPI(mediaObj, tipo = 'audio') {
  if (!mediaObj || !mediaObj.mediaKey || !WAPI_INSTANCE_ID || !WAPI_TOKEN) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const url = `${WAPI_BASE_URL}/message/download-media?instanceId=${WAPI_INSTANCE_ID}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WAPI_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mediaKey: mediaObj.mediaKey,
        directPath: mediaObj.directPath,
        url: mediaObj.URL || mediaObj.url,
        mimetype: mediaObj.mimetype || (tipo === 'audio' ? 'audio/ogg; codecs=opus' : 'image/jpeg'),
        type: tipo,
      }),
      signal: controller.signal,
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

function extrairTextoDePayload(msgContent = {}, reqBody = {}, imageObj = null) {
  return (
    msgContent.extendedTextMessage?.text ||
    msgContent.conversation ||
    msgContent.text?.message ||
    msgContent.buttonsResponseMessage?.selectedDisplayText ||
    msgContent.buttonsResponseMessage?.selectedButtonId ||
    msgContent.templateButtonReplyMessage?.selectedDisplayText ||
    msgContent.templateButtonReplyMessage?.selectedId ||
    msgContent.listResponseMessage?.title ||
    msgContent.listResponseMessage?.singleSelectReply?.selectedRowId ||
    imageObj?.caption ||
    reqBody.body ||
    reqBody.text ||
    (typeof reqBody.message === 'string' ? reqBody.message : '') ||
    ''
  ).trim();
}

async function normalizarPayloadWebhook(reqBody) {
  if (!reqBody || typeof reqBody !== 'object') return null;

  if (
    reqBody.status &&
    !reqBody.message &&
    !reqBody.msg &&
    !reqBody.body &&
    !reqBody.text &&
    !reqBody.msgContent
  ) {
    return null;
  }

  if (
    reqBody.event === 'webhookReceived' ||
    reqBody.instanceId ||
    reqBody.msgContent ||
    reqBody.connectedPhone
  ) {
    const rawChatId = String(reqBody.chat?.id || reqBody.remoteJid || reqBody.chatId || '');
    if (
      reqBody.isGroup ||
      reqBody.chat?.isGroup ||
      rawChatId.includes('@g.us') ||
      rawChatId.includes('status@broadcast')
    ) {
      return null;
    }

    if (reqBody.fromApi || reqBody.data?.fromApi || reqBody.data?.key?.fromApi) {
      return null;
    }

    const fromMe = Boolean(reqBody.fromMe || reqBody.key?.fromMe || reqBody.data?.key?.fromMe);
    const lojaNum = String(reqBody.connectedPhone || '').replace(/[^0-9]/g, '');

    const senderPhone = String(reqBody.sender?.phone || reqBody.senderPhone || reqBody.phone || '').trim();
    const senderLid = String(reqBody.senderLid || reqBody.sender?.lid || '').trim();

    let rawTarget = fromMe
      ? (reqBody.chat?.id || reqBody.data?.key?.remoteJid || reqBody.chatId || reqBody.phone || '')
      : (reqBody.chat?.id || reqBody.sender?.phone || reqBody.sender?.id || reqBody.senderLid || reqBody.phone || '');

    if (lojaNum && String(rawTarget).replace(/[^0-9]/g, '') === lojaNum) {
      rawTarget = reqBody.chat?.id || reqBody.sender?.id || reqBody.senderLid || '';
    }

    const replyTarget = formatarDestinoGateway(rawTarget);
    const sessionKey = extrairChaveSessao(rawTarget);
    if (!replyTarget || !sessionKey) return null;

    const messageId =
      reqBody.messageId || reqBody.msgId || reqBody.id || reqBody.data?.key?.id || null;

    const msgContent = reqBody.msgContent || reqBody.message || reqBody.msg || {};
    const imageObj = msgContent.imageMessage || reqBody.data?.message?.imageMessage || null;
    const audioObj = msgContent.audioMessage || reqBody.data?.message?.audioMessage || null;
    const text = extrairTextoDePayload(msgContent, reqBody, imageObj);

    if (fromMe) {
      return {
        origem: 'WAPI',
        fromMe: true,
        messageId,
        replyTarget,
        sessionKey,
        rawChatId,
        senderPhone,
        senderLid,
        text,
      };
    }

    const isAudio = Boolean(audioObj || reqBody.isAudio || ['audio', 'ptt'].includes(reqBody.type));
    const isImage = Boolean(imageObj || reqBody.isImage || reqBody.type === 'image');

    let base64Audio = audioObj?.base64 || reqBody.base64 || reqBody.audioBase64 || null;
    if (isAudio && !base64Audio && audioObj) {
      base64Audio = await baixarMidiaWAPI(audioObj, 'audio');
    }

    let base64Image = imageObj?.base64 || null;
    if (isImage && !base64Image && imageObj && text.toLowerCase().startsWith('#')) {
      base64Image = (await baixarMidiaWAPI(imageObj, 'image')) || imageObj.jpegThumbnail || null;
    }

    const pushName =
      reqBody.sender?.pushName ||
      reqBody.sender?.name ||
      reqBody.senderName ||
      reqBody.chat?.name ||
      reqBody.pushName ||
      '';

    if (!text && !base64Audio && !isImage) return null;

    return {
      origem: 'WAPI',
      fromMe: false,
      messageId,
      replyTarget,
      sessionKey,
      rawChatId,
      senderPhone,
      senderLid,
      pushName,
      text,
      isAudio,
      isImage,
      base64Audio,
      base64Image,
    };
  }

  if (reqBody.event === 'messages.upsert' || reqBody.data?.key) {
    const msgData = reqBody.data || reqBody;
    const remoteJid = msgData.key?.remoteJid || reqBody.remoteJid || '';
    if (remoteJid.includes('@g.us') || remoteJid.includes('status@broadcast')) return null;

    const fromMe = Boolean(msgData.key?.fromMe ?? reqBody.fromMe ?? false);
    if (msgData.key?.fromApi || reqBody.fromApi) return null;

    const replyTarget = formatarDestinoGateway(remoteJid);
    const sessionKey = extrairChaveSessao(remoteJid);
    if (!replyTarget || !sessionKey) return null;

    const messageId = msgData.key?.id || reqBody.messageId || reqBody.id || null;
    const text = extrairTextoDePayload(msgData.message || {}, reqBody, msgData.message?.imageMessage);

    if (fromMe) {
      return {
        origem: 'EVOLUTION',
        fromMe: true,
        messageId,
        replyTarget,
        sessionKey,
        rawChatId: remoteJid,
        senderPhone: '',
        senderLid: '',
        text,
      };
    }

    const isAudio = Boolean(
      msgData.messageType === 'audioMessage' || reqBody.type === 'audio' || reqBody.type === 'ptt'
    );
    const isImage = Boolean(msgData.messageType === 'imageMessage' || reqBody.type === 'image');
    const base64Audio = msgData.message?.base64 || reqBody.base64 || null;
    const pushName = msgData.pushName || reqBody.pushName || reqBody.senderName || '';

    if (!text && !base64Audio && !isImage) return null;

    return {
      origem: 'EVOLUTION',
      fromMe: false,
      messageId,
      replyTarget,
      sessionKey,
      rawChatId: remoteJid,
      senderPhone: '',
      senderLid: '',
      pushName,
      text,
      isAudio,
      isImage,
      base64Audio,
      base64Image: null,
    };
  }

  return null;
}

module.exports = {
  enviarTextoUniversal,
  enviarBotoesUniversal,
  enviarImagemUniversal,
  normalizarPayloadWebhook,
  baixarMidiaWAPI,
  formatarDestinoGateway,
  extrairChaveSessao,
};
