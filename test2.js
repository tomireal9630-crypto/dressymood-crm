const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
      console.log('Testing Suppliers exactly like server.js...');
      await pool.query('INSERT INTO suppliers (name) VALUES ($1) ON CONFLICT DO NOTHING', ['Test Supplier 2']);
      console.log('Suppliers test OK');
  } catch (e) {
      console.error('Suppliers error:', e.message);
  }

  try {
      console.log('Testing Products exactly like server.js...');
      await pool.query(
          'INSERT INTO products (article, name, cost, price, supplier_id, links) VALUES ($1, $2, $3, $4, $5, $6)',
          ['TEST-123', 'Test Product 2', 100, 200, null, '']
      );
      console.log('Products test OK');
  } catch (e) {
      console.error('Products error:', e.message);
  }

  try {
      console.log('Testing Orders exactly like server.js...');
      let fullName = 'John Doe', phone = '987654321', article = 'ART-1', size = '', color = '', price = 100, cost = 50, source = 'Вручну';
      
      let custResult = await pool.query('SELECT id FROM customers WHERE phone = $1', [phone]);
      let customerId;
      if (custResult.rows.length > 0) {
          customerId = custResult.rows[0].id;
          await pool.query('UPDATE customers SET full_name = $1 WHERE id = $2', [fullName, customerId]);
      } else {
          const newCust = await pool.query('INSERT INTO customers (full_name, phone) VALUES ($1, $2) RETURNING id', [fullName, phone]);
          customerId = newCust.rows[0].id;
      }
      const order = await pool.query(
          'INSERT INTO orders (customer_id, article, size, color, status, price, cost, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
          [customerId, article, size || '', color || '', 'Новий', price || 0, cost || 0, source || 'Вручну']
      );
      console.log('Orders test OK');
  } catch (e) {
      console.error('Orders error:', e.message);
  }

  pool.end();
}

run();
