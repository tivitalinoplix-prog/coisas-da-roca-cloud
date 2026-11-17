/**
 * SERVIÇO DE DISPARO HUMANIZADO & ENGENHARIA ANTI-BAN - COISAS DA ROÇA
 * Açougue e Mercearia Artesanal de Macaé/RJ
 * 
 * Funcionalidades:
 * 1. Resolução dinâmica de Spintax ({Bom dia|Olá|Oi, tudo bem?})
 * 2. Jitter randômico com delays variáveis de 35s a 75s
 * 3. Pausas automáticas de lote (5 a 8 minutos a cada 25 envios)
 * 4. Trava de janela comercial (08:30-11:30 e 14:00-17:30)
 * 5. Trava diária de teto de disparos (250 a 400/dia)
 * 6. Proteção absoluta de Opt-Out e Contatos Especiais (motoboys/funcionários/parceiros)
 * 7. Respeito ao MODO_TESTE_EXCLUSIVO
 */

const fs = require('fs');
const path = require('path');
const { pool } = require('../database');
const { enviarTextoUniversal } = require('./whatsappUniversalAdapter');

// Carregar contatos especiais bloqueados para campanhas (raiz do projeto)
function carregarContatosBloqueados() {
  const contatosEspeciaisPath = path.join(__dirname, '..', '..', '..', 'config', 'contatos_especiais.json');
  if (fs.existsSync(contatosEspeciaisPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(contatosEspeciaisPath, 'utf-8'));
      // Bloqueia qualquer contato marcado com auto_responder === false ou do tipo ADMIN/FUNCIONARIO/PARCEIRO_B2B/SUPORTE_TI
      return Object.keys(data).filter(tel => data[tel].auto_responder === false || data[tel].tipo !== 'TESTE');
    } catch (e) {
      console.warn('Aviso: erro ao ler contatos_especiais.json:', e.message);
    }
  }
  return [];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Resolve Spintax: substitui blocos {opcao1|opcao2|opcao3} por uma opção aleatória
 */
function resolverSpintax(texto) {
  if (!texto) return '';
  const regex = /\{([^{}]+)\}/g;
  let resolvido = texto;
  while (regex.test(resolvido)) {
    resolvido = resolvido.replace(regex, (match, opcoes) => {
      const lista = opcoes.split('|');
      return lista[Math.floor(Math.random() * lista.length)];
    });
  }
  return resolvido;
}

/**
 * Valida se o momento atual está dentro da janela permitida para disparos comerciais
 */
function isJanelaComercialPermitida() {
  const agora = new Date();
  // Horário de Brasília (UTC-3)
  const horaUtc = agora.getUTCHours();
  const minutoUtc = agora.getUTCMinutes();
  const diaSemana = agora.getUTCDay(); // 0 = Domingo, 6 = Sábado

  // Domingo não dispara promoções
  if (diaSemana === 0) return false;

  const horaLocal = (horaUtc - 3 + 24) % 24;
  const minutosTotais = horaLocal * 60 + minutoUtc;

  const inicioManha = 8 * 60 + 30; // 08:30
  const fimManha = 11 * 60 + 30;   // 11:30

  const inicioTarde = 14 * 60;      // 14:00
  const fimTarde = 17 * 60 + 30;    // 17:30

  const dentroManha = minutosTotais >= inicioManha && minutosTotais <= fimManha;
  const dentroTarde = minutosTotais >= inicioTarde && minutosTotais <= fimTarde;

  return dentroManha || dentroTarde;
}

// Contador diário em memória
let contadorDisparosHoje = {
  data: new Date().toDateString(),
  total: 0
};

function incrementarContadorDiario() {
  const hoje = new Date().toDateString();
  if (contadorDisparosHoje.data !== hoje) {
    contadorDisparosHoje.data = hoje;
    contadorDisparosHoje.total = 0;
  }
  contadorDisparosHoje.total++;
  return contadorDisparosHoje.total;
}

function obterTotalDisparosHoje() {
  const hoje = new Date().toDateString();
  if (contadorDisparosHoje.data !== hoje) {
    contadorDisparosHoje.data = hoje;
    contadorDisparosHoje.total = 0;
  }
  return contadorDisparosHoje.total;
}

/**
 * Personaliza a mensagem com o primeiro nome do cliente e rodapé de opt-out
 */
