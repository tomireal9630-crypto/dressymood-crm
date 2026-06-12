require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
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
            ADD COLUMN IF NOT EXISTS delivery_payment VARCHAR(50) DEFAULT 'Отримувач',
            ADD COLUMN IF NOT EXISTS full_name VARCHAR(255) DEFAULT '',
            ADD COLUMN IF NOT EXISTS city_ref VARCHAR(64) DEFAULT '',
            ADD COLUMN IF NOT EXISTS warehouse_ref VARCHAR(64) DEFAULT '',
            ADD COLUMN IF NOT EXISTS warehouse_type VARCHAR(64) DEFAULT '',
            ADD COLUMN IF NOT EXISTS np_doc_ref VARCHAR(64) DEFAULT '',
            ADD COLUMN IF NOT EXISTS np_status_code VARCHAR(16) DEFAULT '',
            ADD COLUMN IF NOT EXISTS np_status_text VARCHAR(255) DEFAULT '',
            ADD COLUMN IF NOT EXISTS np_delivery_date VARCHAR(64) DEFAULT '',
            ADD COLUMN IF NOT EXISTS np_delivery_cost NUMERIC DEFAULT 0,
            ADD COLUMN IF NOT EXISTS np_arrival_date VARCHAR(64) DEFAULT '',
            ADD COLUMN IF NOT EXISTS np_updated_at TIMESTAMP WITH TIME ZONE,
            ADD COLUMN IF NOT EXISTS sms1_sent_at TIMESTAMP WITH TIME ZONE,
            ADD COLUMN IF NOT EXISTS sms2_sent_at TIMESTAMP WITH TIME ZONE,
            ADD COLUMN IF NOT EXISTS sms3_sent_at TIMESTAMP WITH TIME ZONE,
            ADD COLUMN IF NOT EXISTS sms1_error TEXT DEFAULT '',
            ADD COLUMN IF NOT EXISTS sms2_error TEXT DEFAULT '',
            ADD COLUMN IF NOT EXISTS sms3_error TEXT DEFAULT '',
            ADD COLUMN IF NOT EXISTS checkbox_receipt_id VARCHAR(64) DEFAULT '',
            ADD COLUMN IF NOT EXISTS checkbox_receipt_url VARCHAR(255) DEFAULT '',
            ADD COLUMN IF NOT EXISTS checkbox_receipt_at TIMESTAMP WITH TIME ZONE,
            ADD COLUMN IF NOT EXISTS checkbox_receipt_error TEXT DEFAULT '',
            ADD COLUMN IF NOT EXISTS original_created_at TIMESTAMP WITH TIME ZONE;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS checkbox_log (
                id SERIAL PRIMARY KEY,
                order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
                receipt_id VARCHAR(64) DEFAULT '',
                status VARCHAR(16) DEFAULT 'ok',
                error TEXT DEFAULT '',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sms_log (
                id SERIAL PRIMARY KEY,
                order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
                kind SMALLINT NOT NULL,
                phone VARCHAR(32) DEFAULT '',
                text TEXT DEFAULT '',
                status VARCHAR(16) DEFAULT 'ok',
                error TEXT DEFAULT '',
                sent_at TIMESTAMP WITH TIME ZONE DEFAULT now()
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS app_settings (
                key VARCHAR(64) PRIMARY KEY,
                value JSONB NOT NULL DEFAULT '{}'::jsonb
            );
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
            ADD COLUMN IF NOT EXISTS links TEXT DEFAULT '',
            ADD COLUMN IF NOT EXISTS target_roi_pct INTEGER;
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
            ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1,
            ADD COLUMN IF NOT EXISTS from_stock BOOLEAN DEFAULT false,
            ADD COLUMN IF NOT EXISTS stock_id INTEGER;
        `);

        // Уніфікація legacy 'Новий' (укр і) → 'Новый' (рос ы) — щоб збігалось з фільтрами
        await pool.query(`UPDATE orders SET status = 'Новый' WHERE status = 'Новий'`);
        await pool.query(`ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'Новый'`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS fb_ad_accounts (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                fb_account_id VARCHAR(64) NOT NULL UNIQUE,
                access_token TEXT NOT NULL,
                is_active BOOLEAN DEFAULT true,
                last_sync_at TIMESTAMP WITH TIME ZONE,
                last_sync_error TEXT DEFAULT '',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS fb_spend_daily (
                id SERIAL PRIMARY KEY,
                ad_account_id INTEGER REFERENCES fb_ad_accounts(id) ON DELETE CASCADE,
                date DATE NOT NULL,
                campaign_id VARCHAR(64) NOT NULL,
                campaign_name TEXT NOT NULL DEFAULT '',
                article VARCHAR(255),
                spend NUMERIC DEFAULT 0,
                impressions BIGINT DEFAULT 0,
                clicks BIGINT DEFAULT 0,
                leads INTEGER DEFAULT 0,
                last_synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                UNIQUE(ad_account_id, date, campaign_id)
            );
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_fb_spend_date ON fb_spend_daily(date);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_fb_spend_article ON fb_spend_daily(article);`);

        console.log("База даних успішно верифікована.");
    } catch (err) {
        console.error("Помилка автоматичної міграції:", err);
    }
}
updateDatabaseSchema();

app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'tomireal_space_layout',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { secure: isProduction, httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const checkAuth = (req, res, next) => {
  if (req.session.isLoggedIn) next();
  else req.path.startsWith('/api/') ? res.status(401).json({ error: 'Auth' }) : res.redirect('/login.html');
};

// Простий in-memory rate-limit (sliding window per IP)
function rateLimit({ windowMs, max, message }) {
  const hits = new Map(); // ip -> [timestamp, ...]
  return (req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || 'unknown';
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) {
      return res.status(429).json({ error: message || 'Too many requests' });
    }
    arr.push(now);
    hits.set(ip, arr);
    // легке прибирання застарілих записів — кожен 100-й запит
    if (hits.size > 100 && Math.random() < 0.01) {
      for (const [k, v] of hits) {
        const fresh = v.filter(t => now - t < windowMs);
        if (fresh.length === 0) hits.delete(k); else hits.set(k, fresh);
      }
    }
    next();
  };
}

const loginLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 5, message: 'Забагато спроб входу. Спробуйте за 5 хв.' });
const landingLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: 'Too many requests' });

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

