const redisService = require('./redisService');

function obterChavesGemini() {
  return [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_FALLBACK,
    process.env.GOOGLE_API_KEY,
  ].filter((k) => Boolean(k && String(k).trim()));
}

/**
 * Extrai dados estruturados de uma foto administrativa enviada pelo Diogo (lousa, câmara fria, bloquinho).
 */
async function analisarImagemGestaoVision(base64Image, legenda = '') {
  if (!base64Image) return null;
  const chaves = obterChavesGemini();
  if (!chaves.length) return null;

  const cleanBase64 = String(base64Image).replace(/^data:image\/[a-z0-9]+;base64,/i, '');
  const prompt = `Você é o assistente de gerência do Açougue e Mercearia Coisas da Roça (Macaé/RJ).
Analise esta imagem enviada pelo proprietário Diogo Farah (pode ser uma anotação de cortes em falta, foto da lousa de preços do dia ou tabela de carnes).
Legenda enviada junto com a foto: "${legenda || 'Sem legenda'}"

Responda ESTRITAMENTE com um objeto JSON válido (sem markdown):
{
  "tipo": "FALTAS" | "DISPONIVEIS" | "PRECOS",
  "faltas": ["Nome do Corte 1", "Nome do Corte 2"],
  "disponiveis": ["Nome do Corte"],
  "precos": [{"item": "Nome do Corte", "preco": 49.90}],
  "sugestoes_substituicao": ["Alcatra", "Coxão Mole"]
}`;

  const modelos = ['gemini-2.5-flash', 'gemini-2.0-flash'];

  for (const apiKey of chaves) {
    for (const modelName of modelos) {
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [
                  { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } },
                  { text: prompt },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.0,
              responseMimeType: 'application/json',
              maxOutputTokens: 600,
            },
          }),
        });

        if (!res.ok) continue;
        const data = await res.json();
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const limpo = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
        return JSON.parse(limpo);
      } catch (err) {
        console.warn(`[visaoComandosService] Falha em ${modelName}:`, err.message);
      }
    }
  }

  return null;
}

/**
 * Monta a mensagem de confirmação para o Diogo aprovar (SIM / NÃO).
 */
function montarDialogoCalibracao(analise) {
  if (!analise) {
    return '⚠️ Não consegui ler os itens da imagem com clareza. Pode enviar mais de perto ou usar *#falta [corte]* / *#preco [corte] [valor]*?';
  }

  const faltas = Array.isArray(analise.faltas) ? analise.faltas.filter(Boolean) : [];
  const precos = Array.isArray(analise.precos) ? analise.precos.filter((p) => p && p.item && p.preco) : [];
  const disponiveis = Array.isArray(analise.disponiveis) ? analise.disponiveis.filter(Boolean) : [];
  const sugestoes = Array.isArray(analise.sugestoes_substituicao) && analise.sugestoes_substituicao.length > 0
    ? analise.sugestoes_substituicao.join('/')
    : 'Alcatra/Coxão Mole';

  if (faltas.length > 0) {
    return (
      `Entendido, Diogo! Identifiquei pela foto que os seguintes cortes estão em *FALTA* hoje: *[${faltas.join(', ')}]*.\n\n` +
      `Deseja que eu ative essa trava no catálogo e passe a sugerir *${sugestoes}*? Responda *SIM* para confirmar (ou *NÃO* para cancelar).`
    );
  }

  if (precos.length > 0) {
    const lista = precos
      .map((p) => `• *${p.item}*: R$ ${Number(p.preco).toFixed(2).replace('.', ',')}`)
      .join('\n');
    return (
      `Entendido, Diogo! Identifiquei pela foto a atualização de preços do dia:\n${lista}\n\n` +
      `Deseja aplicar esses valores agora no balcão? Responda *SIM* para confirmar.`
    );
  }

  if (disponiveis.length > 0) {
    return (
      `Entendido, Diogo! Identifiquei que os cortes *[${disponiveis.join(', ')}]* chegaram e estão *DISPONÍVEIS*.\n\n` +
      `Deseja liberar a venda no catálogo agora? Responda *SIM* para confirmar.`
    );
  }

  return '⚠️ Recebi a foto, mas não identifiquei cortes ou preços claros. Você pode responder com *#falta [corte]* ou enviar outra foto.';
}

/**
 * Executa a confirmação ("SIM") ou cancelamento ("NÃO") de uma calibração pendente no Redis.
 */
async function processarConfirmacaoVision(chaveGestor, textoResposta = '') {
  const pendente = await redisService.obterVisionPendente(chaveGestor);
  if (!pendente) return null;

  const limpo = String(textoResposta || '').trim().toLowerCase();

  if (['sim', 's', 'confirmar', 'confirmo', 'ok', 'pode'].includes(limpo)) {
    const aplicados = [];

    if (Array.isArray(pendente.faltas)) {
      for (const item of pendente.faltas) {
        await redisService.adicionarFalta(item);
        aplicados.push(`❌ Falta: *${item}*`);
      }
    }

    if (Array.isArray(pendente.disponiveis)) {
      for (const item of pendente.disponiveis) {
        await redisService.removerFalta(item);
        aplicados.push(`✅ Disponível: *${item}*`);
      }
    }

    if (Array.isArray(pendente.precos)) {
      for (const p of pendente.precos) {
        if (p?.item && p?.preco) {
          await redisService.salvarPrecoOverride(p.item, p.preco);
          aplicados.push(`🏷️ Preço: *${p.item}* -> R$ ${Number(p.preco).toFixed(2).replace('.', ',')}`);
        }
      }
    }

    await redisService.limparVisionPendente(chaveGestor);
    return `✅ *Calibração confirmada e ativa no balcão!*\n${aplicados.join('\n')}`;
  }

  if (['nao', 'não', 'n', 'cancelar', 'cancela'].includes(limpo)) {
    await redisService.limparVisionPendente(chaveGestor);
    return '👍 Calibração por foto cancelada. Nenhuma alteração foi feita no catálogo.';
  }

  return null;
}

/**
 * Inicia o fluxo de análise de imagem enviada pelo Diogo e salva o estado pendente no Redis.
 */
async function iniciarCalibracaoPorFoto(chaveGestor, base64Image, legenda = '') {
  const analise = await analisarImagemGestaoVision(base64Image, legenda);
  if (
    analise &&
    ((analise.faltas && analise.faltas.length > 0) ||
      (analise.precos && analise.precos.length > 0) ||
      (analise.disponiveis && analise.disponiveis.length > 0))
  ) {
    await redisService.salvarVisionPendente(chaveGestor, analise);
  }
  return montarDialogoCalibracao(analise);
}

module.exports = {
  analisarImagemGestaoVision,
  montarDialogoCalibracao,
  processarConfirmacaoVision,
  iniciarCalibracaoPorFoto,
};
