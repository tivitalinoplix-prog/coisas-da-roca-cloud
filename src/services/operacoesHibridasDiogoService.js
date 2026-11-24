/**
 * operacoesHibridasDiogoService.js
 * ============================================================================
 * Módulo de Comando do Diogo (Proprietário) e Atendimento Híbrido 2.0
 * 
 * Permite ao Diogo Farah (e equipe autorizada) comandar o robô diretamente
 * do seu celular pessoal pelo WhatsApp oficial do Coisas da Roça:
 * 
 * 1. #oferta [texto] (+ foto opcional): Registra rascunho de oferta relâmpago
 * 2. #testar_disparo: Envia o teste (com flyer) para o WhatsApp do Diogo
 * 3. #confirmar_disparo [qtd]: Dispara a campanha para a base com anti-ban
 * 4. #status [legenda] (+ foto opcional): Publica no Status (Stories) 24h da Loja
 * 5. #resumo: Monta pré-resumo limpo da conversa para a Jussara no balcão
 * ============================================================================
 */

const whatsappAdapter = require('./whatsappUniversalAdapter');
const disparoHumanizadoService = require('./disparoHumanizadoService');

// Rascunho em memória da última oferta criada pelo Diogo
let ofertaRelampagoAtiva = null;

/**
 * Verifica se o telefone é do Diogo (Proprietário), Txai (Engenharia) ou da própria Loja
 */
function isTelefoneComandoAutorizado(telefoneOuChave = '') {
  const limpo = String(telefoneOuChave || '').replace(/@.*$/, '').replace(/\D/g, '');
  if (!limpo || limpo.length < 7) return false;

  return (
    limpo.endsWith('99766763') || // Diogo Farah (+55 22 99976-6763)
    limpo.endsWith('98586180') || // Txai Vitalino (+55 22 99858-6180)
    limpo.endsWith('7621921')  || // Balcão Loja (+55 22 99762-1921)
    limpo.endsWith('97621921')    // Balcão Loja
  );
}

/**
 * Trata comandos operacionais do Diogo e da equipe
 * Retorna true se o comando foi tratado; false caso contrário.
 */
