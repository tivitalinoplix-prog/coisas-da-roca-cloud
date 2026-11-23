const fs = require('fs');
const path = require('path');

// Carregar dicionário gastronômico local
const dictPath = path.join(__dirname, '..', '..', 'config', 'dicionario_gastronomico.json');
let dicionario = {};
if (fs.existsSync(dictPath)) {
  try {
    dicionario = JSON.parse(fs.readFileSync(dictPath, 'utf-8'));
  } catch (e) {
    console.error('Erro ao ler dicionario_gastronomico.json:', e.message);
  }
}

async function processarAudioComGemini(base64Audio, clienteTelefone, apiKey) {
  const modelosAudio = [
    process.env.GEMINI_MODEL_EXECUTOR || 'gemini-3.5-flash-lite',
    'gemini-3-flash-preview',
    'gemini-3.8-flash',
    'gemini-4-hydrogen'
  ];

  const promptSystem = `Você é o Principal Especialista de Balcão e Ingestão Multimodal do Açougue e Mercearia Coisas da Roça (Macaé/RJ).
Sua missão é ouvir este áudio enviado por uma cliente tradicional/dona de casa, transcrever com absoluta fidelidade e extrair os dados em formato JSON estrito.

Regras Culinárias do Coisas da Roça:
1. Normalizar fracionamento: Se disser "2 saquinhos de meio quilo", são 2 unidades de 500g (total 1000g).
2. Se pedir cortes finos, marcar "bife fino p/ almoço".
3. Separar nitidamente carnes (câmara fria) de mercearia seca (carvão, queijos, doces, bebidas).
4. Identificar bairro de Macaé (Centro, Cavaleiros, Glória, etc.) e forma de pagamento (maquininha na entrega, dinheiro com troco, Pix).

Responda APENAS com um objeto JSON válido (sem markdown, sem backticks):
{
  "cliente_telefone": "${clienteTelefone}",
  "transcricao_literal": "...",
  "itens_acougue": [
    {
      "produto": "Patinho Moído",
      "quantidade_saquinhos": 2,
      "peso_por_saquinho_gramas": 500,
      "peso_total_estimado_gramas": 1000,
      "especificacao_corte": "moído 2 vezes"
    }
  ],
  "itens_mercearia": [
    { "produto": "Queijo Minas Artesanal", "unidades": 1 }
  ],
  "bairro_macae": "Centro",
  "forma_pagamento": "Maquininha Entrega",
  "observacoes": "..."
}`;

  const requestBody = {
    contents: [
      {
        parts: [
          { text: promptSystem },
          {
            inline_data: {
              mime_type: 'audio/ogg',
              data: base64Audio
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 }
    }
  };

  for (const mod of modelosAudio) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${mod}:generateContent?key=${apiKey}`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });
      if (!response.ok) continue;
      const data = await response.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (rawText) {
        return JSON.parse(rawText);
      }
    } catch (_) {}
  }
  return null;
}

async function lerListaComprasImagem(imageUrl) {
  if (!imageUrl) return '';
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return '';
  try {
    let base64Img = '';
    let contentType = 'image/jpeg';
    if (imageUrl.startsWith('data:')) {
      const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        contentType = match[1];
        base64Img = match[2];
      }
    } else {
      const respImg = await fetch(imageUrl);
      if (!respImg.ok) return '';
      contentType = respImg.headers.get('content-type') || 'image/jpeg';
      base64Img = Buffer.from(await respImg.arrayBuffer()).toString('base64');
    }

    if (!base64Img) return '';

    for (const mod of ['gemini-4-hydrogen', 'gemini-3.5-flash-lite', 'gemini-3-flash-preview', 'gemini-3.8-flash']) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${mod}:generateContent?key=${apiKey}`;
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: 'Transcreva fielmente os itens e quantidades desta lista de compras de açougue/mercearia escrita pelo cliente. Retorne apenas os itens em linha simples.' },
                { inlineData: { mimeType: contentType, data: base64Img } }
              ]
            }]
          })
        });
        if (!r.ok) continue;
        const data = await r.json();
        const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (txt.trim()) return txt.trim();
      } catch (_) {}
    }
  } catch (_) {}
  return '';
}

module.exports = {
  processarAudioComGemini,
  lerListaComprasImagem,
  dicionario,
};
