const { pool } = require('./database');

async function main() {
  try {
    console.log('--- 1. Conversas do Alex ---');
    const resAlex = await pool.query(`
      SELECT id, cliente_telefone, nome_cliente, tipo_mensagem, mensagem_cliente, resposta_ia, criado_em 
      FROM conversas 
      WHERE nome_cliente ILIKE '%alex%' 
         OR mensagem_cliente ILIKE '%alex%'
         OR mensagem_cliente ILIKE '%agua%'
         OR mensagem_cliente ILIKE '%galao%'
      ORDER BY id DESC 
      LIMIT 10;
    `);
    console.log(JSON.stringify(resAlex.rows, null, 2));

    console.log('\n--- 2. Conversas com Diogo Farah ---');
    const resDiogo = await pool.query(`
      SELECT id, cliente_telefone, nome_cliente, tipo_mensagem, mensagem_cliente, resposta_ia, criado_em 
      FROM conversas 
      WHERE cliente_telefone LIKE '%999766763%' 
         OR nome_cliente ILIKE '%diogo%'
      ORDER BY id DESC 
      LIMIT 10;
    `);
    console.log(JSON.stringify(resDiogo.rows, null, 2));

    console.log('\n--- 3. Produtos de Água cadastrados ---');
    const resAgua = await pool.query(`
      SELECT id_sgm, descricao, preco, balanca, ativo 
      FROM produtos 
      WHERE ativo = true 
        AND (descricao ILIKE '%AGUA%' OR descricao ILIKE '%GALAO%' OR descricao ILIKE '%REFIL%')
        AND descricao NOT ILIKE '%SANITARIA%'
      ORDER BY preco ASC;
    `);
    console.log(JSON.stringify(resAgua.rows, null, 2));

    console.log('\n--- 4. Pé de Galinha cadastrado ---');
    const resPe = await pool.query(`
      SELECT id_sgm, descricao, preco, balanca, ativo 
      FROM produtos 
      WHERE ativo = true 
        AND (descricao ILIKE '%PE %' OR descricao ILIKE '%PES %' OR descricao ILIKE '%GALINHA%')
      ORDER BY descricao ASC;
    `);
    console.log(JSON.stringify(resPe.rows, null, 2));

  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
}

main();
