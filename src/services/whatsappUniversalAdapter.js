/**
 * ADAPTADOR UNIVERSAL DE WHATSAPP GATEWAY (W-API PRO / EVOLUTION) - COISAS DA ROÇA
 * IMPORTANTE: Nenhuma função ou parâmetro de rejeição de chamadas (rejectCalls) é utilizado.
 * Chamadas telefônicas no chip físico da loja tocam normalmente.
 */

const GATEWAY_TYPE = (process.env.WHATSAPP_GATEWAY_TYPE || 'WAPI').toUpperCase();
const WAPI_BASE_URL = (process.env.WAPI_BASE_URL || 'https://api.w-api.app/v1').replace(/\/$/, '');
const WAPI_INSTANCE_ID = process.env.WAPI_INSTANCE_ID || '';
const WAPI_TOKEN = process.env.WAPI_TOKEN || '';

const EVOLUTION_URL = (process.env.EVOLUTION_API_URL || 'http://localhost:8080').replace(/\/$/, '');
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY || '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE_NAME || 'coisasdaroca_balcao';

const LOJA_PADRAO_LOCALIZACAO = {
  latitude: -22.3789,
  longitude: -41.7832,
  name: 'Açougue e Mercearia Coisas da Roça',
  address: 'Rua Ferreira Viana, 136 - Centro, Macaé/RJ',
};

function normalizarJid(jidOrPhone) {
  if (!jidOrPhone) return '';
  const str = String(jidOrPhone).trim();
  if (/@lid/i.test(str) || /@s\.whatsapp\.net/i.test(str) || /@g\.us/i.test(str)) {
    return str;
  }
  const apenasNumeros = str.replace(/[^0-9]/g, '');
  if (!apenasNumeros) return str;
  return `${apenasNumeros}@s.whatsapp.net`;
}

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

/**
 * Envia indicador de presença ('composing' ou 'recording') com timeout de 4s.
 * Falhas nunca travam o fluxo principal.
 */
async function enviarPresencaUniversal(to, presence = 'composing') {
  const destino = formatarDestinoGateway(to);
  if (!destino || GATEWAY_TYPE !== 'WAPI' || !WAPI_INSTANCE_ID || !WAPI_TOKEN) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  try {
    const url = `${WAPI_BASE_URL}/chat/send-presence?instanceId=${WAPI_INSTANCE_ID}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WAPI_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        phone: destino,
        presence: presence === 'recording' ? 'recording' : 'composing',
        delay: 3000,
      }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Marca mensagem recebida como lida (tique azul humanizado).
 */
async function marcarMensagemComoLida(to, messageId) {
  const destino = formatarDestinoGateway(to);
  if (!destino || !messageId || GATEWAY_TYPE !== 'WAPI' || !WAPI_INSTANCE_ID || !WAPI_TOKEN) {
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  try {
    const url = `${WAPI_BASE_URL}/chat/mark-message-as-read?instanceId=${WAPI_INSTANCE_ID}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WAPI_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ phone: destino, messageId }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Consulta nome/perfil do contato na W-API quando o pushName vier ausente.
 */
async function obterDadosContato(to) {
  const destino = formatarDestinoGateway(to);
  if (!destino || destino.includes('@lid') || GATEWAY_TYPE !== 'WAPI' || !WAPI_INSTANCE_ID || !WAPI_TOKEN) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  try {
    const url = `${WAPI_BASE_URL}/contact/fetch-contact?instanceId=${WAPI_INSTANCE_ID}&phone=${encodeURIComponent(destino)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${WAPI_TOKEN}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
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

/**
 * Envia imagem (base64 ou URL) com fallback automático para texto caso a imagem falhe.
 */
async function enviarImagemUniversal(telefone, base64OuUrl, caption = '') {
  const destino = formatarDestinoGateway(telefone);
  if (!destino) return null;
  if (!base64OuUrl) {
    return caption ? enviarTextoUniversal(telefone, caption) : null;
  }

  if (GATEWAY_TYPE === 'WAPI' && WAPI_INSTANCE_ID && WAPI_TOKEN) {
    const publicBase = (process.env.PUBLIC_URL || 'https://coisasdaroca-core-production.up.railway.app').replace(/\/$/, '');
    const candidatos = /^https?:\/\//i.test(base64OuUrl)
      ? [base64OuUrl]
      : [
          `${publicBase}/assets/logo_coisas_da_roca.jpg`,
          base64OuUrl,
          String(base64OuUrl).replace(/^data:image\/[a-z0-9+.-]+;base64,/i, ''),
        ];

    for (const imgPayload of candidatos) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const url = `${WAPI_BASE_URL}/message/send-image?instanceId=${WAPI_INSTANCE_ID}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${WAPI_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ phone: destino, image: imgPayload, imageUrl: imgPayload, url: imgPayload, caption }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (res.ok) {
          return await lerRespostaGatewaySegura(res, 'WAPI send-image');
        }
      } catch (err) {
        clearTimeout(timeout);
        console.warn('[WAPI Imagem] Tentativa falhou:', err.message);
      }
    }
  }

  if (caption) {
    return enviarTextoUniversal(telefone, caption);
  }
  return null;
}

