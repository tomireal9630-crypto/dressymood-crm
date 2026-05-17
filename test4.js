const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
      const order = await pool.query(
          'INSERT INTO orders (customer_id, article, size, color, status, price, cost, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
          [1, 'ART-1', '', '', 'Новий', "" || 0, "" || 0, 'Вручну']
      );
      console.log('Orders test OK with empty strings');
  } catch (e) {
      console.error('Orders error:', e.message);
  }
  pool.end();
}

run();
