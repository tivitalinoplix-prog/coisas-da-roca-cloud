const { buscarProdutosRelevantes } = require('./services/produtosService');
const { pool } = require('./database');

async function main() {
  try {
    const res = await buscarProdutosRelevantes('pe de galinha');
    console.log('Resultado buscarProdutosRelevantes("pe de galinha"):', JSON.stringify(res, null, 2));

    const resAgua = await buscarProdutosRelevantes('entrega de agua');
    console.log('Resultado buscarProdutosRelevantes("entrega de agua"):', JSON.stringify(resAgua, null, 2));
  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
}

main();
