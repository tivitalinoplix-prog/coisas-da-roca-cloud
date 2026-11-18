const { decodificarEtiquetaC23 } = require('./toledoService');
const { carregarCatalogo } = require('./produtosService');
const redisService = require('./redisService');
const whatsappAdapter = require('./whatsappUniversalAdapter');

const CHAVE_PIX_LOJA = process.env.CHAVE_PIX_LOJA || process.env.CNPJ_PIX_LOJA || '22997621921';

/**
 * Valida o dígito verificador padrão EAN-13 para evitar leituras truncadas do leitor USB.
 */
function validarChecksumEan13(barcode = '') {
  const limpo = String(barcode).replace(/\D/g, '');
  if (limpo.length !== 13) return false;
  let soma = 0;
  for (let i = 0; i < 12; i++) {
    const digito = parseInt(limpo[i], 10);
    soma += i % 2 === 0 ? digito : digito * 3;
  }
  const dvCalculado = (10 - (soma % 10)) % 10;
  return dvCalculado === parseInt(limpo[12], 10);
}

/**
 * Processa o código de barras EAN-13 C23 lido no Caixa 1 (Toledo Prix 4) e envia o valor exato + Pix ao cliente.
 */
async function processarEtiquetaPesagemEan13({ barcode, codigoPedido = null, telefoneCliente = null }) {
  const limpo = String(barcode || '').replace(/\D/g, '');
  if (!limpo || limpo.length !== 13 || !limpo.startsWith('2')) {
    throw new Error('Etiqueta EAN-13 C23 inválida (deve ter 13 dígitos e iniciar com 2).');
  }

  // Idempotência para não cobrar duas vezes se a operadora bipar a etiqueta duas vezes
  const dedupKey = `ean13:${codigoPedido || 'avulso'}:${limpo}`;
  const jaProcessado = await redisService.verificarEDeduplicarMensagem(dedupKey, 600);
  if (jaProcessado) {
    return { duplicado: true, mensagem: 'Etiqueta já processada recentemente.' };
  }

  const pedidoAtivo = await redisService.buscarPedidoAguardandoPesagem(codigoPedido);
  const destino = telefoneCliente || pedidoAtivo?.clienteTelefone || '';

  // Tenta identificar o produto pelo código PLU no catálogo SGM
  const pluNum = String(parseInt(limpo.substring(1, 6), 10));
  const catalogo = carregarCatalogo();
  const prodSgm = catalogo.find((p) => String(p.codigo) === pluNum);
  const precoKg = prodSgm?.preco || null;

  const decodificado = decodificarEtiquetaC23(limpo, precoKg);
  if (!decodificado.valido) {
    throw new Error(decodificado.erro || 'Falha ao decodificar etiqueta.');
  }

  const valorFormatado = decodificado.valor_total_reais.toFixed(2).replace('.', ',');
  const nomeCorte = prodSgm?.nome || 'Corte pesado na balança';
  const infoPeso = decodificado.peso_liquido_kg
    ? ` (${decodificado.peso_liquido_kg.toFixed(3).replace('.', ',')} kg)`
    : '';

  if (destino) {
    const msgCliente =
      `🥩 *Pesagem Concluída na Balança!*\n\n` +
      `> *Comprovante de Pesagem*\n` +
      `• *${nomeCorte}*${infoPeso} — *R$ ${valorFormatado}*\n\n` +
      `💠 *Chave Pix para pagamento:*\n\`${CHAVE_PIX_LOJA}\`\n\n` +
      `_Assim que confirmar o Pix, nosso motoboy já sai para a entrega!_ 🛵`;

    await whatsappAdapter.enviarTextoUniversal(destino, msgCliente);
  }

  return {
    ok: true,
    checksumValido: validarChecksumEan13(limpo),
    plu: pluNum,
    produto: nomeCorte,
    pesoKg: decodificado.peso_liquido_kg,
    valorReal: decodificado.valor_total_reais,
    clienteNotificado: Boolean(destino),
  };
}

module.exports = {
  validarChecksumEan13,
  processarEtiquetaPesagemEan13,
};