app.post('/api/login', loginLimiter, (req, res) => {
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
const ARCHIVE_STATUSES = ['Продажа', 'Отказ', 'Отбой'];
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
    } else if (view === 'export') {
      params.push(DELETED_STATUS);
      conditions.push(`o.status <> $${params.length}`);
    } else if (view === 'callbacks') {
      conditions.push(`o.status IN ('Не дозвон','Не дозвон2')`);
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

    if (req.query.article) {
      params.push(req.query.article);
      conditions.push(`EXISTS (SELECT 1 FROM order_items oi4 WHERE oi4.order_id = o.id AND oi4.article = $${params.length})`);
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
      SELECT o.id, COALESCE(NULLIF(o.full_name, ''), c.full_name) AS "fullName", c.phone,
             o.status, o.ttn, o.comment, o.source,
             o.delivery_service, o.city, o.branch, o.payment_type, o.delivery_payment,
             o.np_status_code, o.np_status_text, o.np_doc_ref,
             o.checkbox_receipt_id, o.checkbox_receipt_url, o.checkbox_receipt_error,
             o.sms1_sent_at, o.sms2_sent_at, o.sms3_sent_at,
             o.sms1_error, o.sms2_error, o.sms3_error,
             o.created_at AS "createdAt", o.original_created_at AS "originalCreatedAt",
             cs.cust_count, cs.cust_bought, cs.cust_refused,
             COALESCE(json_agg(json_build_object(
               'id', oi.id, 'article', oi.article, 'name', oi.name,
               'supplier_name', oi.supplier_name, 'size', oi.size,
               'color', oi.color, 'price', oi.price, 'quantity', oi.quantity,
               'from_stock', oi.from_stock, 'stock_id', oi.stock_id
             ) ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items,
             COALESCE(SUM(oi.price * oi.quantity), 0) AS total
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      LEFT JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN (
        SELECT customer_id,
               COUNT(*) FILTER (WHERE status IN ('Продажа','Отказ')) AS cust_count,
               COUNT(*) FILTER (WHERE status = 'Продажа') AS cust_bought,
               COUNT(*) FILTER (WHERE status = 'Отказ') AS cust_refused
        FROM orders GROUP BY customer_id
      ) cs ON cs.customer_id = o.customer_id
      ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      GROUP BY o.id, c.full_name, c.phone, cs.cust_count, cs.cust_bought, cs.cust_refused
      ORDER BY o.created_at DESC
    `;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Постійні клієнти (2+ замовлення) зі статистикою
app.get('/api/customers/repeat', checkAuth, async (req, res) => {
  try {
    // Повторні рахуються лише за завершеними угодами (архів): Продажа + Отказ
    const r = await pool.query(`
      SELECT c.id, c.full_name AS "fullName", c.phone,
             COUNT(*) FILTER (WHERE o.status IN ('Продажа','Отказ')) AS total,
             COUNT(*) FILTER (WHERE o.status = 'Продажа') AS bought,
             COUNT(*) FILTER (WHERE o.status = 'Отказ') AS refused,
             COALESCE(SUM(CASE WHEN o.status = 'Продажа'
               THEN (SELECT COALESCE(SUM(oi.price*oi.quantity),0) FROM order_items oi WHERE oi.order_id = o.id)
               ELSE 0 END), 0) AS spent,
             MAX(o.created_at) FILTER (WHERE o.status IN ('Продажа','Отказ')) AS "lastOrderAt"
      FROM customers c
      JOIN orders o ON o.customer_id = c.id
      GROUP BY c.id, c.full_name, c.phone
      HAVING COUNT(*) FILTER (WHERE o.status IN ('Продажа','Отказ')) >= 2
      ORDER BY COUNT(*) FILTER (WHERE o.status IN ('Продажа','Отказ')) DESC, MAX(o.created_at) DESC
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Статуси, які авто-переводяться в «В работе» при повних даних для ТТН
const PROMOTABLE_TO_WORK = ['Новый', 'Не дозвон', 'Не дозвон2'];

// Чи заповнені всі дані для генерації ТТН (ПІБ, тел, місто, відділення, товари)
function readyForWork({ fullName, phone, city_ref, warehouse_ref, itemsCount }) {
  return !!(String(fullName || '').trim() && String(phone || '').trim() &&
            String(city_ref || '').trim() && String(warehouse_ref || '').trim() &&
            (itemsCount || 0) > 0);
}

app.post('/api/orders/manual', checkAuth, async (req, res) => {
  const {
    fullName, phone, comment, source, items,
    delivery_service, city, branch, payment_type, delivery_payment, ttn, status,
    city_ref, warehouse_ref, warehouse_type
  } = req.body;

  if (!fullName || !phone) return res.status(400).json({ error: 'Вкажіть ПІБ та телефон' });
  const list = Array.isArray(items) ? items.filter(i => i && (i.article || i.name)) : [];
  if (list.length === 0) return res.status(400).json({ error: 'Додайте хоча б один товар' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Прив'язка лише за телефоном; ім'я існуючого клієнта НЕ перетираємо
    const cust = await client.query('SELECT id FROM customers WHERE phone = $1', [phone]);
    let customerId;
    if (cust.rows.length > 0) {
      customerId = cust.rows[0].id;
    } else {
      const c = await client.query(
        'INSERT INTO customers (full_name, phone) VALUES ($1, $2) RETURNING id', [fullName, phone]);
      customerId = c.rows[0].id;
    }

    const order = await client.query(
      `INSERT INTO orders (customer_id, full_name, status, ttn, comment, source,
        delivery_service, city, branch, payment_type, delivery_payment,
        city_ref, warehouse_ref, warehouse_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [customerId, fullName, status || 'Новый', ttn || '', comment || '', source || 'Вручну',
       delivery_service || 'НП', city || '', branch || '',
       payment_type || 'на счет', delivery_payment || 'Отримувач',
       city_ref || '', warehouse_ref || '', warehouse_type || '']
    );
    const orderId = order.rows[0].id;

    for (const it of list) {
      let supplierName = it.supplier_name || '';
      if (it.supplier_id) {
        const s = await client.query('SELECT name FROM suppliers WHERE id = $1', [it.supplier_id]);
        if (s.rows.length) supplierName = s.rows[0].name;
      }
      const qty = parseInt(it.quantity) || 1;
      const fromStock = Boolean(it.from_stock && it.stock_id);
      if (fromStock) {
        const upd = await client.query(
          `UPDATE stock SET quantity = quantity - $1 WHERE id = $2 AND quantity >= $1`,
          [qty, it.stock_id]
        );
        if (upd.rowCount === 0) throw new Error(`Недостатньо на складі для "${it.article}" ${it.size} ${it.color}`);
      }
      await client.query(
        `INSERT INTO order_items (order_id, article, name, supplier_id, supplier_name,
          size, color, price, quantity, from_stock, stock_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [orderId, it.article || '', it.name || '', it.supplier_id || null, supplierName,
         it.size || '', it.color || '', Number(it.price) || 0, qty,
         fromStock, fromStock ? it.stock_id : null]
      );
    }

    // Авто: Новый/Не дозвон -> В работе, якщо заповнені всі дані для ТТН
    if (PROMOTABLE_TO_WORK.includes(status || 'Новый') &&
        readyForWork({ fullName, phone, city_ref, warehouse_ref, itemsCount: list.length })) {
      await client.query(`UPDATE orders SET status = 'В работе' WHERE id = $1`, [orderId]);
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
  try {
    let extraSet = '';
    if (req.body.status === 'В работе') {
      const cur = await pool.query(
        `SELECT status, original_created_at FROM orders WHERE id = $1`,
        [req.params.id]
      );
      if (cur.rows.length && ['Не дозвон', 'Не дозвон2'].includes(cur.rows[0].status)) {
        const hasOrig = cur.rows[0].original_created_at != null;
        extraSet = `, created_at = NOW()` + (hasOrig ? '' : `, original_created_at = created_at`);
      }
    }
    const setClause = keys.map((key, i) => `${key} = $${i + 1}`).join(', ');
    const values = keys.map(k => req.body[k]);
    values.push(req.params.id);
    await pool.query(`UPDATE orders SET ${setClause}${extraSet} WHERE id = $${values.length}`, values);
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

app.get('/api/stats/dashboard', checkAuth, async (req, res) => {
  const { dateFrom, dateTo, status } = req.query;
  try {
    const dateExpr = `COALESCE(o.original_created_at, o.created_at)`;
    const dateParams = [];
    const dateConds = [];
    if (dateFrom) { dateParams.push(dateFrom); dateConds.push(`${dateExpr} >= $${dateParams.length}::date`); }
    if (dateTo)   { dateParams.push(dateTo);   dateConds.push(`${dateExpr} < ($${dateParams.length}::date + interval '1 day')`); }
    const dateWhere = dateConds.length ? 'WHERE ' + dateConds.join(' AND ') : '';

    // "Прийняті" — узгоджено з Апрувом: всі статуси, де менеджер додзвонився і клієнт підтвердив
    const kpiQ = `
      SELECT
        COUNT(*) FILTER (WHERE o.status = 'Новый')::int AS new_cnt,
        COUNT(*) FILTER (WHERE o.status = 'В работе')::int AS working,
        COUNT(*) FILTER (WHERE o.status IN ('В работе','Доставка','В пути','На почте','Продажа','Отказ','Возврат','Ошибка в ТТН','Переадресация'))::int AS accepted,
        COUNT(*) FILTER (WHERE o.status = 'Продажа')::int AS sales,
        COUNT(*) FILTER (WHERE o.status = 'Отказ')::int AS refused,
        COUNT(*) FILTER (WHERE o.status IN ('Не дозвон','Не дозвон2'))::int AS callbacks
      FROM orders o ${dateWhere}`;

    const byDayParams = [...dateParams];
    const byDayConds = [...dateConds];
    if (status) {
      byDayParams.push(status);
      byDayConds.push(`o.status = $${byDayParams.length}`);
    }
    const byDayWhere = byDayConds.length ? 'WHERE ' + byDayConds.join(' AND ') : '';
    const byDayQ = `
      SELECT to_char(date_trunc('day', ${dateExpr}), 'YYYY-MM-DD') AS date,
             COUNT(*)::int AS count,
             COALESCE(SUM((SELECT COALESCE(SUM(oi.price * oi.quantity),0) FROM order_items oi WHERE oi.order_id = o.id)), 0)::numeric AS sum
      FROM orders o ${byDayWhere}
      GROUP BY date_trunc('day', ${dateExpr})
      ORDER BY date_trunc('day', ${dateExpr}) DESC`;

    const [k, d] = await Promise.all([pool.query(kpiQ, dateParams), pool.query(byDayQ, byDayParams)]);
    const kpi = k.rows[0] || {};
    res.json({
      kpi: {
        new: kpi.new_cnt || 0,
        working: kpi.working || 0,
        accepted: kpi.accepted || 0,
        sales: kpi.sales || 0,
        refused: kpi.refused || 0,
        callbacks: kpi.callbacks || 0
      },
      byDay: d.rows.map(r => ({ date: r.date, count: r.count, sum: Number(r.sum) || 0 }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats/roi', checkAuth, async (req, res) => {
  const { dateFrom, dateTo } = req.query;
  try {
    const settings = await getEconomicsSettings();
    const returnCost = Number(settings.return_cost) || 0;
    // Дата ліда (а не дата зміни статусу) — щоб збігалось з Apriv, Дашбордом, юніт-економікою
    const dateExpr = `COALESCE(o.original_created_at, o.created_at)`;

    // Виручка/COGS — тільки Продажа, по даті ліда
    const soldParams = [];
    const soldConds = [`o.status = 'Продажа'`];
    if (dateFrom) { soldParams.push(dateFrom); soldConds.push(`${dateExpr} >= $${soldParams.length}::date`); }
    if (dateTo)   { soldParams.push(dateTo);   soldConds.push(`${dateExpr} < ($${soldParams.length}::date + interval '1 day')`); }
    const soldWhere = 'WHERE ' + soldConds.join(' AND ');

    const totalsQ = `
      SELECT
        COUNT(DISTINCT o.id)::int AS orders,
        COALESCE(SUM(oi.quantity), 0)::int AS units,
        COALESCE(SUM(oi.price * oi.quantity), 0)::numeric AS revenue,
        COALESCE(SUM(COALESCE((SELECT MAX(cost) FROM products p WHERE p.article = oi.article), 0) * oi.quantity), 0)::numeric AS cost
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      ${soldWhere}`;

    const byArtQ = `
      SELECT
        oi.article,
        COUNT(DISTINCT o.id)::int AS orders,
        COALESCE(SUM(oi.quantity), 0)::int AS units,
        COALESCE(SUM(oi.price * oi.quantity), 0)::numeric AS revenue,
        COALESCE(SUM(COALESCE((SELECT MAX(cost) FROM products p WHERE p.article = oi.article), 0) * oi.quantity), 0)::numeric AS cost
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      ${soldWhere}
      AND oi.article IS NOT NULL AND oi.article <> ''
      GROUP BY oi.article`;

    // Повернення (для returns cost) — Отказ/Возврат/Ошибка в ТТН в період, по даті ліда
    const refusedParams = [];
    const refusedConds = [`o.status IN ('Отказ','Возврат','Ошибка в ТТН')`];
    if (dateFrom) { refusedParams.push(dateFrom); refusedConds.push(`${dateExpr} >= $${refusedParams.length}::date`); }
    if (dateTo)   { refusedParams.push(dateTo);   refusedConds.push(`${dateExpr} < ($${refusedParams.length}::date + interval '1 day')`); }
    const refusedWhere = 'WHERE ' + refusedConds.join(' AND ');
    const refusedByArtQ = `
      SELECT oi.article, COUNT(DISTINCT o.id)::int AS refused
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      ${refusedWhere}
      AND oi.article IS NOT NULL AND oi.article <> ''
      GROUP BY oi.article`;
    const refusedTotalQ = `
      SELECT COUNT(DISTINCT o.id)::int AS refused
      FROM orders o ${refusedWhere}`;

    // AdSpend з fb_spend_daily (по даті активності реклами — це і є дата ліда)
    const spendParams = [];
    const spendConds = [];
    if (dateFrom) { spendParams.push(dateFrom); spendConds.push(`date >= $${spendParams.length}::date`); }
    if (dateTo)   { spendParams.push(dateTo);   spendConds.push(`date <= $${spendParams.length}::date`); }
    const spendWhere = spendConds.length ? 'WHERE ' + spendConds.join(' AND ') : '';
    const spendTotalQ = `
      SELECT
        COALESCE(SUM(spend), 0)::numeric AS spend,
        COALESCE(SUM(leads), 0)::int AS leads
      FROM fb_spend_daily ${spendWhere}`;
    const spendByArtQ = `
      SELECT article, SUM(spend)::numeric AS spend, SUM(leads)::int AS leads
      FROM fb_spend_daily ${spendWhere}
      ${spendConds.length ? 'AND' : 'WHERE'} article IS NOT NULL AND article <> ''
      GROUP BY article`;
    const spendUnmappedQ = `
      SELECT COALESCE(SUM(spend), 0)::numeric AS spend, COALESCE(SUM(leads), 0)::int AS leads
      FROM fb_spend_daily ${spendWhere}
      ${spendConds.length ? 'AND' : 'WHERE'} (article IS NULL OR article = '')`;

    const [t, a, refT, refA, spT, spA, spU] = await Promise.all([
      pool.query(totalsQ, soldParams),
      pool.query(byArtQ, soldParams),
      pool.query(refusedTotalQ, refusedParams),
      pool.query(refusedByArtQ, refusedParams),
      pool.query(spendTotalQ, spendParams),
      pool.query(spendByArtQ, spendParams),
      pool.query(spendUnmappedQ, spendParams)
    ]);

    const tr = t.rows[0] || {};
    const revenue = Number(tr.revenue) || 0;
    const cost = Number(tr.cost) || 0;
    const grossProfit = revenue - cost;
    const adSpend = Number(spT.rows[0].spend) || 0;
    const leadsTotal = Number(spT.rows[0].leads) || 0;
    const refusedTotal = Number(refT.rows[0].refused) || 0;
    const returnsCost = refusedTotal * returnCost;
    const netProfit = grossProfit - adSpend - returnsCost;
    const roas = adSpend ? revenue / adSpend : 0;
    const roi = adSpend ? netProfit / adSpend * 100 : 0;
    const cpl = leadsTotal ? adSpend / leadsTotal : 0;
    const cpo = (tr.orders || 0) ? adSpend / tr.orders : 0;
    const margin = revenue ? Math.round(grossProfit / revenue * 100) : 0;

    const refusedMap = {};
    refA.rows.forEach(r => { refusedMap[r.article] = Number(r.refused) || 0; });
    const spendMap = {};
    spA.rows.forEach(r => { spendMap[r.article] = { spend: Number(r.spend) || 0, leads: Number(r.leads) || 0 }; });

    const articleSet = new Set();
    a.rows.forEach(r => articleSet.add(r.article));
    Object.keys(spendMap).forEach(art => articleSet.add(art));
    Object.keys(refusedMap).forEach(art => articleSet.add(art));

    const salesByArt = {};
    a.rows.forEach(r => { salesByArt[r.article] = r; });

    const byArticle = [...articleSet].map(article => {
      const r = salesByArt[article] || { orders: 0, units: 0, revenue: 0, cost: 0 };
      const rev = Number(r.revenue) || 0;
      const c = Number(r.cost) || 0;
      const gross = rev - c;
      const refused = refusedMap[article] || 0;
      const ret = refused * returnCost;
      const sp = (spendMap[article] && spendMap[article].spend) || 0;
      const ld = (spendMap[article] && spendMap[article].leads) || 0;
      const net = gross - sp - ret;
      return {
        article,
        orders: Number(r.orders) || 0,
        units: Number(r.units) || 0,
        revenue: rev,
        cost: c,
        gross_profit: gross,
        ad_spend: sp,
        leads: ld,
        refused,
        returns_cost: ret,
        net_profit: net,
        roas: sp ? rev / sp : 0,
        roi: sp ? net / sp * 100 : 0,
        cpl: ld ? sp / ld : 0,
        cpo: r.orders ? sp / r.orders : 0,
        margin: rev ? Math.round(gross / rev * 100) : 0
      };
    });

    res.json({
      totals: {
        orders: tr.orders || 0,
        units: tr.units || 0,
        revenue,
        cost,
        gross_profit: grossProfit,
        ad_spend: adSpend,
        leads: leadsTotal,
        refused: refusedTotal,
        returns_cost: returnsCost,
        net_profit: netProfit,
        roas,
        roi,
        cpl,
        cpo,
        margin
      },
      unmapped_ad_spend: Number(spU.rows[0].spend) || 0,
      unmapped_leads: Number(spU.rows[0].leads) || 0,
      byArticle
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats/approval', checkAuth, async (req, res) => {
  const { dateFrom, dateTo } = req.query;
  try {
    const params = [];
    const conds = [`o.status <> '✗✗✗'`];
    const dateExpr = `COALESCE(o.original_created_at, o.created_at)`;
    if (dateFrom) { params.push(dateFrom); conds.push(`${dateExpr} >= $${params.length}::date`); }
    if (dateTo)   { params.push(dateTo);   conds.push(`${dateExpr} < ($${params.length}::date + interval '1 day')`); }
    const where = 'WHERE ' + conds.join(' AND ');

    const APPROVED = `('В работе','Доставка','В пути','На почте','Продажа','Отказ','Возврат','Ошибка в ТТН','Переадресация')`;
    const PENDING  = `('Новый','Новий','Не дозвон','Не дозвон2')`;
    const REFUSED  = `('Отбой')`;

    const kpiQ = `
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE o.status IN ${APPROVED})::int AS approved,
             COUNT(*) FILTER (WHERE o.status IN ${PENDING})::int AS pending,
             COUNT(*) FILTER (WHERE o.status IN ${REFUSED})::int AS refused
      FROM orders o ${where}`;

    const byDayQ = `
      SELECT to_char(date_trunc('day', ${dateExpr}), 'YYYY-MM-DD') AS date,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE o.status IN ${APPROVED})::int AS approved
      FROM orders o ${where}
      GROUP BY date_trunc('day', ${dateExpr})
      ORDER BY date_trunc('day', ${dateExpr}) DESC`;

    const byArtQ = `
      WITH leads AS (SELECT o.id, o.status FROM orders o ${where})
      SELECT oi.article,
             COUNT(DISTINCT l.id)::int AS total,
             COUNT(DISTINCT l.id) FILTER (WHERE l.status IN ${APPROVED})::int AS approved
      FROM leads l
      JOIN order_items oi ON oi.order_id = l.id
      WHERE oi.article IS NOT NULL AND oi.article <> ''
      GROUP BY oi.article
      ORDER BY oi.article`;

    const [k, d, a] = await Promise.all([
      pool.query(kpiQ, params),
      pool.query(byDayQ, params),
      pool.query(byArtQ, params)
    ]);
    const kpi = k.rows[0] || { total: 0, approved: 0, pending: 0, refused: 0 };
    const approvalPct = kpi.total ? Math.round(kpi.approved / kpi.total * 100) : 0;
    const enrich = r => ({ ...r, approvalPct: r.total ? Math.round(r.approved / r.total * 100) : 0 });
    res.json({
      kpi: { ...kpi, approvalPct },
      byDay: d.rows.map(enrich),
      byArticle: a.rows.map(enrich)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ГЛОБАЛЬНІ НАЛАШТУВАННЯ ЕКОНОМІКИ ---
const ECONOMICS_DEFAULTS = {
  return_cost: 110,
  lookback_days: 30,
  settlement_days: 14,
  target_roi_pct: 30,
  campaign_regex: '\\[([^\\]]+)\\]'
};

async function getEconomicsSettings() {
  const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'economics'`);
  return { ...ECONOMICS_DEFAULTS, ...(r.rows.length ? r.rows[0].value : {}) };
}

app.get('/api/settings/economics', checkAuth, async (req, res) => {
  try { res.json(await getEconomicsSettings()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings/economics', checkAuth, async (req, res) => {
  const allowed = ['return_cost', 'lookback_days', 'settlement_days', 'target_roi_pct', 'campaign_regex'];
  const current = await getEconomicsSettings();
  const next = { ...current };
  for (const k of allowed) {
    if (req.body[k] !== undefined && req.body[k] !== '') {
      next[k] = k === 'campaign_regex' ? String(req.body[k]) : Number(req.body[k]);
    }
  }
  try {
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('economics', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`, [next]);
    res.json({ success: true, settings: next });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ЕКОНОМІКА ТОВАРУ (CPL_max, CPL_recommended) ---
app.get('/api/products/:id(\\d+)/economics', checkAuth, async (req, res) => {
  try {
    const settings = await getEconomicsSettings();
    const productRes = await pool.query(
      `SELECT id, article, name, cost, price, target_roi_pct FROM products WHERE id = $1`,
      [req.params.id]
    );
    if (!productRes.rows.length) return res.status(404).json({ error: 'Not found' });
    const p = productRes.rows[0];
    const article = p.article;
    const sellPrice = Number(p.price) || 0;
    const productCost = Number(p.cost) || 0;
    const margin = sellPrice - productCost;
    const targetRoi = (p.target_roi_pct != null ? Number(p.target_roi_pct) : Number(settings.target_roi_pct)) / 100;

    // % Апруву та Викупу по артикулу за lookback_days
    const lookback = Number(settings.lookback_days) || 30;
    const APPROVED = `('В работе','Доставка','В пути','На почте','Продажа','Отказ','Возврат','Ошибка в ТТН','Переадресация')`;
    const SOLD = `('Продажа')`;
    const REFUSED_AFTER_APPROVE = `('Отказ','Возврат','Ошибка в ТТН')`;
    const dateExpr = `COALESCE(o.original_created_at, o.created_at)`;

    const statsQ = `
      WITH leads AS (
        SELECT DISTINCT o.id, o.status
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        WHERE oi.article = $1
          AND o.status <> '✗✗✗'
          AND ${dateExpr} >= (CURRENT_DATE - $2::int)
      )
      SELECT
        COUNT(*)::int AS total_leads,
        COUNT(*) FILTER (WHERE status IN ${APPROVED})::int AS approved,
        COUNT(*) FILTER (WHERE status IN ${SOLD})::int AS sold,
        COUNT(*) FILTER (WHERE status IN ${REFUSED_AFTER_APPROVE})::int AS refused_after
      FROM leads`;

    const sr = await pool.query(statsQ, [article, lookback]);
    const s = sr.rows[0] || {};
    const totalLeads = s.total_leads || 0;
    const approved = s.approved || 0;
    const sold = s.sold || 0;
    const refusedAfter = s.refused_after || 0;

    const approvalRate = totalLeads ? approved / totalLeads : 0;
    const returnCost = Number(settings.return_cost) || 0;
    // Final buyout rate — рахується лише серед РЕЗОЛЮЦІЙ (Продажа+Отказ/Возврат/Ошибка),
    // ігнорує "в дорозі" (Доставка/В пути/На почте). Це чесна оцінка майбутнього викупу.
    // Мінімальний поріг 5 — щоб не довіряти статистиці на дуже малих числах.
    const RESOLVED_MIN = 5;
    const resolved = sold + refusedAfter;
    const useFinal = resolved >= RESOLVED_MIN;
    const buyoutRate  = useFinal ? sold / resolved        : (approved ? sold / approved : 0);
    const refusalRate = useFinal ? refusedAfter / resolved : (approved ? refusedAfter / approved : 0);

    // На 100 лідів:
    //   approved = 100 × approvalRate
    //   sold     = approved × buyoutRate          (екстраполяція на ВСІ підтверджені, у т.ч. ті що ще в дорозі)
    //   refused  = approved × refusalRate
    //   ВаловийПрибуток = sold×(price−cost) − refused×return_cost
    const per100 = {
      approved: 100 * approvalRate,
      sold: 100 * approvalRate * buyoutRate,
      refused: 100 * approvalRate * refusalRate
    };
    const revenue = per100.sold * sellPrice;
    const cogs = per100.sold * productCost;
    const returns = per100.refused * returnCost;
    const grossProfit = revenue - cogs - returns;
    const cpl_max = grossProfit / 100;
    const cpl_recommended = cpl_max / (1 + targetRoi);

    res.json({
      product: { id: p.id, article, name: p.name, cost: productCost, price: sellPrice, margin, target_roi_pct: Math.round(targetRoi * 100) },
      history: {
        lookback_days: lookback,
        total_leads: totalLeads,
        approved,
        sold,
        refused_after: refusedAfter,
        in_flight: approved - resolved,
        resolved,
        approval_pct: Math.round(approvalRate * 1000) / 10,
        buyout_pct: Math.round(buyoutRate * 1000) / 10,
        refusal_pct: Math.round(refusalRate * 1000) / 10,
        is_extrapolated: useFinal
      },
      settings: { return_cost: returnCost },
      cpl: {
        max: Math.round(cpl_max * 100) / 100,
        recommended: Math.round(cpl_recommended * 100) / 100,
        gross_profit_per_100_leads: Math.round(grossProfit * 100) / 100
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== FACEBOOK ADS INTEGRATION =====================
const FB_API_VERSION = 'v19.0';

function extractArticleFromCampaign(campaignName, pattern) {
  if (!campaignName) return null;
  try {
    const re = new RegExp(pattern);
    const m = campaignName.match(re);
    if (m && m[1]) return m[1].trim();
  } catch (e) { /* invalid regex */ }
  return null;
}

function getLeadCountFromActions(actions) {
  if (!Array.isArray(actions)) return 0;
  let leads = 0;
  for (const a of actions) {
    const t = String(a.action_type || '');
    if (t === 'lead' || t === 'onsite_conversion.lead_grouped' || t === 'offsite_conversion.fb_pixel_lead') {
      leads += Number(a.value) || 0;
    }
  }
  return Math.round(leads);
}

async function fbGet(url) {
  const resp = await fetch(url);
  const j = await resp.json();
  if (!resp.ok || j.error) {
    throw new Error((j.error && j.error.message) || ('HTTP ' + resp.status));
  }
  return j;
}

async function fbTestAccount(accountId, accessToken) {
  const cleanId = String(accountId).replace(/^act_/, '');
  const url = `https://graph.facebook.com/${FB_API_VERSION}/act_${cleanId}?fields=name,account_status&access_token=${encodeURIComponent(accessToken)}`;
  return await fbGet(url);
}

// Тягне insights з FB за останні N днів і пише в БД (UPSERT)
async function syncFbAccount(account, daysBack) {
  const settings = await getEconomicsSettings();
  const pattern = settings.campaign_regex || '\\[([^\\]]+)\\]';
  const cleanId = String(account.fb_account_id).replace(/^act_/, '');
  const since = new Date(); since.setDate(since.getDate() - (daysBack || 7));
  const until = new Date();
  const iso = d => d.toISOString().slice(0, 10);
  const timeRange = JSON.stringify({ since: iso(since), until: iso(until) });
  const fields = 'spend,impressions,clicks,actions,campaign_id,campaign_name';
  const params = new URLSearchParams({
    fields,
    level: 'campaign',
    time_increment: '1',
    time_range: timeRange,
    limit: '500',
    access_token: account.access_token
  });
  let url = `https://graph.facebook.com/${FB_API_VERSION}/act_${cleanId}/insights?${params.toString()}`;
  let inserted = 0;
  while (url) {
    const j = await fbGet(url);
    const rows = Array.isArray(j.data) ? j.data : [];
    for (const r of rows) {
      const date = r.date_start;
      const campaignId = r.campaign_id;
      const campaignName = r.campaign_name || '';
      const article = extractArticleFromCampaign(campaignName, pattern);
      const spend = Number(r.spend) || 0;
      const impressions = Number(r.impressions) || 0;
      const clicks = Number(r.clicks) || 0;
      const leads = getLeadCountFromActions(r.actions);
      await pool.query(`
        INSERT INTO fb_spend_daily (ad_account_id, date, campaign_id, campaign_name, article, spend, impressions, clicks, leads, last_synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
        ON CONFLICT (ad_account_id, date, campaign_id) DO UPDATE SET
          campaign_name = EXCLUDED.campaign_name,
          article = EXCLUDED.article,
          spend = EXCLUDED.spend,
          impressions = EXCLUDED.impressions,
          clicks = EXCLUDED.clicks,
          leads = EXCLUDED.leads,
          last_synced_at = NOW()
      `, [account.id, date, campaignId, campaignName, article, spend, impressions, clicks, leads]);
      inserted++;
    }
    url = (j.paging && j.paging.next) ? j.paging.next : null;
  }
  return inserted;
}

async function syncAllFbAccounts(daysBack) {
  const r = await pool.query(`SELECT * FROM fb_ad_accounts WHERE is_active = true`);
  for (const acc of r.rows) {
    try {
      const n = await syncFbAccount(acc, daysBack);
      await pool.query(`UPDATE fb_ad_accounts SET last_sync_at = NOW(), last_sync_error = '' WHERE id = $1`, [acc.id]);
      console.log(`[FB sync] ${acc.name}: ${n} rows`);
    } catch (err) {
      console.error(`[FB sync] ${acc.name} error:`, err.message);
      await pool.query(`UPDATE fb_ad_accounts SET last_sync_at = NOW(), last_sync_error = $1 WHERE id = $2`, [String(err.message || err), acc.id]);
    }
  }
}

// CRUD кабінетів
app.get('/api/fb/accounts', checkAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, name, fb_account_id, is_active, last_sync_at, last_sync_error, created_at
      FROM fb_ad_accounts ORDER BY name`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fb/accounts', checkAuth, async (req, res) => {
  const { name, fb_account_id, access_token } = req.body;
  if (!name || !fb_account_id || !access_token) {
    return res.status(400).json({ error: 'Заповніть ім\'я, Account ID і токен' });
  }
  const cleanId = String(fb_account_id).replace(/^act_/, '').trim();
  try {
    await fbTestAccount(cleanId, access_token);
    const r = await pool.query(`
      INSERT INTO fb_ad_accounts (name, fb_account_id, access_token)
      VALUES ($1, $2, $3) RETURNING id`, [name.trim(), cleanId, access_token.trim()]);
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) {
    const msg = /unique/i.test(err.message) ? 'Цей Account ID вже додано' : err.message;
    res.status(400).json({ error: msg });
  }
});

app.patch('/api/fb/accounts/:id(\\d+)', checkAuth, async (req, res) => {
  const allowed = ['name', 'is_active', 'access_token'];
  const keys = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!keys.length) return res.status(400).json({ error: 'Нічого оновити' });
  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = keys.map(k => req.body[k]);
  values.push(req.params.id);
  try {
    await pool.query(`UPDATE fb_ad_accounts SET ${setClause} WHERE id = $${values.length}`, values);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/fb/accounts/:id(\\d+)', checkAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM fb_ad_accounts WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fb/accounts/:id(\\d+)/test', checkAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT fb_account_id, access_token FROM fb_ad_accounts WHERE id = $1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const info = await fbTestAccount(r.rows[0].fb_account_id, r.rows[0].access_token);
    res.json({ success: true, info });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Ручний refresh синхронізації FB
app.post('/api/fb/sync', checkAuth, async (req, res) => {
  const daysBack = Number(req.body && req.body.days) || 7;
  try {
    await syncAllFbAccounts(daysBack);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cron: щогодинна синхронізація. Перший виклик через хв після старту.
setTimeout(() => { syncAllFbAccounts(7).catch(e => console.error('[FB sync init]', e.message)); }, 60 * 1000);
setInterval(() => { syncAllFbAccounts(7).catch(e => console.error('[FB sync cron]', e.message)); }, 60 * 60 * 1000);

// Юніт-економіка по всіх товарах одним запитом
app.get('/api/stats/unit-economics', checkAuth, async (req, res) => {
  try {
    const settings = await getEconomicsSettings();
    const lookback = Number(settings.lookback_days) || 30;
    const returnCost = Number(settings.return_cost) || 0;
    const defaultTargetRoi = Number(settings.target_roi_pct) || 30;

    const APPROVED = `('В работе','Доставка','В пути','На почте','Продажа','Отказ','Возврат','Ошибка в ТТН','Переадресация')`;
    const SOLD = `('Продажа')`;
    const REFUSED_AFTER = `('Отказ','Возврат','Ошибка в ТТН')`;
    const dateExpr = `COALESCE(o.original_created_at, o.created_at)`;

    const sql = `
      WITH leads AS (
        SELECT DISTINCT o.id, o.status, oi.article
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        WHERE o.status <> '✗✗✗'
          AND ${dateExpr} >= (CURRENT_DATE - $1::int)
          AND oi.article IS NOT NULL AND oi.article <> ''
      ),
      stats AS (
        SELECT article,
               COUNT(*)::int AS total_leads,
               COUNT(*) FILTER (WHERE status IN ${APPROVED})::int AS approved,
               COUNT(*) FILTER (WHERE status IN ${SOLD})::int AS sold,
               COUNT(*) FILTER (WHERE status IN ${REFUSED_AFTER})::int AS refused_after
        FROM leads GROUP BY article
      )
      SELECT p.id, p.article, p.name,
             COALESCE(p.cost, 0)::numeric AS cost,
             COALESCE(p.price, 0)::numeric AS price,
             p.target_roi_pct,
             COALESCE(s.total_leads, 0)::int AS total_leads,
             COALESCE(s.approved, 0)::int AS approved,
             COALESCE(s.sold, 0)::int AS sold,
             COALESCE(s.refused_after, 0)::int AS refused_after
      FROM products p
      LEFT JOIN stats s ON s.article = p.article
      ORDER BY p.article`;

    const r = await pool.query(sql, [lookback]);
    const RESOLVED_MIN = 5;
    const rows = r.rows.map(row => {
      const sellPrice = Number(row.price) || 0;
      const productCost = Number(row.cost) || 0;
      const margin = sellPrice - productCost;
      const targetRoi = (row.target_roi_pct != null ? Number(row.target_roi_pct) : defaultTargetRoi) / 100;
      const total = row.total_leads;
      const approvalRate = total ? row.approved / total : 0;
      // Final buyout: рахуємо лише серед резолюцій (Продажа+Отказ/Возврат/Ошибка),
      // ігноруємо "в дорозі". Поріг ≥5 щоб не довіряти статистиці на дуже малих числах.
      const resolved = row.sold + row.refused_after;
      const useFinal = resolved >= RESOLVED_MIN;
      const buyoutRate  = useFinal ? row.sold / resolved        : (row.approved ? row.sold / row.approved : 0);
      const refusalRate = useFinal ? row.refused_after / resolved : (row.approved ? row.refused_after / row.approved : 0);
      const sold100 = 100 * approvalRate * buyoutRate;
      const refused100 = 100 * approvalRate * refusalRate;
      const grossProfit100 = sold100 * sellPrice - sold100 * productCost - refused100 * returnCost;
      const cpl_max = grossProfit100 / 100;
      const cpl_recommended = cpl_max / (1 + targetRoi);

      return {
        id: row.id,
        article: row.article,
        name: row.name,
        cost: productCost,
        price: sellPrice,
        margin,
        target_roi_pct: Math.round(targetRoi * 100),
        total_leads: total,
        approval_pct: Math.round(approvalRate * 1000) / 10,
        buyout_pct: Math.round(buyoutRate * 1000) / 10,
        refusal_pct: Math.round(refusalRate * 1000) / 10,
        is_extrapolated: useFinal,
        in_flight: row.approved - resolved,
        cpl_max: Math.round(cpl_max * 100) / 100,
        cpl_recommended: Math.round(cpl_recommended * 100) / 100,
        has_history: total > 0 && row.approved > 0
      };
    });

    res.json({ rows, settings: { lookback_days: lookback, return_cost: returnCost, default_target_roi_pct: defaultTargetRoi } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats/buyout', checkAuth, async (req, res) => {
  const { dateFrom, dateTo, supplier } = req.query;
  try {
    const params = [];
    const conditions = [`o.status IN ('Продажа','Отказ')`];
    // Дата ліда — для узгодженості з Апрувом, Дашбордом, юніт-економікою, ROI
    const dateExpr = `COALESCE(o.original_created_at, o.created_at)`;
    if (dateFrom) { params.push(dateFrom); conditions.push(`${dateExpr} >= $${params.length}::date`); }
    if (dateTo)   { params.push(dateTo);   conditions.push(`${dateExpr} < ($${params.length}::date + interval '1 day')`); }
    if (supplier) {
      params.push(supplier);
      conditions.push(`EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.supplier_name = $${params.length})`);
    }
    const where = 'WHERE ' + conditions.join(' AND ');

    const totalsQ = `
      SELECT COUNT(*)::int AS completed,
             COUNT(*) FILTER (WHERE o.status = 'Продажа')::int AS sales,
             COUNT(*) FILTER (WHERE o.status = 'Отказ')::int AS refused
      FROM orders o ${where}`;

    const byArtQ = `
      WITH completed AS (
        SELECT o.id, o.status FROM orders o ${where}
      )
      SELECT oi.article AS article,
             COUNT(DISTINCT c.id)::int AS total,
             COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'Продажа')::int AS sales,
             COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'Отказ')::int AS refused
      FROM completed c
      JOIN order_items oi ON oi.order_id = c.id
      WHERE oi.article IS NOT NULL AND oi.article <> ''
      GROUP BY oi.article
      ORDER BY oi.article`;

    const [t, a] = await Promise.all([pool.query(totalsQ, params), pool.query(byArtQ, params)]);
    const totals = t.rows[0] || { completed: 0, sales: 0, refused: 0 };
    const refusedPct = totals.completed ? Math.round(totals.refused / totals.completed * 100) : 0;
    const byArticle = a.rows.map(r => ({
      article: r.article,
      total: r.total,
      sales: r.sales,
      refused: r.refused,
      refusedPct: r.total ? Math.round(r.refused / r.total * 100) : 0
    }));
    res.json({ totals: { ...totals, refusedPct }, byArticle });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/orders/articles', checkAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT DISTINCT article FROM order_items
       WHERE article IS NOT NULL AND article <> ''
       ORDER BY article ASC`
    );
    res.json(r.rows.map(x => x.article));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Один заказ з усіма даними (для редагування)
app.get('/api/orders/:id(\\d+)', checkAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT o.id, COALESCE(NULLIF(o.full_name, ''), c.full_name) AS "fullName", c.phone,
             o.status, o.ttn, o.comment, o.source,
             o.delivery_service, o.city, o.branch, o.payment_type, o.delivery_payment,
             o.city_ref, o.warehouse_ref, o.warehouse_type,
             COALESCE(json_agg(json_build_object(
               'article', oi.article, 'name', oi.name, 'supplier_name', oi.supplier_name,
               'size', oi.size, 'color', oi.color, 'price', oi.price, 'quantity', oi.quantity,
               'from_stock', oi.from_stock, 'stock_id', oi.stock_id
             ) ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.id = $1
      GROUP BY o.id, c.full_name, c.phone
    `, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Повне оновлення заказу (клієнт + доставка + товари)
app.put('/api/orders/:id(\\d+)/full', checkAuth, async (req, res) => {
  const orderId = req.params.id;
  const b = req.body;
  const name = String(b.fullName || '').trim();
  const phone = String(b.phone || '').trim();
  if (!name || !phone) return res.status(400).json({ error: 'Вкажіть ПІБ та телефон' });
  const list = Array.isArray(b.items) ? b.items.filter(i => i && (i.article || i.name)) : [];
  if (list.length === 0) return res.status(400).json({ error: 'Додайте хоча б один товар' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ord = await client.query('SELECT customer_id FROM orders WHERE id = $1', [orderId]);
    if (!ord.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Замовлення не знайдено' }); }
    const origCustomerId = ord.rows[0].customer_id;

    // Прив'язка лише за телефоном; ім'я зберігається в самому замовленні, а не в клієнті
    let customerId;
    const existing = await client.query('SELECT id FROM customers WHERE phone = $1', [phone]);
    if (existing.rows.length) {
      customerId = existing.rows[0].id; // ім'я клієнта НЕ перетираємо
    } else {
      const c = await client.query(
        'INSERT INTO customers (full_name, phone) VALUES ($1, $2) RETURNING id', [name, phone]);
      customerId = c.rows[0].id;
    }
    if (customerId !== origCustomerId) {
      await client.query('UPDATE orders SET customer_id = $1 WHERE id = $2', [customerId, orderId]);
    }

    await client.query(
      `UPDATE orders SET full_name=$1, status=$2, ttn=$3, comment=$4,
        delivery_service=$5, city=$6, branch=$7, payment_type=$8, delivery_payment=$9,
        city_ref=$10, warehouse_ref=$11, warehouse_type=$12
       WHERE id=$13`,
      [name, b.status || 'Новый', b.ttn || '', b.comment || '',
       b.delivery_service || 'НП', b.city || '', b.branch || '',
       b.payment_type || 'на счет', b.delivery_payment || 'Отримувач',
       b.city_ref || '', b.warehouse_ref || '', b.warehouse_type || '', orderId]
    );

    // Збираємо що вже було списано раніше (per stock_id) — щоб не списувати двічі при редагуванні
    const prevRes = await client.query(
      `SELECT stock_id, quantity FROM order_items WHERE order_id = $1 AND from_stock = true AND stock_id IS NOT NULL`,
      [orderId]
    );
    const prevDeducted = new Map();
    prevRes.rows.forEach(r => {
      prevDeducted.set(r.stock_id, (prevDeducted.get(r.stock_id) || 0) + (parseInt(r.quantity) || 0));
    });

    await client.query('DELETE FROM order_items WHERE order_id = $1', [orderId]);

    // Скільки потрібно зараз
    const needed = new Map();
    for (const it of list) {
      if (it.from_stock && it.stock_id) {
        const qty = parseInt(it.quantity) || 1;
        needed.set(it.stock_id, (needed.get(it.stock_id) || 0) + qty);
      }
    }
    // Списуємо лише дельту (нове - вже списане). Зменшення не повертається на склад (вручну).
    for (const [stockId, needQty] of needed) {
      const already = prevDeducted.get(stockId) || 0;
      const delta = needQty - already;
      if (delta > 0) {
        const upd = await client.query(
          `UPDATE stock SET quantity = quantity - $1 WHERE id = $2 AND quantity >= $1`,
          [delta, stockId]
        );
        if (upd.rowCount === 0) throw new Error(`Недостатньо на складі (id=${stockId})`);
      }
    }

    for (const it of list) {
      let supplierName = it.supplier_name || '';
      if (it.supplier_id) {
        const s = await client.query('SELECT name FROM suppliers WHERE id = $1', [it.supplier_id]);
        if (s.rows.length) supplierName = s.rows[0].name;
      }
      const qty = parseInt(it.quantity) || 1;
      const fromStock = Boolean(it.from_stock && it.stock_id);
      await client.query(
        `INSERT INTO order_items (order_id, article, name, supplier_id, supplier_name,
          size, color, price, quantity, from_stock, stock_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [orderId, it.article || '', it.name || '', it.supplier_id || null, supplierName,
         it.size || '', it.color || '', Number(it.price) || 0, qty,
         fromStock, fromStock ? it.stock_id : null]
      );
    }

    // Авто: Новый/Не дозвон -> В работе, якщо заповнені всі дані для ТТН
    if (PROMOTABLE_TO_WORK.includes(b.status || 'Новый') &&
        readyForWork({ fullName: name, phone, city_ref: b.city_ref, warehouse_ref: b.warehouse_ref, itemsCount: list.length })) {
      await client.query(`UPDATE orders SET status = 'В работе' WHERE id = $1`, [orderId]);
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    const msg = /unique/i.test(err.message)
      ? 'Клієнт з таким телефоном вже існує'
      : err.message;
    res.status(500).json({ error: msg });
  } finally {
    client.release();
  }
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
app.post('/api/landing/order', landingLimiter, async (req, res) => {
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

    // Прив'язка лише за телефоном; ім'я існуючого клієнта НЕ перетираємо
    const cust = await client.query('SELECT id FROM customers WHERE phone = $1', [phone]);
    let customerId;
    if (cust.rows.length > 0) {
      customerId = cust.rows[0].id;
    } else {
      const c = await client.query(
        'INSERT INTO customers (full_name, phone) VALUES ($1, $2) RETURNING id', [name, phone]);
      customerId = c.rows[0].id;
    }

    const order = await client.query(
      `INSERT INTO orders (customer_id, full_name, status, source) VALUES ($1, $2, $3, $4) RETURNING id`,
      [customerId, name, 'Новый', source]
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

// ===================== NOVA POSHTA ИНТЕГРАЦИЯ =====================
const NP_URL = 'https://api.novaposhta.ua/v2.0/json/';

async function getNpSettings() {
  const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'np'`);
  return r.rows.length ? r.rows[0].value : {};
}
async function saveNpSettings(obj) {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('np', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`, [obj]);
}

async function npCall(model, method, properties, apiKeyOverride) {
  const s = await getNpSettings();
  const apiKey = apiKeyOverride || s.apiKey;
  if (!apiKey) throw new Error('Не вказано API-ключ Нова Пошта (вкладка Налаштування)');
  const resp = await fetch(NP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey, modelName: model, calledMethod: method, methodProperties: properties || {} })
  });
  const j = await resp.json();
  if (!j.success) {
    const msg = (j.errors && j.errors.length) ? j.errors.join('; ')
      : (j.warnings && j.warnings.length ? j.warnings.join('; ') : 'Помилка API Нова Пошта');
    throw new Error(msg);
  }
  return j.data || [];
}

// Код статусу НП -> статус замовлення CRM
function npStatusToOrder(code) {
  code = String(code || '');
  if (['1'].includes(code)) return 'Доставка';
  if (['2', '3'].includes(code)) return 'Ошибка в ТТН';
  if (['4', '5', '6', '41', '111', '112'].includes(code)) return 'В пути';
  if (['7', '8', '12'].includes(code)) return 'На почте';
  if (['9', '10', '11', '106'].includes(code)) return 'Продажа';
  if (['102', '103', '105', '108'].includes(code)) return 'Отказ';
  if (['104'].includes(code)) return 'Переадресация';
  return null; // невідомий код — статус не чіпаємо
}

// Налаштування (читання/збереження) ---------------------------------
app.get('/api/settings/np', checkAuth, async (req, res) => {
  try { res.json(await getNpSettings()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings/np', checkAuth, async (req, res) => {
  try {
    const cur = await getNpSettings();
    const b = req.body || {};
    const next = {
      ...cur,
      apiKey: (b.apiKey ?? cur.apiKey ?? '').trim(),
      senderPhone: (b.senderPhone ?? cur.senderPhone ?? '').trim(),
      citySenderRef: b.citySenderRef ?? cur.citySenderRef ?? '',
      citySenderName: b.citySenderName ?? cur.citySenderName ?? '',
      senderAddressRef: b.senderAddressRef ?? cur.senderAddressRef ?? '',
      senderAddressName: b.senderAddressName ?? cur.senderAddressName ?? '',
      weight: String(b.weight ?? cur.weight ?? '0.5'),
      description: (b.description ?? cur.description ?? 'Одяг').trim(),
      seats: String(b.seats ?? cur.seats ?? '1'),
      cargoType: b.cargoType ?? cur.cargoType ?? 'Parcel'
    };
    await saveNpSettings(next);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/np/test', checkAuth, async (req, res) => {
  try {
    const key = (req.body && req.body.apiKey) || undefined;
    const data = await npCall('Common', 'getCargoTypes', {}, key);
    res.json({ success: true, count: Array.isArray(data) ? data.length : 0 });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Автопідказки міст/відділень ---------------------------------------
app.get('/api/np/cities', checkAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const data = await npCall('Address', 'getCities', { FindByString: q, Limit: '20' });
    res.json(data.map(c => ({ ref: c.Ref, name: c.Description, area: c.AreaDescription || '' })));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/np/warehouses', checkAuth, async (req, res) => {
  try {
    const cityRef = String(req.query.cityRef || '').trim();
    if (!cityRef) return res.json([]);
    const q = String(req.query.q || '').trim();
    const props = { CityRef: cityRef, Limit: '500' };
    if (q) props.FindByString = q;
    const data = await npCall('Address', 'getWarehouses', props);
    res.json(data.map(w => ({ ref: w.Ref, name: w.Description, type: w.CategoryOfWarehouse || '' })));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Резолв відправника (контрагент + контакт) за API-ключем
async function resolveSender(s) {
  let { senderRef, contactSenderRef } = s;
  if (senderRef && contactSenderRef) return { senderRef, contactSenderRef };
  const cps = await npCall('Counterparty', 'getCounterparties', { CounterpartyProperty: 'Sender', Page: '1' });
  if (!cps.length) throw new Error('У кабінеті НП не знайдено відправника');
  senderRef = cps[0].Ref;
  const contacts = await npCall('Counterparty', 'getCounterpartyContactPersons', { Ref: senderRef, Page: '1' });
  if (!contacts.length) throw new Error('У відправника НП немає контактної особи');
  contactSenderRef = contacts[0].Ref;
  await saveNpSettings({ ...s, senderRef, contactSenderRef });
  return { senderRef, contactSenderRef };
}

// Тип оплати "на счет" = постоплата з зарахуванням на рахунок NovaPay
// (поле AfterpaymentOnGoodsCost). "повна оплата" = без постоплати.
function isAfterpayment(paymentType) {
  return String(paymentType || '').toLowerCase().trim() === 'на счет';
}

// Генерація ТТН для одного замовлення (повертає номер ТТН або кидає помилку).
// s — налаштування НП, sender — { senderRef, contactSenderRef }.
async function generateTtnForOrder(orderId, s, sender) {
  const oq = await pool.query(`
    SELECT o.*, c.full_name AS "fullName", c.phone,
           COALESCE(SUM(oi.price * oi.quantity),0) AS total
    FROM orders o JOIN customers c ON o.customer_id=c.id
    LEFT JOIN order_items oi ON oi.order_id=o.id
    WHERE o.id=$1 GROUP BY o.id, c.full_name, c.phone`, [orderId]);
  if (!oq.rows.length) throw new Error('Замовлення не знайдено');
  const o = oq.rows[0];

  if (!o.city_ref || !o.warehouse_ref) {
    await pool.query(`UPDATE orders SET status='Ошибка в ТТН' WHERE id=$1`, [orderId]);
    throw new Error('У замовленні не обрані місто/відділення зі списку Нова Пошта');
  }

  const phone = String(o.phone || '').replace(/\D/g, '');
  const nameParts = String(o.fullName || '').trim().split(/\s+/);
  const cost = Math.round(Number(o.total) || 0) || 1;
  const payer = (o.delivery_payment === 'Відправник') ? 'Sender' : 'Recipient';
  const afterpay = isAfterpayment(o.payment_type);
  const d = new Date();
  const dateStr = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;

  const weight = String(s.weight || '0.5');
  const isPostomat = /postomat|поштомат/i.test(o.warehouse_type || '');
  const props = {
    PayerType: payer,
    PaymentMethod: 'Cash',
    DateTime: dateStr,
    CargoType: s.cargoType || 'Parcel',
    Weight: weight,
    ServiceType: isPostomat ? 'WarehousePostomat' : 'WarehouseWarehouse',
    SeatsAmount: String(s.seats || '1'),
    Description: s.description || 'Одяг',
    Cost: String(cost),
    OptionsSeat: [{
      volumetricVolume: '1',
      volumetricWidth: '20',
      volumetricLength: '20',
      volumetricHeight: '10',
      weight: weight
    }],
    CitySender: s.citySenderRef,
    Sender: sender.senderRef,
    SenderAddress: s.senderAddressRef,
    ContactSender: sender.contactSenderRef,
    SendersPhone: String(s.senderPhone || '').replace(/\D/g, ''),
    RecipientCityName: o.city || '',
    RecipientArea: '',
    CityRecipient: o.city_ref,
    RecipientAddress: o.warehouse_ref,
    RecipientAddressName: o.branch || '',
    RecipientName: o.fullName || '',
    RecipientType: 'PrivatePerson',
    RecipientsPhone: phone,
    NewAddress: '1',
    FirstName: nameParts[0] || o.fullName || '',
    MiddleName: nameParts.length > 2 ? nameParts[1] : '',
    LastName: nameParts.length > 1 ? nameParts[nameParts.length - 1] : ''
  };
  if (afterpay) {
    props.AfterpaymentOnGoodsCost = String(cost);
  }

  const data = await npCall('InternetDocument', 'save', props);
  const doc = data[0] || {};
  const ttn = doc.IntDocNumber || doc.Number || '';
  if (!ttn) throw new Error('НП не повернула номер ТТН');

  await pool.query(
    `UPDATE orders SET ttn=$1, np_doc_ref=$2, status='Доставка',
      np_status_code='1', np_status_text='Накладну створено', np_updated_at=now()
     WHERE id=$3`,
    [ttn, doc.Ref || '', orderId]
  );
  return ttn;
}

async function requireNpReady() {
  const s = await getNpSettings();
  if (!s.apiKey) throw new Error('Спершу заповніть Налаштування Нова Пошта');
  if (!s.citySenderRef || !s.senderAddressRef || !s.senderPhone)
    throw new Error('У Налаштуваннях не вказані дані відправника');
  const sender = await resolveSender(s);
  return { s, sender };
}

// Генерація ТТН — одне замовлення
app.post('/api/orders/:id(\\d+)/ttn', checkAuth, async (req, res) => {
  try {
    const { s, sender } = await requireNpReady();
    const ttn = await generateTtnForOrder(req.params.id, s, sender);
    res.json({ success: true, ttn });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Масова генерація ТТН — всі замовлення «В работе» з повними даними і без ТТН
app.post('/api/orders/ttn/bulk', checkAuth, async (req, res) => {
  try {
    const { s, sender } = await requireNpReady();
    const q = await pool.query(`
      SELECT id FROM orders
      WHERE status = 'В работе'
        AND city_ref <> '' AND warehouse_ref <> ''
        AND (ttn = '' OR ttn IS NULL)
      ORDER BY id ASC`);
    let created = 0, failed = 0;
    const errors = [];
    for (const row of q.rows) {
      try { await generateTtnForOrder(row.id, s, sender); created++; }
      catch (e) { failed++; errors.push({ id: row.id, error: e.message }); }
    }
    res.json({ success: true, total: q.rows.length, created, failed, errors: errors.slice(0, 30) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Оновлення статусів посилок ----------------------------------------
async function refreshNpStatuses() {
  const s = await getNpSettings();
  if (!s.apiKey) return { updated: 0, skipped: 'no api key' };
  const FINAL = ['Продажа', 'Отказ', '✗✗✗'];
  const q = await pool.query(
    `SELECT id, ttn FROM orders
     WHERE ttn <> '' AND ttn IS NOT NULL AND status <> ALL($1)`, [FINAL]);
  if (!q.rows.length) return { updated: 0 };
  const docs = q.rows.map(r => ({ DocumentNumber: r.ttn, Phone: '' }));
  let updated = 0;
  for (let i = 0; i < docs.length; i += 100) {
    const chunk = docs.slice(i, i + 100);
    let data;
    try { data = await npCall('TrackingDocument', 'getStatusDocuments', { Documents: chunk }); }
    catch (e) { continue; }
    for (const st of data) {
      const row = q.rows.find(r => r.ttn === st.Number);
      if (!row) continue;
      const newStatus = npStatusToOrder(st.StatusCode);
      const fields = {
        np_status_code: String(st.StatusCode || ''),
        np_status_text: st.Status || '',
        np_delivery_date: st.ScheduledDeliveryDate || st.DateScheduledDelivery || '',
        np_delivery_cost: Number(st.DocumentCost) || 0,
        np_arrival_date: st.RecipientDateTime || st.ActualDeliveryDate || ''
      };
      const sets = Object.keys(fields).map((k, idx) => `${k}=$${idx + 1}`);
      const vals = Object.values(fields);
      if (newStatus) { sets.push(`status=$${vals.length + 1}`); vals.push(newStatus); }
      sets.push(`np_updated_at=now()`);
      vals.push(row.id);
      await pool.query(`UPDATE orders SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
      updated++;
    }
  }
  return { updated };
}

app.post('/api/np/refresh', checkAuth, async (req, res) => {
  try { res.json({ success: true, ...(await refreshNpStatuses()) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ===================== TURBOSMS ИНТЕГРАЦИЯ =====================
const TURBOSMS_URL = 'https://api.turbosms.ua/message/send.json';

const DEFAULT_SMS = {
  token: '',
  sender: 'MAGAZIN',
  autoSend: true,
  sms1: 'Ваше замовлення комплектується: {TTN} ({TOV}).',
  sms2: 'Посилка: {TTN} ({TOV}) прибула. Ви можете її отримати!',
  sms3: 'Ваша посилка очікує на новій пошті: {TTN} ({TOV})'
};

async function getSmsSettings() {
  const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'sms'`);
  return { ...DEFAULT_SMS, ...(r.rows.length ? r.rows[0].value : {}) };
}
async function saveSmsSettings(obj) {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('sms', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`, [obj]);
}

// Підстановка змінних у шаблон
function renderTemplate(tpl, order, items) {
  const it = (items && items[0]) || {};
  const total = items ? items.reduce((s, x) => s + (Number(x.price) || 0) * (parseInt(x.quantity) || 1), 0) : 0;
  const map = {
    NUM: order.id ?? '',
    TTN: order.ttn || '',
    TOV: it.name || '',
    ART: it.article || '',
    SIZE: it.size || '',
    COLOR: it.color || '',
    NOTE: order.comment || '',
    PRICE: total || 0,
    SUM: total || 0,
    NAL: String(order.payment_type || '').toLowerCase() === 'на счет' ? total : '',
    FIO: order.fullName || '',
    TEL: order.phone || '',
    CITY: order.city || '',
    OP: order.branch || '',
    DATE: new Date().toISOString().slice(0, 10)
  };
  return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (map[k] != null ? String(map[k]) : ''));
}

function normPhoneTurbo(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('380')) return d;
  if (d.startsWith('80')) return '3' + d;
  if (d.startsWith('0')) return '38' + d;
  return d;
}

async function turboSmsSend(token, sender, phone, text) {
  const resp = await fetch(TURBOSMS_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      recipients: [phone],
      sms: { sender, text }
    })
  });
  const j = await resp.json().catch(() => ({}));
  const code = j.response_code != null ? Number(j.response_code) : -1;
  const okGlobal = code === 0 || code === 800; // 800 = "OK"
  const rr = (j.response_result && j.response_result[0]) || {};
  const okItem = !rr.response_status || rr.response_status === 'OK';
  if (!okGlobal || !okItem) {
    const msg = (rr.response_status && rr.response_status !== 'OK') ? rr.response_status
      : (j.response_status || ('TurboSMS code ' + code));
    throw new Error(msg);
  }
  return rr.message_id || true;
}

// Завантажити заказ з позиціями (для рендера шаблона)
async function loadOrderForSms(orderId) {
  const r = await pool.query(`
    SELECT o.*, c.full_name AS "fullName", c.phone,
      COALESCE(json_agg(json_build_object(
        'article', oi.article, 'name', oi.name,
        'size', oi.size, 'color', oi.color,
        'price', oi.price, 'quantity', oi.quantity
      ) ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
    FROM orders o JOIN customers c ON o.customer_id = c.id
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE o.id = $1 GROUP BY o.id, c.full_name, c.phone`, [orderId]);
  return r.rows[0] || null;
}

// Надсилання SMS для замовлення (kind = 1/2/3). force=true ігнорує "вже відправлено"
async function sendOrderSms(orderId, kind, force) {
  if (![1, 2, 3].includes(kind)) throw new Error('Невідомий тип SMS');
  const s = await getSmsSettings();
  if (!s.token) throw new Error('Не вказано токен TurboSMS у Налаштуваннях');
  const tpl = s['sms' + kind];
  if (!tpl) throw new Error('Шаблон SMS' + kind + ' порожній');

  const o = await loadOrderForSms(orderId);
  if (!o) throw new Error('Замовлення не знайдено');
  const phone = normPhoneTurbo(o.phone);
  if (!phone) throw new Error('У замовленні немає телефону');

  if (!force && o['sms' + kind + '_sent_at']) {
    return { skipped: true, reason: 'already sent' };
  }

  const text = renderTemplate(tpl, o, o.items);
  try {
    await turboSmsSend(s.token, s.sender || 'MAGAZIN', phone, text);
    await pool.query(
      `UPDATE orders SET sms${kind}_sent_at = now(), sms${kind}_error = '' WHERE id = $1`,
      [orderId]
    );
    await pool.query(
      `INSERT INTO sms_log (order_id, kind, phone, text, status) VALUES ($1,$2,$3,$4,'ok')`,
      [orderId, kind, phone, text]
    );
    return { success: true };
  } catch (err) {
    const msg = String(err.message || err).slice(0, 500);
    await pool.query(
      `UPDATE orders SET sms${kind}_error = $1 WHERE id = $2`, [msg, orderId]);
    await pool.query(
      `INSERT INTO sms_log (order_id, kind, phone, text, status, error) VALUES ($1,$2,$3,$4,'error',$5)`,
      [orderId, kind, phone, text, msg]
    );
    throw err;
  }
}

// Автовідправка SMS 1/2/3 за умовами
async function autoSendSms() {
  const s = await getSmsSettings();
  if (!s.token || s.autoSend === false) return;

  // SMS1: в пути
  const q1 = await pool.query(
    `SELECT id FROM orders WHERE status='В пути' AND sms1_sent_at IS NULL AND ttn <> ''`);
  for (const r of q1.rows) { try { await sendOrderSms(r.id, 1, false); } catch (e) { /* помилка вже залогована */ } }

  // SMS2: на почте
  const q2 = await pool.query(
    `SELECT id FROM orders WHERE status='На почте' AND sms2_sent_at IS NULL AND ttn <> ''`);
  for (const r of q2.rows) { try { await sendOrderSms(r.id, 2, false); } catch (e) {} }

  // SMS3: на почте 5+ днів від np_arrival_date (fallback: sms2_sent_at + 5d)
  const q3 = await pool.query(`
    SELECT id FROM orders
    WHERE status='На почте' AND sms3_sent_at IS NULL AND sms2_sent_at IS NOT NULL
      AND (
        (np_arrival_date <> '' AND
          CASE WHEN np_arrival_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
               THEN to_timestamp(substring(np_arrival_date from 1 for 19),'YYYY-MM-DD HH24:MI:SS') < now() - interval '5 days'
               WHEN np_arrival_date ~ '^[0-9]{2}\\.[0-9]{2}\\.[0-9]{4}'
               THEN to_timestamp(substring(np_arrival_date from 1 for 10),'DD.MM.YYYY') < now() - interval '5 days'
               ELSE false END)
        OR (np_arrival_date = '' AND sms2_sent_at < now() - interval '5 days')
      )`);
  for (const r of q3.rows) { try { await sendOrderSms(r.id, 3, false); } catch (e) {} }
}

// Налаштування SMS ---------------------------------------------------
app.get('/api/settings/sms', checkAuth, async (req, res) => {
  try { res.json(await getSmsSettings()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings/sms', checkAuth, async (req, res) => {
  try {
    const cur = await getSmsSettings();
    const b = req.body || {};
    const next = {
      ...cur,
      token: (b.token ?? cur.token ?? '').trim(),
      sender: (b.sender ?? cur.sender ?? 'MAGAZIN').trim() || 'MAGAZIN',
      autoSend: b.autoSend !== undefined ? !!b.autoSend : cur.autoSend !== false,
      sms1: b.sms1 ?? cur.sms1 ?? '',
      sms2: b.sms2 ?? cur.sms2 ?? '',
      sms3: b.sms3 ?? cur.sms3 ?? ''
    };
    await saveSmsSettings(next);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Тестова відправка SMS з налаштувань
app.post('/api/sms/test', checkAuth, async (req, res) => {
  try {
    const { phone, text } = req.body || {};
    if (!phone || !text) return res.status(400).json({ error: 'Вкажіть phone та text' });
    const s = await getSmsSettings();
    if (!s.token) return res.status(400).json({ error: 'Не вказано токен TurboSMS' });
    await turboSmsSend(s.token, s.sender || 'MAGAZIN', normPhoneTurbo(phone), text);
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Ручна відправка SMS для замовлення (переотправка)
app.post('/api/orders/:id(\\d+)/sms/:kind(\\d+)', checkAuth, async (req, res) => {
  try {
    const r = await sendOrderSms(Number(req.params.id), Number(req.params.kind), true);
    res.json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Авто-опитування кожні 30 хв (НП + SMS)
setInterval(async () => {
  try { await refreshNpStatuses(); } catch (e) {}
  try { await autoSendSms(); } catch (e) {}
}, 30 * 60 * 1000);

// ===================== CHECKBOX (е-чек) =====================
const CHECKBOX_URL = 'https://api.checkbox.ua/api/v1';
const checkboxState = { token: null, tokenExpiresAt: 0, shiftId: null };

async function getCheckboxSettings() {
  const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'checkbox'`);
  return r.rows.length ? r.rows[0].value : {};
}
async function saveCheckboxSettings(obj) {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('checkbox', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`, [obj]);
}

async function checkboxFetch(path, method, body, token, licenseKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (licenseKey) headers['X-License-Key'] = licenseKey;
  headers['X-Client-Name'] = 'crm-dressymood';
  headers['X-Client-Version'] = '1.0';
  const r = await fetch(CHECKBOX_URL + path, {
    method: method || 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await r.text();
  let j = null;
  try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = { detail: txt }; }
  if (!r.ok) {
    const msg = (j && (j.message || j.detail)) || ('HTTP ' + r.status);
    throw new Error('Checkbox: ' + msg);
  }
  return j;
}

async function checkboxSignin(settings) {
  if (!settings.login || !settings.password) throw new Error('Не вказані логін/пароль кассира Checkbox');
  if (!settings.licenseKey) throw new Error('Не вказано License Key Checkbox');
  const body = { login: settings.login, password: settings.password };
  if (settings.pinCode) body.pin_code = settings.pinCode;
  const j = await checkboxFetch('/cashier/signin', 'POST', body, null, settings.licenseKey);
  checkboxState.token = j.access_token;
  checkboxState.tokenExpiresAt = Date.now() + 25 * 60 * 1000; // 25 min cache
  return j.access_token;
}

async function checkboxGetToken(settings) {
  if (checkboxState.token && Date.now() < checkboxState.tokenExpiresAt) return checkboxState.token;
  return await checkboxSignin(settings);
}

async function checkboxEnsureShift(settings) {
  const token = await checkboxGetToken(settings);
  // Спроба отримати поточну зміну кассира
  try {
    const cur = await checkboxFetch('/cashier/shift', 'GET', null, token, settings.licenseKey);
    if (cur && cur.id && cur.status === 'OPENED') {
      checkboxState.shiftId = cur.id;
      return cur.id;
    }
  } catch (e) { /* немає відкритої — створимо нижче */ }
  // Створюємо нову зміну
  const created = await checkboxFetch('/shifts', 'POST', {}, token, settings.licenseKey);
  let shiftId = created.id;
  // Чекаємо OPENED
  for (let i = 0; i < 15; i++) {
    const st = await checkboxFetch('/shifts/' + shiftId, 'GET', null, token, settings.licenseKey);
    if (st && st.status === 'OPENED') {
      checkboxState.shiftId = shiftId;
      return shiftId;
    }
    if (st && st.status === 'CLOSED') throw new Error('Не вдалось відкрити зміну Checkbox');
    await new Promise(res => setTimeout(res, 1000));
  }
  throw new Error('Зміна Checkbox не відкрилась (timeout)');
}

function buildReceiptGoods(order, items) {
  return items.map(it => {
    const name = [it.article, it.name].filter(Boolean).join(' ').trim() || 'Товар';
    const extras = [it.size, it.color].filter(Boolean).join(', ');
    const fullName = extras ? `${name} (${extras})` : name;
    const code = String(it.article || ('SKU-' + (it.id || Math.random().toString(36).slice(2, 8))));
    const priceKop = Math.round(Number(it.price || 0) * 100);
    const qty = Math.max(1, parseInt(it.quantity) || 1);
    return {
      good: { code: code.slice(0, 64), name: fullName.slice(0, 128) },
      quantity: qty * 1000,
      price: priceKop,
      is_return: false
    };
  });
}

// Налаштування Checkbox -------------------------------------------------
app.get('/api/settings/checkbox', checkAuth, async (req, res) => {
  try { res.json(await getCheckboxSettings()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings/checkbox', checkAuth, async (req, res) => {
  try {
    const cur = await getCheckboxSettings();
    const b = req.body || {};
    const next = {
      ...cur,
      login: (b.login ?? cur.login ?? '').trim(),
      password: (b.password ?? cur.password ?? ''),
      licenseKey: (b.licenseKey ?? cur.licenseKey ?? '').trim(),
      pinCode: (b.pinCode ?? cur.pinCode ?? '').trim()
    };
    await saveCheckboxSettings(next);
    // Скинути кеш токена після зміни налаштувань
    checkboxState.token = null; checkboxState.tokenExpiresAt = 0; checkboxState.shiftId = null;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/checkbox/test', checkAuth, async (req, res) => {
  try {
    const s = await getCheckboxSettings();
    await checkboxSignin(s);
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Генерація е-чека ------------------------------------------------------
app.post('/api/orders/:id(\\d+)/receipt', checkAuth, async (req, res) => {
  const orderId = req.params.id;
  try {
    const s = await getCheckboxSettings();
    if (!s.login || !s.password || !s.licenseKey)
      throw new Error('Спершу заповніть Налаштування Checkbox');

    const oq = await pool.query(
      `SELECT o.id, o.checkbox_receipt_id
       FROM orders o WHERE o.id = $1`, [orderId]);
    if (!oq.rows.length) return res.status(404).json({ error: 'Замовлення не знайдено' });
    if (oq.rows[0].checkbox_receipt_id) {
      // Уже є чек — повертаємо існуючий
      const cur = await pool.query(
        `SELECT checkbox_receipt_id AS id, checkbox_receipt_url AS url FROM orders WHERE id = $1`, [orderId]);
      return res.json({ success: true, existed: true, ...cur.rows[0] });
    }

    const itemsQ = await pool.query(
      `SELECT id, article, name, size, color, price, quantity
       FROM order_items WHERE order_id = $1 ORDER BY id`, [orderId]);
    if (!itemsQ.rows.length) throw new Error('У замовленні немає товарів');

    await checkboxEnsureShift(s);
    const token = await checkboxGetToken(s);

    const goods = buildReceiptGoods({ id: orderId }, itemsQ.rows);
    const total = goods.reduce((sum, g) => sum + g.price * (g.quantity / 1000), 0);
    const receiptBody = {
      goods,
      payments: [{ type: 'CASHLESS', value: total, label: 'Безготівковий' }],
      rounding: false
    };

    let receipt;
    try {
      receipt = await checkboxFetch('/receipts/sell', 'POST', receiptBody, token, s.licenseKey);
    } catch (err) {
      await pool.query(
        `UPDATE orders SET checkbox_receipt_error=$1 WHERE id=$2`,
        [String(err.message).slice(0, 500), orderId]);
      await pool.query(
        `INSERT INTO checkbox_log (order_id, status, error) VALUES ($1, 'error', $2)`,
        [orderId, String(err.message).slice(0, 500)]);
      throw err;
    }

    const receiptId = receipt.id;
    const url = `https://check.checkbox.ua/${receiptId}`;
    await pool.query(
      `UPDATE orders SET checkbox_receipt_id=$1, checkbox_receipt_url=$2,
                         checkbox_receipt_at=now(), checkbox_receipt_error=''
       WHERE id=$3`, [receiptId, url, orderId]);
    await pool.query(
      `INSERT INTO checkbox_log (order_id, receipt_id, status) VALUES ($1, $2, 'ok')`,
      [orderId, receiptId]);

    res.json({ success: true, id: receiptId, url });
  } catch (err) { res.status(400).json({ error: err.message }); }
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

app.patch('/api/warehouse/products/:id', checkAuth, async (req, res) => {
    const allowed = ['cost', 'price', 'target_roi_pct'];
    const keys = Object.keys(req.body).filter(k => allowed.includes(k));
    if (!keys.length) return res.status(400).json({ error: 'Нічого оновлювати' });
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const values = keys.map(k => Number(req.body[k]) || 0);
    values.push(req.params.id);
    try {
        await pool.query(`UPDATE products SET ${setClause} WHERE id = $${values.length}`, values);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- API НАЯВНОСТІ ---
// Перевірка наявності на складі за артикул+колір+розмір
app.get('/api/stock/lookup', checkAuth, async (req, res) => {
    const article = String(req.query.article || '').trim();
    const color = String(req.query.color || '').trim();
    const size = String(req.query.size || '').trim();
    if (!article || !color || !size) return res.json({ stock_id: null, quantity: 0 });
    try {
        const r = await pool.query(`
            SELECT s.id, s.quantity
            FROM stock s JOIN products p ON p.id = s.product_id
            WHERE p.article = $1 AND s.color ILIKE $2 AND s.size ILIKE $3 AND s.quantity > 0
            LIMIT 1
        `, [article, color, size]);
        if (!r.rows.length) return res.json({ stock_id: null, quantity: 0 });
        res.json({ stock_id: r.rows[0].id, quantity: r.rows[0].quantity });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

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
