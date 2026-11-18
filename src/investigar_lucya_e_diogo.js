const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PG_HOST,
  port: parseInt(process.env.PG_PORT || '5432'),
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  try {
    console.log('--- Ultimas 10 conversas registradas ---');
    const res = await pool.query("SELECT id, cliente_telefone, nome_cliente, mensagem_cliente, resposta_ia, criado_em FROM conversas ORDER BY id DESC LIMIT 10");
    console.log(JSON.stringify(res.rows, null, 2));

    console.log('\n--- Pedido da Lucya na fila de impressao ---');
    const resFila = await pool.query("SELECT * FROM fila_impressao WHERE cliente_nome ILIKE '%lucya%' OR pedido_id = 'PED-028476'");
    console.log(JSON.stringify(resFila.rows, null, 2));
  } catch(e) {
    console.error(e.message);
  } finally {
    await pool.end();
  }
}

main();
