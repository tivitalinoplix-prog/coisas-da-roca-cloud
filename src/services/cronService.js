const cron = require('node-cron');
const { executarCampanhaCoorte } = require('./disparoHumanizadoService');
const { executarFechamentoExpediente } = require('./fechamentoExpedienteService');
const redisService = require('./redisService');

function iniciarRotinasAgendadas() {
  // 1. Coorte Reativação D+15: Terça e Quinta às 09:30
  cron.schedule('30 9 * * 2,4', async () => {
    const templateReativacao = `{Bom dia|Olá|Oi, tudo bem?}, {nome}! {Aqui é a equipe do Açougue e Mercearia Coisas da Roça|Aqui é do Coisas da Roça|Aqui é a Jussara do balcão do Coisas da Roça}. {Notamos que já faz uns dias que você não passa por aqui|Sentimos sua falta por aqui no balcão|Passando para saber como você e a família estão}! {Hoje recebemos cortes fresquinhos de primeira, moída bem magrinha e produtos artesanais da roça|Chegaram carnes selecionadas fresquinhas e queijos da roça|Temos cortes especiais fresquinhos prontos para o almoço}. Se quiser que a gente separe algo para entrega na sua casa ou retirada, é só mandar uma mensagem ou áudio por aqui! 🥩👍`;

    try {
      if (await redisService.obterPausaGlobal()) { console.log('[CRON] ⏸️ Automação pausada globalmente. Disparo cancelado.'); return; }
    await executarCampanhaCoorte({
        tipoCoorte: 'REATIVACAO_D15',
        templateSpintax: templateReativacao,
        limiteDisparos: 250,
      });
    } catch (err) {
      console.error('[CRON D+15] Erro:', err.message);
    }
  }, { timezone: 'America/Sao_Paulo' });

  // 2. Coorte Churrasco do Fim de Semana: Sexta-feira às 10:00
  cron.schedule('0 10 * * 5', async () => {
    const templateChurrasco = `{Olá|Oi|Bom dia}, {nome}! {Sextou com muita carne boa no Coisas da Roça!|O fim de semana chegou no Coisas da Roça!|Preparando o churrasco do fim de semana?} 🥩 {Chegaram cortes nobres de Contra Filé Chorizo, Picanha bovina e Alcatra com maminha|Recebemos picanha fresquinha, linguiças artesanais e queijo coalho de primeira|Temos carvão especial, queijos da roça e cortes nobres fresquinhos}. Quer que a gente já adiante o seu pedido para entrega hoje aí na sua casa? É só mandar mensagem ou áudio que já organizamos tudo no balcão! 👍`;

    try {
      if (await redisService.obterPausaGlobal()) { console.log('[CRON] ⏸️ Automação pausada globalmente. Disparo cancelado.'); return; }
    await executarCampanhaCoorte({
        tipoCoorte: 'CHURRASCO_SEXTA',
        templateSpintax: templateChurrasco,
        limiteDisparos: 350,
      });
    } catch (err) {
      console.error('[CRON Churrasco] Erro:', err.message);
    }
  }, { timezone: 'America/Sao_Paulo' });

  // 3. Coorte Galão de Água 20L: Sábado às 09:00
  cron.schedule('0 9 * * 6', async () => {
    const templateAgua = `{Bom dia|Olá|Oi}, {nome}! {Passando para lembrar da água mineral para o fim de semana!|Já conferiu como está o galão de água em casa?|Aqui é do Coisas da Roça com água mineral fresquinha!} {Temos refil de 20L para troca: Areia Branca R$ 13,00 e Serra do Segredo R$ 13,50|Galões de 20L prontos para entrega imediata em Macaé}. Se precisar repor o galão para o fim de semana, é só avisar por aqui que o motoboy já leva aí para você! 🛵`;

    try {
      if (await redisService.obterPausaGlobal()) { console.log('[CRON] ⏸️ Automação pausada globalmente. Disparo cancelado.'); return; }
    await executarCampanhaCoorte({
        tipoCoorte: 'AGUA_20L',
        templateSpintax: templateAgua,
        limiteDisparos: 250,
      });
    } catch (err) {
      console.error('[CRON Água 20L] Erro:', err.message);
    }
  }, { timezone: 'America/Sao_Paulo' });

  // 4. Sentinela SGM: Sincronização automática a cada 5 minutos
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { sincronizarSgmComSupabase } = require('./produtosService');
      await sincronizarSgmComSupabase();
    } catch (e) {
      console.error('[Sentinela SGM CRON] Erro:', e.message);
    }
  });

  // 5. Fechamento Automático de Expediente: Todos os dias às 19h30
  cron.schedule('30 19 * * *', async () => {
    try {
      console.log('[CRON 19h30] Executando fechamento diário de expediente...');
      await executarFechamentoExpediente();
    } catch (e) {
      console.error('[CRON 19h30] Erro no fechamento de expediente:', e.message);
    }
  }, { timezone: 'America/Sao_Paulo' });

  console.log('[CRON] Rotinas agendadas (D+15, Churrasco, Água 20L, Sentinela SGM e Fechamento 19h30) ativas.');
}

module.exports = { iniciarRotinasAgendadas };