function formatarMensagemParaCliente(templateSpintax, nomeCliente) {
  let primeiroNome = 'amigo(a)';
  if (nomeCliente && typeof nomeCliente === 'string') {
    const limpo = nomeCliente.trim().replace(/^(Sr\.|Sra\.|Dona|Seu|Dr\.|Dra\.)\s+/i, '');
    const partes = limpo.split(/\s+/);
    if (partes[0] && partes[0].length >= 2) {
      primeiroNome = partes[0].charAt(0).toUpperCase() + partes[0].slice(1).toLowerCase();
    }
  }

  // 1. Substitui {nome} ANTES do processador de spintax
  let textoPersonalizado = templateSpintax.replace(/\{nome\}/gi, primeiroNome);

  // 2. Resolve todas as variações de Spintax
  let textoResolvido = resolverSpintax(textoPersonalizado);

  // 3. Rodapé obrigatório de opt-out anti-denúncia
  const rodapeOptOut = '\n\n_(Para não receber mais novidades, responda SAIR)_';
  if (!textoResolvido.includes('SAIR')) {
    textoResolvido += rodapeOptOut;
  }

  return textoResolvido;
}

/**
 * Envia uma mensagem individual respeitando todas as regras de proteção
 */
async function enviarMensagemIndividualHumanizada({ telefone, nome, templateSpintax, origemCampanha = 'GERAL' }) {
  const cleanPhone = String(telefone).replace(/[^0-9]/g, '');
  if (!cleanPhone || cleanPhone.length < 10) {
    return { sucesso: false, motivo: 'TELEFONE_INVALIDO' };
  }

  // 1. Verificação de Modo de Teste Restrito
  const modoTeste = process.env.MODO_TESTE_EXCLUSIVO === 'true';
  const telefonesTestadores = (process.env.TELEFONES_TESTADORES || '5522998586180')
    .split(',')
    .map(t => t.trim().replace(/[^0-9]/g, ''));

  if (modoTeste && !telefonesTestadores.includes(cleanPhone)) {
    console.log(`🔒 [Disparo Humanizado] Disparo para ${cleanPhone} bloqueado por MODO_TESTE_EXCLUSIVO.`);
    return { sucesso: false, motivo: 'MODO_TESTE_ATIVO' };
  }

  // 2. Verificação de Contatos Especiais Bloqueados (motoboys, suporte, parceiros B2B, equipe)
  const contatosBloqueados = carregarContatosBloqueados();
  if (contatosBloqueados.includes(cleanPhone)) {
    console.log(`👤 [Disparo Humanizado] ${cleanPhone} é contato interno/parceiro especial. Disparo bloqueado com sucesso!`);
    return { sucesso: false, motivo: 'CONTATO_ESPECIAL_BLOQUEADO' };
  }

  // 3. Monta texto personalizado com Spintax
  const textoFinal = formatarMensagemParaCliente(templateSpintax, nome);

  try {
    console.log(`📤 [Disparo Humanizado] Enviando para ${nome || 'Cliente'} (${cleanPhone})...`);
    const retorno = await enviarTextoUniversal(cleanPhone, textoFinal);

    incrementarContadorDiario();

    // Atualiza metadados no Supabase
    await pool.query(
      `UPDATE clientes 
       SET ultima_notificacao = NOW(),
           total_notificacoes = COALESCE(total_notificacoes, 0) + 1
       WHERE telefone = $1;`,
      [cleanPhone]
    ).catch(e => console.warn('Aviso update cliente:', e.message));

    // Registra na tabela de conversas para histórico
    await pool.query(
      `INSERT INTO conversas (cliente_telefone, nome_cliente, mensagem_cliente, tipo_mensagem, resposta_ia, tempo_resposta_ms, criado_em)
       VALUES ($1, $2, $3, 'texto', $4, 0, NOW());`,
      [cleanPhone, nome, `[CAMPANHA: ${origemCampanha}]`, textoFinal]
    ).catch(e => console.warn('Aviso insert conversa:', e.message));

    return { sucesso: true, retorno };
  } catch (err) {
    console.error(`❌ [Disparo Humanizado] Falha ao enviar para ${cleanPhone}:`, err.message);
    return { sucesso: false, motivo: err.message };
  }
}

/**
 * Executa uma campanha segmentada para uma Coorte específica
 */