/**
 * Envia pino de localização da loja no WhatsApp com fallback automático para link do Google Maps.
 */
async function enviarLocalizacaoUniversal(to, loc = {}) {
  const destino = formatarDestinoGateway(to);
  if (!destino) return null;

  const latitude = loc.latitude ?? LOJA_PADRAO_LOCALIZACAO.latitude;
  const longitude = loc.longitude ?? LOJA_PADRAO_LOCALIZACAO.longitude;
  const name = loc.name || LOJA_PADRAO_LOCALIZACAO.name;
  const address = loc.address || LOJA_PADRAO_LOCALIZACAO.address;

  if (GATEWAY_TYPE === 'WAPI' && WAPI_INSTANCE_ID && WAPI_TOKEN) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const url = `${WAPI_BASE_URL}/message/send-location?instanceId=${WAPI_INSTANCE_ID}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WAPI_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          phone: destino,
          latitude,
          longitude,
          name,
          address,
        }),
        signal: controller.signal,
      });
      if (res.ok) {
        return await lerRespostaGatewaySegura(res, 'WAPI send-location');
      }
    } catch (err) {
      console.warn('[WAPI Location] Fallback para link de localização:', err.message);
    } finally {
      clearTimeout(timeout);
    }
  }

  const mapsLink = `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
  return enviarTextoUniversal(
    to,
    `📍 *${name}*\n${address}\nMapa: ${mapsLink}`
  );
}

/**
 * Envia botões interativos com fallback gracioso para opções numéricas.
 */
async function enviarBotoesUniversal(telefone, texto, botoes = [], rodape = 'Coisas da Roça • Macaé/RJ') {
  const destino = formatarDestinoGateway(telefone);
  if (!destino || !texto) return null;
  if (!Array.isArray(botoes) || botoes.length === 0) {
    return enviarTextoUniversal(telefone, texto);
  }

  

  const opcoesTexto = botoes
    .slice(0, 3)
    .map((b, idx) => `*${idx + 1}* - ${b.label || b.texto}`)
    .join('\n');
  return enviarTextoUniversal(telefone, `${texto}\n\n${opcoesTexto}`);
}

/**
 * Envia menu em lista (List Message) com fallback para lista de marcadores bullet (•).
 */
