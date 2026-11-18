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
    const res = await pool.query("SELECT * FROM conversas WHERE cliente_telefone LIKE '%999766763%' OR cliente_telefone LIKE '%998586180%' OR nome_cliente ILIKE '%diogo%' ORDER BY id DESC LIMIT 10");
    console.log('Conversas do Diogo no banco:', JSON.stringify(res.rows, null, 2));
  } finally {
    await pool.end();
  }
}

main();
