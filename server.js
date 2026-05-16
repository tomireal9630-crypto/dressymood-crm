require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const session = require('express-session');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// --- АВТОМАТИЧНЕ ОНОВЛЕННЯ БАЗИ ДАНИХ ---
async function updateDatabaseSchema() {
    try {
        await pool.query(`
            ALTER TABLE orders 
            ADD COLUMN IF NOT EXISTS article VARCHAR(255) DEFAULT '',
            ADD COLUMN IF NOT EXISTS size VARCHAR(50) DEFAULT '',
            ADD COLUMN IF NOT EXISTS color VARCHAR(50) DEFAULT '',
            ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Новий',
            ADD COLUMN IF NOT EXISTS ttn VARCHAR(255) DEFAULT '',
            ADD COLUMN IF NOT EXISTS price NUMERIC DEFAULT 0,
            ADD COLUMN IF NOT EXISTS cost NUMERIC DEFAULT 0,
            ADD COLUMN IF NOT EXISTS source VARCHAR(100) DEFAULT 'Вручну',
            ADD COLUMN IF NOT EXISTS comment TEXT DEFAULT '';

            CREATE TABLE IF NOT EXISTS suppliers (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL UNIQUE
            );

            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                article VARCHAR(255) NOT NULL,
                name VARCHAR(255) NOT NULL,
                cost NUMERIC DEFAULT 0,
                price NUMERIC DEFAULT 0,
                supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
                links TEXT DEFAULT ''
            );
        `);
        console.log("Таблиці бази даних успішно перевірені та оновлені (Склад додано).");
    } catch (err) {
        console.error("Помилка оновлення бази даних:", err);
    }
}
updateDatabaseSchema();
// -----------------------------------------

app.use(session({
  secret: process.env.SESSION_SECRET || 'tomireal_space_layout',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const checkAuth = (req, res, next) => {
  if (req.session.isLoggedIn) next();
  else req.path.startsWith('/api/') ? res.status(401).json({ error: 'Auth' }) : res.redirect('/login.html');
};

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    req.session.isLoggedIn = true;
    res.json({ success: true });
  } else res.status(401).json({ error: 'Error' });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

// --- API ЗАМОВЛЕНЬ ---
app.get('/api/orders', checkAuth, async (req, res) => {
  const { view, search } = req.query;
  try {
    let query = `
      SELECT o.id, c.full_name as "fullName", c.phone, o.article, o.size, o.color, 
             o.status, o.ttn, o.price, o.cost, o.comment, o.source, o.created_at as "createdAt"
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
    `;
    const params = [];
    const conditions = [];

    if (view === 'archive') conditions.push("o.status IN ('Завершено', 'Відмова')");
    else if (view === 'deleted') conditions.push("o.status = 'Видалено'");
    else conditions.push("o.status NOT IN ('Завершено', 'Відмова', 'Видалено')");

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(c.full_name ILIKE $1 OR c.phone ILIKE $1 OR o.article ILIKE $1)`);
    }

    if (conditions.length > 0) query += " WHERE " + conditions.join(" AND ");
    query += ` ORDER BY o.created_at DESC`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/orders/manual', checkAuth, async (req, res) => {
    const { fullName, phone, article, size, color, price, cost, source } = req.body;
    try {
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
        res.json({ success: true, id: order.rows[0].id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/orders/:id', checkAuth, async (req, res) => {
  const fields = req.body;
  const setClause = Object.keys(fields).map((key, i) => `${key} = $${i + 1}`).join(', ');
  const values = Object.values(fields);
  values.push(req.params.id);
  try {
    await pool.query(`UPDATE orders SET ${setClause} WHERE id = $${values.length}`, values);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- API СКЛАДУ (ПОСТАЧАЛЬНИКИ) ---
app.get('/api/warehouse/suppliers', checkAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM suppliers ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/warehouse/suppliers', checkAuth, async (req, res) => {
    try {
        await pool.query('INSERT INTO suppliers (name) VALUES ($1) ON CONFLICT DO NOTHING', [req.body.name]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/warehouse/suppliers/:id', checkAuth, async (req, res) => {
    try {
        await pool.query('DELETE FROM suppliers WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- API СКЛАДУ (ТОВАРИ) ---
app.get('/api/warehouse/products', checkAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT p.*, s.name as supplier_name 
            FROM products p 
            LEFT JOIN suppliers s ON p.supplier_id = s.id 
            ORDER BY p.id DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/warehouse/products', checkAuth, async (req, res) => {
    const { article, name, cost, price, supplier_id, links } = req.body;
    try {
        await pool.query(
            'INSERT INTO products (article, name, cost, price, supplier_id, links) VALUES ($1, $2, $3, $4, $5, $6)',
            [article, name, cost, price, supplier_id || null, links]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/warehouse/products/:id', checkAuth, async (req, res) => {
    try {
        await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats', checkAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                COUNT(*) as total,
                COALESCE(SUM(price), 0) as revenue,
                COALESCE(SUM(price - cost), 0) as profit,
                COUNT(*) FILTER (WHERE status = 'Новий') as new_count
            FROM orders WHERE status != 'Видалено'
        `);
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`tomireal CRM running on ${PORT}`));