async function enviarListaUniversal(to, { title = '', description = '', buttonText = 'Ver opções', sections = [] } = {}) {
  const destino = formatarDestinoGateway(to);
  if (!destino) return null;

  if (GATEWAY_TYPE === 'WAPI' && WAPI_INSTANCE_ID && WAPI_TOKEN && Array.isArray(sections) && sections.length > 0) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const url = `${WAPI_BASE_URL}/message/send-list?instanceId=${WAPI_INSTANCE_ID}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WAPI_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          phone: destino,
          title,
          description,
          buttonText,
          sections,
        }),
        signal: controller.signal,
      });
      if (res.ok) {
        return await lerRespostaGatewaySegura(res, 'WAPI send-list');
      }
    } catch (err) {
      console.warn('[WAPI Lista] Aplicando fallback bullet list:', err.message);
    } finally {
      clearTimeout(timeout);
    }
  }

  const linhas = [];
  if (title) linhas.push(`*${title}*`);
  if (description) linhas.push(description);

  for (const sec of sections || []) {
    if (sec.title) linhas.push(`\n*${sec.title}*`);
    for (const row of sec.rows || []) {
      const desc = row.description ? ` — ${row.description}` : '';
      linhas.push(`• *${row.title}*${desc}`);
    }
  }

  return enviarTextoUniversal(to, linhas.join('\n').trim());
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
      rawTarget = reqBody.chat?.id || reqBody.sender?.id || reqBody.senderLid || rawTarget;
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

    const isAudio = Boolean(audioObj || reqBody.isAudio || ['audio', 'ptt'].includes(reqBody.type));
    const isImage = Boolean(imageObj || reqBody.isImage || reqBody.type === 'image');

    let base64Image = imageObj?.base64 || null;
    // Baixa imagem se for comando com # ou se for mensagem enviada pelo celular Master da loja (Diogo)
    const isChatPropriaLoja = lojaNum && replyTarget.replace(/\D/g, '') === lojaNum;
    if (isImage && !base64Image && imageObj && (text.toLowerCase().startsWith('#') || fromMe || isChatPropriaLoja)) {
      base64Image = (await baixarMidiaWAPI(imageObj, 'image')) || imageObj.jpegThumbnail || null;
    }

    if (fromMe) {
      return {
        origem: 'WAPI',
        fromMe: true,
        isChatPropriaLoja,
        lojaNum,
        messageId,
        replyTarget,
        sessionKey,
        rawChatId,
        senderPhone,
        senderLid,
        text,
        isImage,
        base64Image,
      };
    }

    let base64Audio = audioObj?.base64 || reqBody.base64 || reqBody.audioBase64 || null;
    if (isAudio && !base64Audio && audioObj) {
      base64Audio = await baixarMidiaWAPI(audioObj, 'audio');
    }

    let pushName =
      reqBody.sender?.pushName ||
      reqBody.sender?.name ||
      reqBody.senderName ||
      reqBody.chat?.name ||
      reqBody.pushName ||
      '';

    if (!pushName && replyTarget && !replyTarget.includes('@lid')) {
      const dadosContato = await obterDadosContato(replyTarget);
      pushName = dadosContato?.name || dadosContato?.pushName || '';
    }

    if (!text && !base64Audio && !isImage) return null;

    return {
      origem: 'WAPI',
      fromMe: false,
      isChatPropriaLoja,
      lojaNum,
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
    const isImage = Boolean(msgData.messageType === 'imageMessage' || reqBody.type === 'image');
    const base64Image = msgData.message?.base64 || null;

    if (fromMe) {
      return {
        origem: 'EVOLUTION',
        fromMe: true,
        isChatPropriaLoja: false,
        lojaNum: '',
        messageId,
        replyTarget,
        sessionKey,
        rawChatId: remoteJid,
        senderPhone: '',
        senderLid: '',
        text,
        isImage,
        base64Image,
      };
    }

    const isAudio = Boolean(
      msgData.messageType === 'audioMessage' || reqBody.type === 'audio' || reqBody.type === 'ptt'
    );
    const base64Audio = msgData.message?.base64 || reqBody.base64 || null;
    const pushName = msgData.pushName || reqBody.pushName || reqBody.senderName || '';

    if (!text && !base64Audio && !isImage) return null;

    return {
      origem: 'EVOLUTION',
      fromMe: false,
      isChatPropriaLoja: false,
      lojaNum: '',
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
      base64Image,
    };
  }

  return null;
}

module.exports = {
  normalizarJid,
  enviarPresencaUniversal,
  marcarMensagemComoLida,
  obterDadosContato,
  enviarTextoUniversal,
  enviarImagemUniversal,
  enviarLocalizacaoUniversal,
  enviarBotoesUniversal,
  enviarListaUniversal,
  normalizarPayloadWebhook,
  baixarMidiaWAPI,
  formatarDestinoGateway,
  extrairChaveSessao,
};