async function processarComandoDiogo({
  texto = '',
  destinoEnvio = '',
  remetenteTelefone = '',
  isImage = false,
  base64Image = null,
  fromMe = false
} = {}) {
  const t = String(texto || '').trim();
  if (!t.startsWith('#')) return false;

  const autor = fromMe ? 'LOJA_LOCAL' : remetenteTelefone;
  const isAutorizado = fromMe || isTelefoneComandoAutorizado(remetenteTelefone) || isTelefoneComandoAutorizado(destinoEnvio);
  
  const lower = t.toLowerCase();

  // --------------------------------------------------------------------------
  // 1. #OFERTA (com ou sem foto)
  // --------------------------------------------------------------------------
  if (lower.startsWith('#oferta') || lower.startsWith('#disparo')) {
    if (!isAutorizado) {
      await whatsappAdapter.enviarTextoUniversal(destinoEnvio, '⛔ *Comando restrito:* Apenas o celular do Diogo ou da gestão pode registrar ofertas.');
      return true;
    }

    const textoOferta = t.replace(/^#(oferta|disparo)\s*/i, '').trim();
    if (!textoOferta && !isImage) {
      await whatsappAdapter.enviarTextoUniversal(
        destinoEnvio,
        '💡 *Como usar o #oferta:*\nEnvie a foto do post/flyer com a legenda:\n*#oferta Olá {nome}! O Macarrão está por R$ 3,99 hoje! Quer separar 1 ou 2 pacotes?*\n\n(Ou envie apenas texto sem foto).'
      );
      return true;
    }

    ofertaRelampagoAtiva = {
      texto: textoOferta || 'Oferta especial de hoje no Coisas da Roça! Aproveite!',
      imagemBase64: (isImage && base64Image) ? base64Image : null,
      criadoPor: autor,
      criadoEm: new Date().toISOString()
    };

    const temFoto = Boolean(ofertaRelampagoAtiva.imagemBase64);
    const msgPrevia = 
      `📋 *OFERTA DO CHEFE REGISTRADA COM SUCESSO!* 🚀\n\n` +
      `📸 *Flyer/Foto anexada:* ${temFoto ? '✅ Sim (pronta para disparo)' : '❌ Não (apenas texto)'}\n` +
      `📝 *Texto promocional:*\n"${ofertaRelampagoAtiva.texto}"\n\n` +
      `👉 *Próximos passos disponíveis no seu celular:*\n` +
      `• *#testar_disparo* ➔ Receber o teste agora no seu WhatsApp para conferir o visual\n` +
      `• *#confirmar_disparo 100* ➔ Iniciar o disparo para 100 clientes com proteção anti-ban e opção SAIR\n` +
      `• Ou envie nova foto com *#oferta* para substituir.`;

    await whatsappAdapter.enviarTextoUniversal(destinoEnvio, msgPrevia);
    return true;
  }

  // --------------------------------------------------------------------------
  // 2. #TESTAR_DISPARO
  // --------------------------------------------------------------------------
  if (lower === '#testar_disparo' || lower === '#teste_disparo' || lower === '#testardisparo') {
    if (!isAutorizado) {
      await whatsappAdapter.enviarTextoUniversal(destinoEnvio, '⛔ *Comando restrito.*');
      return true;
    }

    if (!ofertaRelampagoAtiva || !ofertaRelampagoAtiva.texto) {
      await whatsappAdapter.enviarTextoUniversal(
        destinoEnvio,
        '⚠️ *Nenhuma oferta registrada ainda!*\nEnvie primeiro a foto ou o texto com:\n*#oferta [mensagem da promoção]*'
      );
      return true;
    }

    await whatsappAdapter.enviarTextoUniversal(destinoEnvio, '⏳ *Enviando teste da oferta para o seu celular...*');

    try {
      const telefoneDestinoTeste = remetenteTelefone || destinoEnvio;
      const textoFinalTeste = ofertaRelampagoAtiva.texto.replace(/{nome}/gi, 'Diogo (Teste)');

      if (ofertaRelampagoAtiva.imagemBase64 && typeof whatsappAdapter.enviarImagemUniversal === 'function') {
        await whatsappAdapter.enviarImagemUniversal(telefoneDestinoTeste, ofertaRelampagoAtiva.imagemBase64, textoFinalTeste);
      } else {
        await whatsappAdapter.enviarTextoUniversal(telefoneDestinoTeste, textoFinalTeste);
      }

      await whatsappAdapter.enviarTextoUniversal(
        destinoEnvio,
        '✅ *Teste enviado com sucesso!*\nSe ficou bom, basta enviar:\n*#confirmar_disparo 100* (ou outra quantidade que desejar).'
      );
    } catch (err) {
      await whatsappAdapter.enviarTextoUniversal(destinoEnvio, `❌ *Erro ao enviar teste:* ${err.message}`);
    }
    return true;
  }

  // --------------------------------------------------------------------------
  // 3. #CONFIRMAR_DISPARO [quantidade]
  // --------------------------------------------------------------------------
  if (lower.startsWith('#confirmar_disparo') || lower.startsWith('#confirmardisparo')) {
    if (!isAutorizado) {
      await whatsappAdapter.enviarTextoUniversal(destinoEnvio, '⛔ *Comando restrito ao Diogo.*');
      return true;
    }

    if (!ofertaRelampagoAtiva || !ofertaRelampagoAtiva.texto) {
      await whatsappAdapter.enviarTextoUniversal(
        destinoEnvio,
        '⚠️ *Nenhuma oferta registrada para disparar!*\nEnvie primeiro a foto com:\n*#oferta [mensagem]*'
      );
      return true;
    }

    const matchQtd = t.match(/\d+/);
    const qtdAlvo = matchQtd ? Math.min(Math.max(parseInt(matchQtd[0], 10), 1), 300) : 50;

    await whatsappAdapter.enviarTextoUniversal(
      destinoEnvio,
      `🚀 *DISPARO AUTORIZADO PELO CHEFE!*\n\n` +
      `🎯 *Meta de envio:* ${qtdAlvo} clientes da base\n` +
      `⏱️ *Cadência:* Jitter inteligente de 35s a 75s entre envios\n` +
      `🛑 *Pausa protetiva:* Lotes com pausa a cada 25 envios\n` +
      `🛡️ *Proteção:* Opt-out obrigatório "SAIR"\n\n` +
      `O disparo está rodando em segundo plano. Clientes que responderem terão comandas impressas no Caixa 1!`
    );

    // Executa em background sem travar a requisição do webhook
    setImmediate(async () => {
      try {
        if (disparoHumanizadoService && typeof disparoHumanizadoService.executarCampanhaCoorte === 'function') {
          const resultado = await disparoHumanizadoService.executarCampanhaCoorte({
            tipoCoorte: 'OFERTA_RELAMPAGO_CHEFE',
            templateSpintax: ofertaRelampagoAtiva.texto,
            imagemBase64OuUrl: ofertaRelampagoAtiva.imagemBase64,
            limiteEnvios: qtdAlvo
          });
          console.log('[operacoesHibridasDiogo] Campanha relâmpago concluída:', resultado);
          await whatsappAdapter.enviarTextoUniversal(
            destinoEnvio,
            `🏁 *Disparo concluído!*\n` +
            `• Sucesso: ${resultado.sucesso || 0}\n` +
            `• Falhas/Opt-out: ${resultado.erros || 0}\n` +
            `• Clientes atendidos: ${resultado.processados || 0}`
          );
        }
      } catch (err) {
        console.error('[operacoesHibridasDiogo] Erro ao executar campanha:', err);
      }
    });

    return true;
  }

  // --------------------------------------------------------------------------
  // 4. #STATUS [legenda] (Stories 24h da Loja)
  // --------------------------------------------------------------------------
  if (lower.startsWith('#status')) {
    if (!isAutorizado) {
      await whatsappAdapter.enviarTextoUniversal(destinoEnvio, '⛔ *Comando restrito ao Diogo.*');
      return true;
    }

    const legenda = t.replace(/^#status\s*/i, '').trim();

    await whatsappAdapter.enviarTextoUniversal(destinoEnvio, '⏳ *Publicando no Status do WhatsApp oficial da loja...*');

    try {
      if (typeof publicarStatusWhatsApp === 'function') {
        const resp = await whatsappAdapter.publicarStatusWhatsApp({
          texto: legenda || 'Oferta especial Coisas da Roça!',
          base64OuUrlImagem: (isImage && base64Image) ? base64Image : null
        });

        if (resp && resp.ok) {
          await whatsappAdapter.enviarTextoUniversal(
            destinoEnvio,
            '📸 *Status publicado com sucesso no WhatsApp da Loja!*\nJá está visível para todos os contatos salvos por 24 horas.'
          );
        } else {
          await whatsappAdapter.enviarTextoUniversal(
            destinoEnvio,
            `⚠️ *Aviso ao publicar Status:* A rota de Status não foi aceita pela instância atual (${resp?.motivo || 'Erro'}). Mas a oferta segue disponível para disparo!`
          );
        }
      }
    } catch (err) {
      await whatsappAdapter.enviarTextoUniversal(destinoEnvio, `❌ *Erro ao publicar status:* ${err.message}`);
    }
    return true;
  }

  return false;
}

module.exports = {
  isTelefoneComandoAutorizado,
  processarComandoDiogo
};
