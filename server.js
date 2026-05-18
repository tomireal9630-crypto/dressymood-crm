require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const session = require('express-session');
const crypto = require('crypto');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
if (isProduction) app.set('trust proxy', 1);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// --- АВТОМАТИЧНЕ ОНОВЛЕННЯ БАЗИ ДАНИХ (СТАБІЛЬНЕ) ---
async function updateDatabaseSchema() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS customers (
                id SERIAL PRIMARY KEY,
                full_name VARCHAR(255) NOT NULL,
                phone VARCHAR(50) NOT NULL UNIQUE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER REFERENCES customers(id),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

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
            ADD COLUMN IF NOT EXISTS comment TEXT DEFAULT '',
            ADD COLUMN IF NOT EXISTS delivery_service VARCHAR(50) DEFAULT 'НП',
            ADD COLUMN IF NOT EXISTS city VARCHAR(255) DEFAULT '',
            ADD COLUMN IF NOT EXISTS branch TEXT DEFAULT '',
            ADD COLUMN IF NOT EXISTS payment_type VARCHAR(50) DEFAULT 'на счет',
            ADD COLUMN IF NOT EXISTS delivery_payment VARCHAR(50) DEFAULT 'Отримувач';
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS suppliers (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL UNIQUE
            );
        `).catch(async () => {
            return await pool.query(`CREATE TABLE IF NOT EXISTS suppliers (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE);`);
        });

        await pool.query(`
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                article VARCHAR(255) NOT NULL,
                name VARCHAR(255) NOT NULL
            );
        `);

        await pool.query(`
            ALTER TABLE products 
            ADD COLUMN IF NOT EXISTS cost NUMERIC DEFAULT 0,
            ADD COLUMN IF NOT EXISTS price NUMERIC DEFAULT 0,
            ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS links TEXT DEFAULT '';
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS stock (
                id SERIAL PRIMARY KEY,
                product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
                color VARCHAR(100) NOT NULL DEFAULT '',
                size VARCHAR(50) NOT NULL DEFAULT '',
                quantity INTEGER NOT NULL DEFAULT 0
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS order_items (
                id SERIAL PRIMARY KEY,
                order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE
            );
        `);

        await pool.query(`
            ALTER TABLE order_items
            ADD COLUMN IF NOT EXISTS article VARCHAR(255) DEFAULT '',
            ADD COLUMN IF NOT EXISTS name VARCHAR(255) DEFAULT '',
            ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(255) DEFAULT '',
            ADD COLUMN IF NOT EXISTS size VARCHAR(50) DEFAULT '',
            ADD COLUMN IF NOT EXISTS color VARCHAR(50) DEFAULT '',
            ADD COLUMN IF NOT EXISTS price NUMERIC DEFAULT 0,
            ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1;
        `);

        console.log("База даних успішно верифікована.");
    } catch (err) {
        console.error("Помилка автоматичної міграції:", err);
    }
}
updateDatabaseSchema();

app.use(session({
  secret: process.env.SESSION_SECRET || 'tomireal_space_layout',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: isProduction, httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const checkAuth = (req, res, next) => {
  if (req.session.isLoggedIn) next();
  else req.path.startsWith('/api/') ? res.status(401).json({ error: 'Auth' }) : res.redirect('/login.html');
};

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const okUser = safeEqual(username || '', process.env.ADMIN_USERNAME || '');
  const okPass = safeEqual(password || '', process.env.ADMIN_PASSWORD || '');
  if (okUser && okPass) {
    req.session.isLoggedIn = true;
    res.json({ success: true });
  } else res.status(401).json({ error: 'Error' });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

// --- API ЗАМОВЛЕНЬ ---
const ARCHIVE_STATUSES = ['Продажа', 'Отказ'];
const DELETED_STATUS = '✗✗✗';

app.get('/api/orders', checkAuth, async (req, res) => {
  const { view, search, status, dateFrom, dateTo, supplier } = req.query;
  try {
    const params = [];
    const conditions = [];

    if (view === 'archive') {
      params.push(ARCHIVE_STATUSES);
      conditions.push(`o.status = ANY($${params.length})`);
    } else if (view === 'deleted') {
      params.push(DELETED_STATUS);
      conditions.push(`o.status = $${params.length}`);
    } else {
      params.push([...ARCHIVE_STATUSES, DELETED_STATUS]);
      conditions.push(`o.status <> ALL($${params.length})`);
    }

    if (status) {
      params.push(status);
      conditions.push(`o.status = $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      conditions.push(`(c.full_name ILIKE ${p} OR c.phone ILIKE ${p} OR o.ttn ILIKE ${p}
        OR EXISTS (SELECT 1 FROM order_items oi2 WHERE oi2.order_id = o.id
                   AND (oi2.article ILIKE ${p} OR oi2.name ILIKE ${p})))`);
    }

    if (supplier) {
      params.push(supplier);
      conditions.push(`EXISTS (SELECT 1 FROM order_items oi3 WHERE oi3.order_id = o.id AND oi3.supplier_name = $${params.length})`);
    }

    if (dateFrom) {
      params.push(dateFrom);
      conditions.push(`o.created_at >= $${params.length}::date`);
    }
    if (dateTo) {
      params.push(dateTo);
      conditions.push(`o.created_at < ($${params.length}::date + interval '1 day')`);
    }

    const query = `
      SELECT o.id, c.full_name AS "fullName", c.phone,
             o.status, o.ttn, o.comment, o.source,
             o.delivery_service, o.city, o.branch, o.payment_type, o.delivery_payment,
             o.created_at AS "createdAt",
             COALESCE(json_agg(json_build_object(
               'id', oi.id, 'article', oi.article, 'name', oi.name,
               'supplier_name', oi.supplier_name, 'size', oi.size,
               'color', oi.color, 'price', oi.price, 'quantity', oi.quantity
             ) ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items,
             COALESCE(SUM(oi.price * oi.quantity), 0) AS total
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      LEFT JOIN order_items oi ON oi.order_id = o.id
      ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      GROUP BY o.id, c.full_name, c.phone
      ORDER BY o.created_at DESC
    `;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/orders/manual', checkAuth, async (req, res) => {
  const {
    fullName, phone, comment, source, items,
    delivery_service, city, branch, payment_type, delivery_payment, ttn, status
  } = req.body;

  if (!fullName || !phone) return res.status(400).json({ error: 'Вкажіть ПІБ та телефон' });
  const list = Array.isArray(items) ? items.filter(i => i && (i.article || i.name)) : [];
  if (list.length === 0) return res.status(400).json({ error: 'Додайте хоча б один товар' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cust = await client.query('SELECT id FROM customers WHERE phone = $1', [phone]);
    let customerId;
    if (cust.rows.length > 0) {
      customerId = cust.rows[0].id;
      await client.query('UPDATE customers SET full_name = $1 WHERE id = $2', [fullName, customerId]);
    } else {
      const c = await client.query(
        'INSERT INTO customers (full_name, phone) VALUES ($1, $2) RETURNING id', [fullName, phone]);
      customerId = c.rows[0].id;
    }

    const order = await client.query(
      `INSERT INTO orders (customer_id, status, ttn, comment, source,
        delivery_service, city, branch, payment_type, delivery_payment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [customerId, status || 'Новий', ttn || '', comment || '', source || 'Вручну',
       delivery_service || 'НП', city || '', branch || '',
       payment_type || 'на счет', delivery_payment || 'Отримувач']
    );
    const orderId = order.rows[0].id;

    for (const it of list) {
      let supplierName = it.supplier_name || '';
      if (it.supplier_id) {
        const s = await client.query('SELECT name FROM suppliers WHERE id = $1', [it.supplier_id]);
        if (s.rows.length) supplierName = s.rows[0].name;
      }
      await client.query(
        `INSERT INTO order_items (order_id, article, name, supplier_id, supplier_name,
          size, color, price, quantity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [orderId, it.article || '', it.name || '', it.supplier_id || null, supplierName,
         it.size || '', it.color || '', Number(it.price) || 0, parseInt(it.quantity) || 1]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, id: orderId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

const ALLOWED_ORDER_FIELDS = ['status', 'ttn', 'comment', 'source',
  'delivery_service', 'city', 'branch', 'payment_type', 'delivery_payment'];

app.patch('/api/orders/:id', checkAuth, async (req, res) => {
  const keys = Object.keys(req.body).filter(k => ALLOWED_ORDER_FIELDS.includes(k));
  if (keys.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  const setClause = keys.map((key, i) => `${key} = $${i + 1}`).join(', ');
  const values = keys.map(k => req.body[k]);
  values.push(req.params.id);
  try {
    await pool.query(`UPDATE orders SET ${setClause} WHERE id = $${values.length}`, values);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Постачальники, що реально зустрічаються в замовленнях (для фільтра)
app.get('/api/orders/suppliers', checkAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT DISTINCT supplier_name FROM order_items
       WHERE supplier_name IS NOT NULL AND supplier_name <> ''
       ORDER BY supplier_name ASC`
    );
    res.json(r.rows.map(x => x.supplier_name));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Нормалізація українського номера -> +380XXXXXXXXX (best-effort)
function normalizeUaPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('380')) d = d.slice(3);
  else if (d.startsWith('80')) d = d.slice(2);
  else if (d.startsWith('0')) d = d.slice(1);
  d = d.slice(0, 9);
  return d.length === 9 ? '+380' + d : String(raw || '').trim();
}

// --- ПРИЙОМ ЗАМОВЛЕНЬ З ЛЕНДІНГІВ (публічний, захищений ключем) ---
app.post('/api/landing/order', async (req, res) => {
  const expected = process.env.LANDING_API_KEY;
  if (!expected) return res.status(503).json({ error: 'LANDING_API_KEY not configured' });
  if (!safeEqual(req.body.key || '', expected)) {
    return res.status(401).json({ error: 'Invalid key' });
  }

  const name = String(req.body.name || '').trim();
  const phoneRaw = String(req.body.phone || '').trim();
  if (!name || !phoneRaw) return res.status(400).json({ error: 'name and phone required' });

  const phone = normalizeUaPhone(phoneRaw);
  const article = String(req.body.article || '').trim();
  const product = String(req.body.product || '').trim();
  const price = Number(String(req.body.price || '0').replace(',', '.')) || 0;
  const supplier = String(req.body.supplier || '').trim();
  const size = String(req.body.size || '').trim();
  const color = String(req.body.color || '').trim();
  const source = String(req.body.source || req.get('referer') || 'Лендінг').trim().slice(0, 255);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cust = await client.query('SELECT id FROM customers WHERE phone = $1', [phone]);
    let customerId;
    if (cust.rows.length > 0) {
      customerId = cust.rows[0].id;
      await client.query('UPDATE customers SET full_name = $1 WHERE id = $2', [name, customerId]);
    } else {
      const c = await client.query(
        'INSERT INTO customers (full_name, phone) VALUES ($1, $2) RETURNING id', [name, phone]);
      customerId = c.rows[0].id;
    }

    const order = await client.query(
      `INSERT INTO orders (customer_id, status, source) VALUES ($1, $2, $3) RETURNING id`,
      [customerId, 'Новый', source]
    );
    const orderId = order.rows[0].id;

    await client.query(
      `INSERT INTO order_items (order_id, article, name, supplier_name, size, color, price, quantity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
      [orderId, article, product, supplier, size, color, price]
    );

    await client.query('COMMIT');
    res.json({ success: true, id: orderId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- API СКЛАДУ ---
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

// --- API НАЯВНОСТІ ---
app.get('/api/stock', checkAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT s.*, p.article, p.name as product_name
            FROM stock s
            JOIN products p ON s.product_id = p.id
            ORDER BY p.article ASC, s.size ASC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/stock', checkAuth, async (req, res) => {
    const { product_id, color, size, quantity } = req.body;
    try {
        const existing = await pool.query(
            'SELECT id, quantity FROM stock WHERE product_id = $1 AND color ILIKE $2 AND size ILIKE $3', 
            [product_id, (color || '').trim(), (size || '').trim()]
        );

        if (existing.rows.length > 0) {
            const newQty = parseInt(existing.rows[0].quantity) + parseInt(quantity);
            await pool.query('UPDATE stock SET quantity = $1 WHERE id = $2', [newQty, existing.rows[0].id]);
        } else {
            await pool.query(
                'INSERT INTO stock (product_id, color, size, quantity) VALUES ($1, $2, $3, $4)',
                [product_id, (color || '').trim(), (size || '').trim(), quantity]
            );
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/stock/:id', checkAuth, async (req, res) => {
    const { quantity } = req.body;
    try {
        await pool.query('UPDATE stock SET quantity = $1 WHERE id = $2', [quantity, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/stock/:id', checkAuth, async (req, res) => {
    try {
        await pool.query('DELETE FROM stock WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`tomireal CRM running on ${PORT}`));
