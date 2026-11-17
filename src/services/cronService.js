const cron = require('node-cron');
const { executarCampanhaCoorte } = require('./disparoHumanizadoService');

function iniciarRotinasAgendadas() {
  // 1. Coorte Reativação D+15: Terça e Quinta às 09:30 (horário de balcão)
  cron.schedule('30 9 * * 2,4', async () => {
    console.log('⏰ [CRON D+15]: Disparando rotina de Reativação de Clientes Sumidos...');
    const templateReativacao = `{Bom dia|Olá|Oi, tudo bem?}, {nome}! {Aqui é a equipe do Açougue e Mercearia Coisas da Roça|Aqui é do Coisas da Roça|Aqui é a Jussara do balcão do Coisas da Roça}. {Notamos que já faz uns dias que você não passa por aqui|Sentimos sua falta por aqui no balcão|Passando para saber como você e a família estão}! {Hoje recebemos cortes fresquinhos de primeira, moída bem magrinha e produtos artesanais da roça|Chegaram carnes selecionadas fresquinhas e queijos da roça deliciosos|Temos cortes especiais fresquinhos prontos para o almoço}. Se quiser que a gente separe algo para entrega na sua casa ou retirada, é só mandar uma mensagem ou áudio por aqui! 😉🌾`;

    try {
      await executarCampanhaCoorte({
        tipoCoorte: 'REATIVACAO_D15',
        templateSpintax: templateReativacao,
        limiteDisparos: 250
      });
    } catch (err) {
      console.error('❌ Erro no cron D+15:', err.message);
    }
  });

  // 2. Coorte Churrasco do Fim de Semana: Sexta-feira às 10:00
  cron.schedule('0 10 * * 5', async () => {
    console.log('⏰ [CRON CHURRASCO]: Disparando rotina de Sexta-feira (Churrasco)...');
    const templateChurrasco = `{Olá|Oi|Bom dia}, {nome}! {Sextou com muita carne boa no Coisas da Roça!|O fim de semana chegou no Coisas da Roça!|Preparando o churrasco do fim de semana?} 🥩🔥 {Chegaram cortes nobres de Contra Filé Chorizo, Picanha bovina e Alcatra com maminha|Recebemos picanha fresquinha, linguiças artesanais e queijo coalho de primeira|Temos carvão especial, queijos da roça e cortes nobres fresquinhos}. Quer que a gente já adiante o seu pedido para entrega hoje aí na sua casa? É só mandar mensagem ou áudio que já organizamos tudo no balcão! 😉🌾`;

    try {
      await executarCampanhaCoorte({
        tipoCoorte: 'CHURRASCO_SEXTA',
        templateSpintax: templateChurrasco,
        limiteDisparos: 350
      });
    } catch (err) {
      console.error('❌ Erro no cron Churrasco:', err.message);
    }
  });

  // 3. Coorte Galão de Água 20L: Sábado às 09:00
  cron.schedule('0 9 * * 6', async () => {
    console.log('⏰ [CRON ÁGUA 20L]: Disparando lembrete de troca de galão de sábado...');
    const templateAgua = `{Bom dia|Olá|Oi}, {nome}! {Passando para lembrar da água mineral para o fim de semana!|Já conferiu como está o galão de água em casa?|Aqui é do Coisas da Roça com água mineral fresquinha!} 💧 {Temos refil de 20L para troca: Cascatazul R$ 9,00, Areia Branca R$ 13,00, Serra do Segredo R$ 13,50 e Raposo R$ 14,99|Galões de 20L fresquinhos prontos para entrega imediata em Macaé}. Se precisar repor o galão para o fim de semana, é só avisar por aqui que o motoboy já leva aí para você! 😉🛵`;

    try {
      await executarCampanhaCoorte({
        tipoCoorte: 'AGUA_20L',
        templateSpintax: templateAgua,
        limiteDisparos: 250
      });
    } catch (err) {
      console.error('❌ Erro no cron Água 20L:', err.message);
    }
  });

  // 4. Sentinela SGM: Sincronização automática com Servidor a cada 5 minutos
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { sincronizarSgmComSupabase } = require('./produtosService');
      await sincronizarSgmComSupabase();
    } catch (e) {
      console.error('❌ [Sentinela SGM CRON] Erro:', e.message);
    }
  });

  console.log('✅ Rotinas de Disparo Humanizado (D+15, Churrasco, Água 20L) e Sentinela SGM (5min) ativadas.');
}

module.exports = { iniciarRotinasAgendadas };
