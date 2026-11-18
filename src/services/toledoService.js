/**
 * Decodificador de Etiquetas Toledo Prix 4 (Padrão C23 / MGV5)
 * Padrão: 2 + CCCCC (PLU 5 dígitos) + TTTTT (Total R$ centavos 5 dígitos) + D (Dígito Verificador)
 */
function decodificarEtiquetaC23(barcode, precoKg = null) {
  if (!barcode || typeof barcode !== 'string') {
    return { valido: false, erro: 'Código de barras ausente' };
  }

  const limpo = barcode.trim().replace(/\D/g, '');
  if (limpo.length !== 13 || !limpo.startsWith('2')) {
    return { valido: false, erro: 'Código deve ter 13 dígitos e iniciar com o dígito 2' };
  }

  const plu = limpo.substring(1, 6);
  const centavos = parseInt(limpo.substring(6, 11), 10);
  const valorTotalReais = centavos / 100;

  let pesoLiquidoKg = null;
  let pesoGramas = null;

  if (precoKg && precoKg > 0) {
    pesoLiquidoKg = Number((valorTotalReais / precoKg).toFixed(3));
    pesoGramas = Math.round(pesoLiquidoKg * 1000);
  }

  return {
    valido: true,
    padrao: 'C23_VALOR_TOTAL',
    plu,
    valor_total_reais: valorTotalReais,
    preco_kg_aplicado: precoKg,
    peso_liquido_kg: pesoLiquidoKg,
    peso_gramas: pesoGramas
  };
}

function validarToleranciaCorte(pesoEstimadoGramas, pesoRealGramas, toleranciaPercentual = 10.0) {
  if (!pesoEstimadoGramas || !pesoRealGramas) return { aprovado: true };
  const variacao = Math.abs(pesoRealGramas - pesoEstimadoGramas);
  const perc = (variacao / pesoEstimadoGramas) * 100;

  return {
    aprovado: perc <= toleranciaPercentual,
    variacao_gramas: variacao,
    percentual_variacao: Number(perc.toFixed(2)),
    acao_sugerida: perc <= toleranciaPercentual ? 'LIBERAR_CHECKOUT' : 'ALERTA_BALCAO_RECONFERENCIA'
  };
}

module.exports = { decodificarEtiquetaC23, validarToleranciaCorte };