async function executarCampanhaCoorte({
  tipoCoorte,          // 'REATIVACAO_D15', 'CHURRASCO_SEXTA', 'DIA_A_DIA', 'AGUA_20L'
  templateSpintax,
  limiteDisparos = 250, // Padrão seguro na rampa de aquecimento
  forcarHorario = false // true apenas para testes manuais
}) {
  console.log('======================================================================');
  console.log(`📢 INICIANDO DISPARO HUMANIZADO - COORTE: ${tipoCoorte}`);
  console.log(`🎯 Meta do Lote: ${limiteDisparos} clientes | Teto Hoje: ${obterTotalDisparosHoje()}`);
  console.log('======================================================================');

  if (!forcarHorario && !isJanelaComercialPermitida()) {
    console.log('⛔ Fora da janela comercial de atendimento (08:30-11:30 ou 14:00-17:30). Campanha pausada.');
    return { executado: false, motivo: 'FORA_DA_JANELA_COMERCIAL' };
  }

  // 1. Consulta clientes elegíveis no Supabase de acordo com a Coorte
  let querySql = '';
  let queryParams = [limiteDisparos];

  if (tipoCoorte === 'REATIVACAO_D15') {
    querySql = `
      SELECT telefone, nome 
      FROM clientes 
      WHERE opt_out = false 
        AND (ultima_compra <= NOW() - INTERVAL '15 days' OR ultima_compra IS NULL)
        AND (ultima_notificacao <= NOW() - INTERVAL '7 days' OR ultima_notificacao IS NULL)
      ORDER BY COALESCE(ultima_notificacao, '2000-01-01'::timestamptz) ASC
      LIMIT $1;
    `;
  } else if (tipoCoorte === 'CHURRASCO_SEXTA') {
    querySql = `
      SELECT telefone, nome 
      FROM clientes 
      WHERE opt_out = false 
        AND ('churrasco' = ANY(tags) OR tags IS NULL OR tags = '{}')
        AND (ultima_notificacao <= NOW() - INTERVAL '5 days' OR ultima_notificacao IS NULL)
      ORDER BY COALESCE(ultima_notificacao, '2000-01-01'::timestamptz) ASC
      LIMIT $1;
    `;
  } else if (tipoCoorte === 'AGUA_20L') {
    querySql = `
      SELECT telefone, nome 
      FROM clientes 
      WHERE opt_out = false 
        AND ('agua' = ANY(tags) OR tags IS NULL OR tags = '{}')
        AND (ultima_notificacao <= NOW() - INTERVAL '4 days' OR ultima_notificacao IS NULL)
      ORDER BY COALESCE(ultima_notificacao, '2000-01-01'::timestamptz) ASC
      LIMIT $1;
    `;
  } else {
    querySql = `
      SELECT telefone, nome 
      FROM clientes 
      WHERE opt_out = false 
        AND (ultima_notificacao <= NOW() - INTERVAL '7 days' OR ultima_notificacao IS NULL)
      ORDER BY COALESCE(ultima_notificacao, '2000-01-01'::timestamptz) ASC
      LIMIT $1;
    `;
  }

  const res = await pool.query(querySql, queryParams);
  const clientes = res.rows || [];
  console.log(`📦 Encontrados ${clientes.length} clientes elegíveis para a Coorte ${tipoCoorte}.`);

  if (clientes.length === 0) {
    return { executado: true, totalEnviados: 0, mensagem: 'Nenhum cliente elegível pendente no momento.' };
  }

  let enviados = 0;
  let falhas = 0;

  for (let i = 0; i < clientes.length; i++) {
    const c = clientes[i];

    // Trava de segurança: limite diário global
    if (obterTotalDisparosHoje() >= 400) {
      console.log('🛑 Limite máximo diário de segurança (400 mensagens) atingido. Interrompendo fila do dia.');
      break;
    }

    // A) Envio individual com personalização
    const resultado = await enviarMensagemIndividualHumanizada({
      telefone: c.telefone,
      nome: c.nome,
      templateSpintax,
      origemCampanha: tipoCoorte
    });

    if (resultado.sucesso) enviados++;
    else falhas++;

    // B) Pausa Longa de Balcão a cada 25 mensagens (entre 5 e 8 minutos)
    if (enviados > 0 && enviados % 25 === 0 && i < clientes.length - 1) {
      const pausaLoteMin = Math.floor(Math.random() * (8 - 5 + 1)) + 5;
      console.log(`☕ [Anti-Ban] Lote de 25 mensagens concluído. Pausa natural de balcão de ${pausaLoteMin} minutos...`);
      await sleep(pausaLoteMin * 60 * 1000);
      continue;
    }

    // C) Jitter Randômico entre envios (35s a 75s)
    if (i < clientes.length - 1) {
      const delaySegundos = Math.floor(Math.random() * (75 - 35 + 1)) + 35;
      console.log(`⏳ [Anti-Ban] Aguardando ${delaySegundos}s para o próximo cliente (jitter randômico)...`);
      await sleep(delaySegundos * 1000);
    }
  }

  console.log('======================================================================');
  console.log(`🎉 CAMPANHA ${tipoCoorte} FINALIZADA!`);
  console.log(`✅ Total Enviados: ${enviados} | ⚠️ Falhas/Bloqueios: ${falhas} | Total Hoje: ${obterTotalDisparosHoje()}`);
  console.log('======================================================================');

  return {
    executado: true,
    coorte: tipoCoorte,
    enviados,
    falhas,
    totalHoje: obterTotalDisparosHoje()
  };
}

module.exports = {
  resolverSpintax,
  isJanelaComercialPermitida,
  formatarMensagemParaCliente,
  enviarMensagemIndividualHumanizada,
  executarCampanhaCoorte,
  obterTotalDisparosHoje
};
