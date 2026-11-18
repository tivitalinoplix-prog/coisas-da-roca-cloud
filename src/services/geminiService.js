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
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

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

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  const data = await response.json();
  const rawText = data.candidates[0].content.parts[0].text;
  return JSON.parse(rawText);
}

module.exports = { processarAudioComGemini, dicionario };
