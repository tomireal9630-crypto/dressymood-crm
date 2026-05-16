require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const session = require('express-session');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

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

// Отримання замовлень
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

// СТВОРЕННЯ ЗАМОВЛЕННЯ (Повернули!)
app.post('/api/orders/manual', checkAuth, async (req, res) => {
    const { fullName, phone, article, size, color, price, cost, source } = req.body;
    try {
        const cust = await pool.query(
            'INSERT INTO customers (full_name, phone) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET full_name = $1 RETURNING id',
            [fullName, phone]
        );
        const order = await pool.query(
            'INSERT INTO orders (customer_id, article, size, color, status, price, cost, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
            [cust.rows[0].id, article, size || '', color || '', 'Новий', price || 0, cost || 0, source || 'Вручну']
        );
        res.json({ success: true, id: order.rows[0].id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// РЕДАГУВАННЯ ЗАМОВЛЕННЯ (ТТН, Статуси - Повернули!)
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

// Статистика
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
