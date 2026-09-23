process.env.TZ = 'Europe/Kyiv'; // єдиний час для всього застосунку (Date, логи, ТТН, SMS) = Київ
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const crypto = require('crypto');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
if (isProduction) app.set('trust proxy', 1);
// SSL: увімкнуто для зовнішніх provider'ів (Supabase/Render/AWS). Для внутрішньої Docker-мережі (Coolify/локально) — вимкнено.
const _dbUrl = process.env.DATABASE_URL || '';
const _useSsl = /supabase|render\.com|amazonaws|neon\.tech/i.test(_dbUrl) || process.env.PGSSL === 'true';
const pool = new Pool({ connectionString: _dbUrl, ssl: _useSsl ? { rejectUnauthorized: false } : false });
// Київський час для всіх SQL-запитів (NOW(), CURRENT_DATE, date_trunc — все в Europe/Kyiv)
pool.on('connect', (client) => {
  client.query("SET TIMEZONE TO 'Europe/Kyiv'").catch(err => console.error('SET TIMEZONE error:', err.message));
});

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
        await pool.query(`ALTER TABLE fb_ad_accounts ADD COLUMN IF NOT EXISTS currency VARCHAR(8);`);
        await pool.query(`ALTER TABLE fb_ad_accounts ADD COLUMN IF NOT EXISTS fx_rate NUMERIC;`);
        // Для запуску реклами з CRM: сторінка FB, Instagram-акаунт, піксель
        await pool.query(`ALTER TABLE fb_ad_accounts ADD COLUMN IF NOT EXISTS page_id VARCHAR(64) DEFAULT '';`);
        await pool.query(`ALTER TABLE fb_ad_accounts ADD COLUMN IF NOT EXISTS page_name VARCHAR(255) DEFAULT '';`);
        await pool.query(`ALTER TABLE fb_ad_accounts ADD COLUMN IF NOT EXISTS instagram_id VARCHAR(64) DEFAULT '';`);
        await pool.query(`ALTER TABLE fb_ad_accounts ADD COLUMN IF NOT EXISTS pixel_id VARCHAR(64) DEFAULT '';`);

        // === КУРСИ ВАЛЮТ (історія авто-оновлень) ===
        await pool.query(`
            CREATE TABLE IF NOT EXISTS fx_rates (
                date DATE NOT NULL,
                source VARCHAR(16) NOT NULL,
                usd NUMERIC NOT NULL,
                eur NUMERIC,
                fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                PRIMARY KEY (date, source)
            );
        `);

        // === ЗАПУСКИ РЕКЛАМИ З CRM ===
        await pool.query(`
            CREATE TABLE IF NOT EXISTS fb_launches (
                id SERIAL PRIMARY KEY,
                ad_account_id INTEGER REFERENCES fb_ad_accounts(id) ON DELETE SET NULL,
                article VARCHAR(255) DEFAULT '',
                config JSONB NOT NULL DEFAULT '{}',        -- назва, бюджет, таргет, тексти, лінк
                creatives JSONB NOT NULL DEFAULT '[]',     -- [{file_id,name,kind,adset_name,image_hash|video_id}]
                status VARCHAR(16) NOT NULL DEFAULT 'pending', -- pending | running | done | error
                fb_campaign_id VARCHAR(64) DEFAULT '',
                fb_ids JSONB DEFAULT '{}',
                log JSONB DEFAULT '[]',
                error TEXT DEFAULT '',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                started_at TIMESTAMP WITH TIME ZONE,
                finished_at TIMESTAMP WITH TIME ZONE
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
        // Рівень груп (adset): синк тепер level=adset, зберігаємо adset_id/adset_name.
        // Сума по article не змінюється (adset'и складаються в кампанію). Керування — по кампанії й по групі.
        await pool.query(`ALTER TABLE fb_spend_daily ADD COLUMN IF NOT EXISTS adset_id VARCHAR(64);`);
        await pool.query(`ALTER TABLE fb_spend_daily ADD COLUMN IF NOT EXISTS adset_name TEXT DEFAULT '';`);
        // spend зберігається у РОДНІЙ валюті кабінету; currency+fx_rate для конвертації в грн у статистиці/фінансах
        await pool.query(`ALTER TABLE fb_spend_daily ADD COLUMN IF NOT EXISTS currency VARCHAR(8) DEFAULT 'UAH';`);
        await pool.query(`ALTER TABLE fb_spend_daily ADD COLUMN IF NOT EXISTS fx_rate NUMERIC DEFAULT 1;`);
        await pool.query(`ALTER TABLE fb_spend_daily DROP CONSTRAINT IF EXISTS fb_spend_daily_ad_account_id_date_campaign_id_key;`).catch(()=>{});
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_fb_spend_adset ON fb_spend_daily(ad_account_id, date, adset_id);`).catch(()=>{});

        // === ПОВЕРНЕННЯ (відмови, що їдуть назад до кур'єра) ===
        await pool.query(`
            CREATE TABLE IF NOT EXISTS returns (
                id SERIAL PRIMARY KEY,
                order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
                ttn VARCHAR(255) DEFAULT '',
                return_ttn VARCHAR(255) DEFAULT '',                -- зворотна ЕН від НП
                status VARCHAR(16) NOT NULL DEFAULT 'in_transit',  -- in_transit | at_branch | picked_up | received | problem
                return_city VARCHAR(100) DEFAULT '',               -- Одеса / Харків (з НП)
                return_branch TEXT DEFAULT '',
                refused_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                arrived_at TIMESTAMP WITH TIME ZONE,               -- прибула на відділення
                picked_up_at TIMESTAMP WITH TIME ZONE,             -- кур'єр забрав (НП: одержано)
                received_at TIMESTAMP WITH TIME ZONE,              -- я отримав від кур'єра (вручну)
                np_status_code VARCHAR(16) DEFAULT '',
                np_status_text VARCHAR(255) DEFAULT '',
                np_return_cost NUMERIC DEFAULT 0,
                np_updated_at TIMESTAMP WITH TIME ZONE,
                note TEXT DEFAULT ''
            );
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_returns_status ON returns(status);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_returns_refused_at ON returns(refused_at);`);

        // === АВТОПРАВИЛА РЕКЛАМИ ===
        await pool.query(`
            CREATE TABLE IF NOT EXISTS fb_rules (
                id SERIAL PRIMARY KEY,
                name VARCHAR(150) NOT NULL,
                scope VARCHAR(16) NOT NULL DEFAULT 'adset',      -- adset | campaign | article
                metric VARCHAR(24) NOT NULL DEFAULT 'cpl',        -- cpl | roi | spend_no_sales
                window_days SMALLINT DEFAULT 7,
                param NUMERIC DEFAULT 1,                          -- множник граничного CPL / поріг ROI% / множник для kill
                action VARCHAR(16) DEFAULT 'pause',               -- pause
                min_leads INTEGER DEFAULT 5,
                min_spend NUMERIC DEFAULT 0,                      -- у грн
                cooldown_hours INTEGER DEFAULT 24,
                mode VARCHAR(8) DEFAULT 'dry',                    -- dry | live
                is_active BOOLEAN DEFAULT true,
                last_run_at TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS fb_rule_log (
                id SERIAL PRIMARY KEY,
                rule_id INTEGER REFERENCES fb_rules(id) ON DELETE SET NULL,
                rule_name VARCHAR(150) DEFAULT '',
                level VARCHAR(16) DEFAULT '',
                entity_id VARCHAR(64) DEFAULT '',
                entity_name TEXT DEFAULT '',
                article VARCHAR(255) DEFAULT '',
                ad_account_id INTEGER,
                metric_value NUMERIC,
                threshold NUMERIC,
                action VARCHAR(16) DEFAULT '',
                mode VARCHAR(8) DEFAULT '',
                result VARCHAR(16) DEFAULT '',                    -- would | done | error
                message TEXT DEFAULT '',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_fb_rule_log_created ON fb_rule_log(created_at DESC);`);
        // Глобальний вимикач автоправил
        await pool.query(`INSERT INTO app_settings (key, value) VALUES ('fb_rules_enabled', 'true'::jsonb) ON CONFLICT (key) DO NOTHING;`);

        // === ФІНАНСИ ===
        await pool.query(`
            CREATE TABLE IF NOT EXISTS finance_accounts (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                initial_balance NUMERIC DEFAULT 0,
                color VARCHAR(20) DEFAULT '#8b5cf6',
                icon VARCHAR(50) DEFAULT 'wallet',
                is_archived BOOLEAN DEFAULT false,
                sort_order INTEGER DEFAULT 0,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS finance_categories (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                kind VARCHAR(20) NOT NULL,
                color VARCHAR(20) DEFAULT '#94a3b8',
                is_system BOOLEAN DEFAULT false,
                sort_order INTEGER DEFAULT 0
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS finance_transactions (
                id SERIAL PRIMARY KEY,
                date DATE NOT NULL,
                kind VARCHAR(20) NOT NULL,
                amount NUMERIC NOT NULL,
                account_id INTEGER REFERENCES finance_accounts(id) ON DELETE CASCADE,
                to_account_id INTEGER REFERENCES finance_accounts(id) ON DELETE SET NULL,
                category_id INTEGER REFERENCES finance_categories(id) ON DELETE SET NULL,
                description TEXT DEFAULT '',
                source VARCHAR(50) DEFAULT 'manual',
                source_ref VARCHAR(100) DEFAULT '',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_fin_tx_date ON finance_transactions(date);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_fin_tx_account ON finance_transactions(account_id);`);

        // Регулярні (постійні) витрати — шаблони: оренда, зарплата, підписки, податки тощо
        await pool.query(`
            CREATE TABLE IF NOT EXISTS finance_recurring (
                id SERIAL PRIMARY KEY,
                name VARCHAR(150) NOT NULL,
                amount NUMERIC NOT NULL DEFAULT 0,
                category_id INTEGER REFERENCES finance_categories(id) ON DELETE SET NULL,
                account_id INTEGER REFERENCES finance_accounts(id) ON DELETE SET NULL,
                day_of_month SMALLINT DEFAULT 1,
                note TEXT DEFAULT '',
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);

        // Seed системних категорій (тільки якщо таблиця порожня)
        const catCount = await pool.query(`SELECT COUNT(*)::int AS c FROM finance_categories`);
        if (catCount.rows[0].c === 0) {
            const seed = [
                ['Продаж', 'income', '#10b981', true, 1],
                ['Повернення товару', 'income', '#06b6d4', true, 2],
                ['Інший дохід', 'income', '#8b5cf6', true, 3],
                ['Закупка товару', 'expense', '#f97316', true, 1],
                ['Реклама', 'expense', '#3b82f6', true, 2],
                ['Повернення на пошті', 'expense', '#f43f5e', true, 3],
                ['Зарплата', 'expense', '#a855f7', true, 4],
                ['Послуги (SMS, чеки, домен)', 'expense', '#64748b', true, 5],
                ['Податки', 'expense', '#dc2626', true, 6],
                ['Оренда / комуналка', 'expense', '#94a3b8', true, 7],
                ['Інша витрата', 'expense', '#475569', true, 8]
            ];
            for (const [name, kind, color, is_system, sort_order] of seed) {
                await pool.query(
                    `INSERT INTO finance_categories (name, kind, color, is_system, sort_order) VALUES ($1,$2,$3,$4,$5)`,
                    [name, kind, color, is_system, sort_order]
                );
            }
        }

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
    // Відмова/повернення → заводимо повернення для обліку з кур'єром (і навпаки — знімаємо)
    if (req.body.status !== undefined) {
      await syncReturnForOrderStatus(req.params.id, req.body.status);
    }
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
    const dateConds = [`o.status <> '✗✗✗'`]; // не рахуємо видалені замовлення
    if (dateFrom) { dateParams.push(dateFrom); dateConds.push(`${dateExpr} >= $${dateParams.length}::date`); }
    if (dateTo)   { dateParams.push(dateTo);   dateConds.push(`${dateExpr} < ($${dateParams.length}::date + interval '1 day')`); }
    const dateWhere = 'WHERE ' + dateConds.join(' AND ');

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
        COUNT(DISTINCT o.id) FILTER (WHERE o.ttn <> '' AND o.ttn IS NOT NULL)::int AS orders_shipped,
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
        COUNT(DISTINCT o.id) FILTER (WHERE o.ttn <> '' AND o.ttn IS NOT NULL)::int AS orders_shipped,
        COALESCE(SUM(oi.quantity), 0)::int AS units,
        COALESCE(SUM(oi.price * oi.quantity), 0)::numeric AS revenue,
        COALESCE(SUM(COALESCE((SELECT MAX(cost) FROM products p WHERE p.article = oi.article), 0) * oi.quantity), 0)::numeric AS cost
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      ${soldWhere}
      AND oi.article IS NOT NULL AND oi.article <> ''
      GROUP BY oi.article`;

    // Повернення (для returns cost) — лише ВІДПРАВЛЕНІ посилки (є ТТН): тільки за них НП бере
    // за зворотну доставку і кур'єр — за відправку. Без ТТН нічого не їхало.
    const refusedParams = [];
    const refusedConds = [`o.status IN ('Отказ','Возврат')`, `o.ttn <> ''`, `o.ttn IS NOT NULL`];
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
    const grnSpend = fxSpendSql(settings);
    const spendTotalQ = `
      SELECT
        COALESCE(SUM(${grnSpend}), 0)::numeric AS spend,
        COALESCE(SUM(leads), 0)::int AS leads
      FROM fb_spend_daily ${spendWhere}`;
    const spendByArtQ = `
      SELECT article, SUM(${grnSpend})::numeric AS spend, SUM(leads)::int AS leads
      FROM fb_spend_daily ${spendWhere}
      ${spendConds.length ? 'AND' : 'WHERE'} article IS NOT NULL AND article <> ''
      GROUP BY article`;
    const spendUnmappedQ = `
      SELECT COALESCE(SUM(${grnSpend}), 0)::numeric AS spend, COALESCE(SUM(leads), 0)::int AS leads
      FROM fb_spend_daily ${spendWhere}
      ${spendConds.length ? 'AND' : 'WHERE'} (article IS NULL OR article = '')`;

    // Підтверджені (approved) — для SMS-витрат
    const APPROVED_SET = `('В работе','Доставка','В пути','На почте','Продажа','Отказ','Возврат','Ошибка в ТТН','Переадресация')`;
    const appParams = [];
    const appConds = [`o.status IN ${APPROVED_SET}`];
    if (dateFrom) { appParams.push(dateFrom); appConds.push(`${dateExpr} >= $${appParams.length}::date`); }
    if (dateTo)   { appParams.push(dateTo);   appConds.push(`${dateExpr} < ($${appParams.length}::date + interval '1 day')`); }
    const appWhere = 'WHERE ' + appConds.join(' AND ');
    const appByArtQ = `SELECT oi.article, COUNT(DISTINCT o.id)::int AS approved FROM orders o JOIN order_items oi ON oi.order_id=o.id ${appWhere} AND oi.article IS NOT NULL AND oi.article <> '' GROUP BY oi.article`;
    const appTotalQ = `SELECT COUNT(DISTINCT o.id)::int AS approved FROM orders o ${appWhere}`;

    const [t, a, refT, refA, spT, spA, spU, appT, appA] = await Promise.all([
      pool.query(totalsQ, soldParams),
      pool.query(byArtQ, soldParams),
      pool.query(refusedTotalQ, refusedParams),
      pool.query(refusedByArtQ, refusedParams),
      pool.query(spendTotalQ, spendParams),
      pool.query(spendByArtQ, spendParams),
      pool.query(spendUnmappedQ, spendParams),
      pool.query(appTotalQ, appParams),
      pool.query(appByArtQ, appParams)
    ]);
    const { smsCost, courierCost, overheadPerSale } = await overheadContext(dateFrom, dateTo);

    const tr = t.rows[0] || {};
    const revenue = Number(tr.revenue) || 0;
    const cost = Number(tr.cost) || 0;
    const grossProfit = revenue - cost;
    const adSpend = Number(spT.rows[0].spend) || 0;
    const leadsTotal = Number(spT.rows[0].leads) || 0;
    const refusedTotal = Number(refT.rows[0].refused) || 0;
    const returnsCost = refusedTotal * returnCost;
    const approvedTotal = Number(appT.rows[0].approved) || 0;
    const smsTotal = approvedTotal * smsCost;
    const overheadTotal = (Number(tr.orders) || 0) * overheadPerSale;
    // Кур'єр — за кожну ВІДПРАВЛЕНУ посилку (є ТТН): продані + відмови
    const courierTotal = ((Number(tr.orders_shipped) || 0) + refusedTotal) * courierCost;
    const netProfit = grossProfit - adSpend - returnsCost - smsTotal - courierTotal - overheadTotal;
    const approvedMap = {};
    appA.rows.forEach(r => { approvedMap[r.article] = Number(r.approved) || 0; });
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
      const r = salesByArt[article] || { orders: 0, orders_shipped: 0, units: 0, revenue: 0, cost: 0 };
      const rev = Number(r.revenue) || 0;
      const c = Number(r.cost) || 0;
      const gross = rev - c;
      const refused = refusedMap[article] || 0;
      const ret = refused * returnCost;
      const sp = (spendMap[article] && spendMap[article].spend) || 0;
      const ld = (spendMap[article] && spendMap[article].leads) || 0;
      const smsC = (approvedMap[article] || 0) * smsCost;
      const ovhC = (Number(r.orders) || 0) * overheadPerSale;
      const courC = ((Number(r.orders_shipped) || 0) + refused) * courierCost;
      const net = gross - sp - ret - smsC - courC - ovhC;
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
        sms_cost: smsC,
        courier_cost: courC,
        overhead_cost: ovhC,
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
        sms_cost: smsTotal,
        courier_cost: courierTotal,
        overhead_cost: overheadTotal,
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
  campaign_regex: '\\[([^\\]]+)\\]',
  new_approval_pct: 70, // орієнтир для новинок без історії
  new_buyout_pct: 60,
  sms_count: 3,   // скільки SMS на підтверджене замовлення
  sms_price: 0,   // ціна однієї SMS, ₴
  courier_cost: 40, // кур'єр за одну відправку, ₴ (на кожну відправлену посилку: продаж + відмови)
  fx_usd: 41,     // курс USD→UAH для конвертації витрат FB
  fx_eur: 45,     // курс EUR→UAH
  fx_source: 'mono' // nbu | mono | privat | manual — звідки авто-оновлюється курс
};

async function getEconomicsSettings() {
  const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'economics'`);
  return { ...ECONOMICS_DEFAULTS, ...(r.rows.length ? r.rows[0].value : {}) };
}

// SQL: витрата FB у гривні за курсом ДНЯ витрати (останній відомий курс на цю дату з fx_rates).
// Якщо історії на цю дату ще немає — поточний курс із налаштувань. Так минулі періоди не «пливуть»
// при кожній зміні курсу.
function fxSpendSql(settings, tbl = 'fb_spend_daily') {
  const usd = Number(settings.fx_usd) || 41, eur = Number(settings.fx_eur) || 45;
  const src = ['nbu', 'mono', 'privat'].includes(settings.fx_source) ? settings.fx_source : 'mono';
  const pick = (col) => `(SELECT r.${col} FROM fx_rates r WHERE r.date <= ${tbl}.date AND r.${col} IS NOT NULL
                          ORDER BY r.date DESC, (r.source = '${src}') DESC, r.fetched_at DESC LIMIT 1)`;
  return `${tbl}.spend * CASE ${tbl}.currency
            WHEN 'USD' THEN COALESCE(${pick('usd')}, ${usd})
            WHEN 'EUR' THEN COALESCE(${pick('eur')}, ${eur})
            ELSE 1 END`;
}

// Змінні витрати бізнесу: SMS на підтверджене + кур'єр на відправлене + накладні (постійні витрати) на замовлення.
// Накладні розкидаються на ФАКТИЧНІ продажі періоду (варіант A).
async function overheadContext(dateFrom, dateTo) {
  const s = await getEconomicsSettings();
  const smsCost = (Number(s.sms_count) || 0) * (Number(s.sms_price) || 0); // ₴ на підтверджене замовлення
  const courierCost = Number(s.courier_cost) || 0; // ₴ на кожну відправлену посилку (продаж + відмова)
  const fx = await pool.query(`SELECT COALESCE(SUM(amount),0)::numeric s FROM finance_recurring WHERE is_active = true`);
  const fixedMonthly = Number(fx.rows[0].s) || 0;
  let days = 30;
  if (dateFrom && dateTo) {
    const dd = Math.round((new Date(dateTo) - new Date(dateFrom)) / 86400000) + 1;
    if (isFinite(dd) && dd > 0) days = dd;
  }
  const periodFixed = fixedMonthly * days / 30;
  const lead = `COALESCE(o.original_created_at, o.created_at)`;
  const p = [], c = [`o.status = 'Продажа'`];
  if (dateFrom) { p.push(dateFrom); c.push(`${lead} >= $${p.length}::date`); }
  if (dateTo)   { p.push(dateTo);   c.push(`${lead} < ($${p.length}::date + interval '1 day')`); }
  const ts = await pool.query(`SELECT COUNT(DISTINCT o.id)::int n FROM orders o WHERE ${c.join(' AND ')}`, p);
  const totalSold = ts.rows[0].n || 0;
  const overheadPerSale = totalSold > 0 ? periodFixed / totalSold : 0;
  return { smsCost, courierCost, overheadPerSale, fixedMonthly, periodFixed, totalSold };
}

app.get('/api/settings/economics', checkAuth, async (req, res) => {
  try { res.json(await getEconomicsSettings()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings/economics', checkAuth, async (req, res) => {
  const allowed = ['return_cost', 'lookback_days', 'settlement_days', 'target_roi_pct', 'campaign_regex', 'new_approval_pct', 'new_buyout_pct', 'sms_count', 'sms_price', 'courier_cost', 'fx_usd', 'fx_eur', 'fx_source'];
  const current = await getEconomicsSettings();
  const next = { ...current };
  const STR_KEYS = ['campaign_regex', 'fx_source'];
  for (const k of allowed) {
    if (req.body[k] !== undefined && req.body[k] !== '') {
      next[k] = STR_KEYS.includes(k) ? String(req.body[k]) : Number(req.body[k]);
    }
  }
  if (!FX_SOURCES[next.fx_source]) next.fx_source = 'mono';
  // Курс з форми приймаємо лише в ручному режимі — інакше його веде авто-оновлення
  if (next.fx_source !== 'manual') { next.fx_usd = current.fx_usd; next.fx_eur = current.fx_eur; }
  try {
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('economics', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`, [next]);
    // Змінили джерело → одразу підтягнути курс
    let fx = null;
    if (next.fx_source !== 'manual' && next.fx_source !== current.fx_source) {
      try { fx = await updateFxRates(true); } catch (e) { fx = { error: e.message }; }
    }
    res.json({ success: true, settings: fx && !fx.error ? { ...next, fx_usd: fx.usd, fx_eur: fx.eur } : next, fx });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== КУРС ВАЛЮТ (авто) =====================
// Джерела: НБУ (офіційний), Monobank / ПриватБанк (курс продажу — по ньому банк списує $ з картки за рекламу).
// Оновлюється при старті і кожні 6 годин; історія в fx_rates.
const FX_SOURCES = {
  nbu: 'НБУ (офіційний)',
  mono: 'Monobank (продаж)',
  privat: 'ПриватБанк (продаж)',
  manual: 'Вручну'
};

async function fetchFxRates(source) {
  const get = async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  if (source === 'nbu') {
    const d = await get('https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json');
    const usd = (d.find(x => x.cc === 'USD') || {}).rate, eur = (d.find(x => x.cc === 'EUR') || {}).rate;
    if (!usd) throw new Error('НБУ не віддав USD');
    return { usd: Number(usd), eur: Number(eur) || 0 };
  }
  if (source === 'mono') {
    const d = await get('https://api.monobank.ua/bank/currency');
    const usd = d.find(x => x.currencyCodeA === 840 && x.currencyCodeB === 980);
    const eur = d.find(x => x.currencyCodeA === 978 && x.currencyCodeB === 980);
    if (!usd || !usd.rateSell) throw new Error('Monobank не віддав USD');
    return { usd: Number(usd.rateSell), eur: eur ? Number(eur.rateSell || eur.rateCross) || 0 : 0 };
  }
  if (source === 'privat') {
    const d = await get('https://api.privatbank.ua/p24api/pubinfo?exchange&coursid=11');
    const usd = d.find(x => x.ccy === 'USD'), eur = d.find(x => x.ccy === 'EUR');
    if (!usd || !usd.sale) throw new Error('ПриватБанк не віддав USD');
    return { usd: Number(usd.sale), eur: eur ? Number(eur.sale) || 0 : 0 };
  }
  throw new Error('Невідоме джерело курсу: ' + source);
}

async function updateFxRates(force) {
  const s = await getEconomicsSettings();
  const source = s.fx_source || 'mono';
  if (source === 'manual' && !force) return { skipped: 'manual' };
  if (source === 'manual') return { skipped: 'manual' };
  // Обране джерело не відповіло (ліміт/збій) → пробуємо інші, щоб курс не завис
  let rates = null, used = source, firstErr = null;
  for (const src of [source, ...['privat', 'nbu', 'mono'].filter(x => x !== source)]) {
    try { rates = await fetchFxRates(src); used = src; break; }
    catch (e) { if (!firstErr) firstErr = e; }
  }
  if (!rates) throw firstErr || new Error('Жодне джерело курсу не відповіло');
  const next = { ...s, fx_usd: Math.round(rates.usd * 100) / 100, fx_updated_at: new Date().toISOString(), fx_source: source, fx_used_source: used };
  if (rates.eur) next.fx_eur = Math.round(rates.eur * 100) / 100;
  await pool.query(`INSERT INTO app_settings (key, value) VALUES ('economics', $1)
                    ON CONFLICT (key) DO UPDATE SET value = $1`, [next]);
  await pool.query(`INSERT INTO fx_rates (date, source, usd, eur) VALUES (CURRENT_DATE, $1, $2, $3)
                    ON CONFLICT (date, source) DO UPDATE SET usd = EXCLUDED.usd, eur = EXCLUDED.eur, fetched_at = now()`,
    [used, next.fx_usd, next.fx_eur || null]);
  return { source: used, requested: source, fallback: used !== source, usd: next.fx_usd, eur: next.fx_eur, updated_at: next.fx_updated_at };
}

app.get('/api/settings/fx', checkAuth, async (req, res) => {
  try {
    const s = await getEconomicsSettings();
    const hist = await pool.query(`SELECT date, source, usd, eur FROM fx_rates ORDER BY date DESC, fetched_at DESC LIMIT 30`);
    res.json({ source: s.fx_source || 'mono', used_source: s.fx_used_source || null, usd: s.fx_usd, eur: s.fx_eur, updated_at: s.fx_updated_at || null, sources: FX_SOURCES, history: hist.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings/fx/refresh', checkAuth, async (req, res) => {
  try { res.json({ success: true, ...(await updateFxRates(true)) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

setTimeout(() => { updateFxRates().catch(e => console.error('[fx]', e.message)); }, 15 * 1000);
setInterval(() => { updateFxRates().catch(e => console.error('[fx]', e.message)); }, 6 * 60 * 60 * 1000);



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
    // «Ошибка в ТТН» не рахується: накладну видалено/не знайдено — посилка не їхала,
    // ні НП, ні кур'єр за неї не беруть, і це не рішення клієнта
    const REFUSED_AFTER_APPROVE = `('Отказ','Возврат')`;
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
    const _to2 = new Date(); const _from2 = new Date(); _from2.setDate(_from2.getDate() - lookback);
    const { smsCost: _sms, courierCost: _cour, overheadPerSale: _ovh } = await overheadContext(_from2.toLocaleDateString('sv-SE'), _to2.toLocaleDateString('sv-SE'));
    const revenue = per100.sold * sellPrice;
    const cogs = per100.sold * productCost;
    const returns = per100.refused * returnCost;
    const smsCost100 = per100.approved * _sms;
    const courier100 = (per100.sold + per100.refused) * _cour;
    const overhead100 = per100.sold * _ovh;
    const grossProfit = revenue - cogs - returns - smsCost100 - courier100 - overhead100;
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
      settings: { return_cost: returnCost, courier_cost: _cour },
      cpl: {
        max: Math.round(cpl_max * 100) / 100,
        recommended: Math.round(cpl_recommended * 100) / 100,
        gross_profit_per_100_leads: Math.round(grossProfit * 100) / 100
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== FACEBOOK ADS INTEGRATION =====================
const FB_API_VERSION = 'v25.0';

function extractArticleFromCampaign(campaignName, pattern) {
  if (!campaignName) return null;
  try {
    const re = new RegExp(pattern);
    const m = campaignName.match(re);
    if (m && m[1]) return m[1].trim();
  } catch (e) { /* invalid regex */ }
  return null;
}

// FB віддає ОДНУ й ту саму конверсію під кількома action_type одночасно
// (lead, offsite_conversion.fb_pixel_lead, onsite_web_lead, offsite_lead_add_20_s_calls).
// Їх не можна додавати — виходить подвійний/потрійний рахунок.
// Беремо агрегат 'lead' — саме його показує Ads Manager; якщо його немає,
// беремо максимум із конкретних типів, а не суму.
function getLeadCountFromActions(actions) {
  if (!Array.isArray(actions)) return 0;
  const val = (type) => {
    const a = actions.find(x => String(x.action_type || '') === type);
    return a ? (Number(a.value) || 0) : 0;
  };
  const lead = val('lead');
  if (lead > 0) return Math.round(lead);
  return Math.round(Math.max(
    val('offsite_conversion.fb_pixel_lead'),
    val('onsite_conversion.lead_grouped'),
    val('onsite_web_lead')
  ));
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
  // Валюта кабінету + курс у грн (spend зберігаємо в РОДНІЙ валюті, конвертуємо пізніше).
  // Валюту визначаємо з FB і кешуємо на кабінеті; при збої запиту — беремо збережену (НЕ скидаємо в UAH).
  const rateFor = (cur) => cur === 'USD' ? (Number(settings.fx_usd) || 41)
                         : cur === 'EUR' ? (Number(settings.fx_eur) || 45) : 1;
  let currency = (account.currency || '').toUpperCase() || null;
  try {
    const meta = await fbGet(`https://graph.facebook.com/${FB_API_VERSION}/act_${cleanId}?fields=currency&access_token=${encodeURIComponent(account.access_token)}`);
    if (meta && meta.currency) currency = String(meta.currency).toUpperCase();
  } catch (e) { /* лишаємо збережену валюту кабінету */ }
  if (!currency) currency = 'UAH';
  const fxRate = rateFor(currency);
  // Кешуємо валюту й курс на кабінеті
  await pool.query(`UPDATE fb_ad_accounts SET currency = $1, fx_rate = $2 WHERE id = $3`, [currency, fxRate, account.id]).catch(() => {});
  const since = new Date(); since.setDate(since.getDate() - (daysBack || 7));
  const until = new Date();
  const iso = d => d.toISOString().slice(0, 10);
  const timeRange = JSON.stringify({ since: iso(since), until: iso(until) });
  const fields = 'spend,impressions,clicks,actions,campaign_id,campaign_name,adset_id,adset_name';
  const params = new URLSearchParams({
    fields,
    level: 'adset',
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
      const adsetId = r.adset_id || null;
      const adsetName = r.adset_name || '';
      // Артикул шукаємо в назві кампанії, а якщо там нема — у назві групи
      const article = extractArticleFromCampaign(campaignName, pattern) || extractArticleFromCampaign(adsetName, pattern);
      const spend = Number(r.spend) || 0; // у родній валюті кабінету
      const impressions = Number(r.impressions) || 0;
      const clicks = Number(r.clicks) || 0;
      const leads = getLeadCountFromActions(r.actions);
      await pool.query(`
        INSERT INTO fb_spend_daily (ad_account_id, date, campaign_id, campaign_name, adset_id, adset_name, article, spend, impressions, clicks, leads, currency, fx_rate, last_synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW())
        ON CONFLICT (ad_account_id, date, adset_id) DO UPDATE SET
          campaign_id = EXCLUDED.campaign_id,
          campaign_name = EXCLUDED.campaign_name,
          adset_name = EXCLUDED.adset_name,
          article = EXCLUDED.article,
          spend = EXCLUDED.spend,
          impressions = EXCLUDED.impressions,
          clicks = EXCLUDED.clicks,
          leads = EXCLUDED.leads,
          currency = EXCLUDED.currency,
          fx_rate = EXCLUDED.fx_rate,
          last_synced_at = NOW()
      `, [account.id, date, campaignId, campaignName, adsetId, adsetName, article, spend, impressions, clicks, leads, currency, fxRate]);
      inserted++;
    }
    url = (j.paging && j.paging.next) ? j.paging.next : null;
  }
  return inserted;
}

async function syncAllFbAccounts(daysBack) {
  const r = await pool.query(`SELECT * FROM fb_ad_accounts WHERE is_active = true`);
  let total = 0; const errors = [];
  for (const acc of r.rows) {
    try {
      const n = await syncFbAccount(acc, daysBack);
      total += n;
      await pool.query(`UPDATE fb_ad_accounts SET last_sync_at = NOW(), last_sync_error = '' WHERE id = $1`, [acc.id]);
      console.log(`[FB sync] ${acc.name}: ${n} rows`);
    } catch (err) {
      console.error(`[FB sync] ${acc.name} error:`, err.message);
      errors.push({ account: acc.name, error: String(err.message || err) });
      await pool.query(`UPDATE fb_ad_accounts SET last_sync_at = NOW(), last_sync_error = $1 WHERE id = $2`, [String(err.message || err), acc.id]);
    }
  }
  return { total, accounts: r.rows.length, errors };
}

// CRUD кабінетів
app.get('/api/fb/accounts', checkAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, name, fb_account_id, is_active, last_sync_at, last_sync_error, created_at, currency, fx_rate
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
  const daysBack = Math.min(365, Math.max(1, Number(req.body && req.body.days) || 7));
  try {
    const r = await syncAllFbAccounts(daysBack);
    res.json({ success: true, ...r, days: daysBack });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== ПАНЕЛЬ КЕРУВАННЯ РЕКЛАМОЮ (ручна) =====

// Живі статуси кампаній і груп з FB (effective_status) для одного кабінету
async function fbLiveStatuses(account) {
  const cleanId = String(account.fb_account_id).replace(/^act_/, '');
  const campaigns = {}, adsets = {};
  // Кампанії
  let url = `https://graph.facebook.com/${FB_API_VERSION}/act_${cleanId}/campaigns?fields=id,name,effective_status&limit=200&access_token=${encodeURIComponent(account.access_token)}`;
  while (url) {
    const j = await fbGet(url);
    (j.data || []).forEach(c => { campaigns[c.id] = { name: c.name, status: c.effective_status }; });
    url = (j.paging && j.paging.next) ? j.paging.next : null;
  }
  // Групи
  url = `https://graph.facebook.com/${FB_API_VERSION}/act_${cleanId}/adsets?fields=id,name,effective_status,campaign_id&limit=500&access_token=${encodeURIComponent(account.access_token)}`;
  while (url) {
    const j = await fbGet(url);
    (j.data || []).forEach(a => { adsets[a.id] = { name: a.name, status: a.effective_status, campaign_id: a.campaign_id }; });
    url = (j.paging && j.paging.next) ? j.paging.next : null;
  }
  return { campaigns, adsets };
}

// ROI по артикулах за вікно (виручка/COGS/повернення/реклама → roi)
async function articleRoiMap(dateFrom, dateTo) {
  const lead = `COALESCE(o.original_created_at, o.created_at)`;
  const sp = [], sc = [`o.status='Продажа'`];
  if (dateFrom) { sp.push(dateFrom); sc.push(`${lead} >= $${sp.length}::date`); }
  if (dateTo)   { sp.push(dateTo);   sc.push(`${lead} < ($${sp.length}::date + interval '1 day')`); }
  const sales = await pool.query(`
    SELECT oi.article,
           COALESCE(SUM(oi.price*oi.quantity),0)::numeric revenue,
           COALESCE(SUM(COALESCE((SELECT MAX(cost) FROM products p WHERE p.article=oi.article),0)*oi.quantity),0)::numeric cost
    FROM orders o JOIN order_items oi ON oi.order_id=o.id
    WHERE ${sc.join(' AND ')} AND oi.article IS NOT NULL AND oi.article <> ''
    GROUP BY oi.article`, sp);
  const rp = [], rc = [`o.status IN ('Отказ','Возврат')`];
  if (dateFrom) { rp.push(dateFrom); rc.push(`${lead} >= $${rp.length}::date`); }
  if (dateTo)   { rp.push(dateTo);   rc.push(`${lead} < ($${rp.length}::date + interval '1 day')`); }
  const refs = await pool.query(`
    SELECT oi.article, COUNT(DISTINCT o.id)::int refused
    FROM orders o JOIN order_items oi ON oi.order_id=o.id
    WHERE ${rc.join(' AND ')} AND oi.article IS NOT NULL AND oi.article <> ''
    GROUP BY oi.article`, rp);
  const returnCost = Number((await getEconomicsSettings()).return_cost) || 0;
  const map = {};
  sales.rows.forEach(r => { map[r.article] = { revenue: +r.revenue, cost: +r.cost, refused: 0, spend: 0 }; });
  refs.rows.forEach(r => { (map[r.article] = map[r.article] || { revenue:0, cost:0, refused:0, spend:0 }).refused = r.refused; });
  return { map, returnCost };
}

// Пороги CPL по артикулах (беззбитковий і рекомендований) — щоб фарбувати кампанії
async function articleCplMap(dateFrom, dateTo) {
  const settings = await getEconomicsSettings();
  const returnCost = Number(settings.return_cost) || 0;
  const defTargetRoi = Number(settings.target_roi_pct) || 30;
  const lead = `COALESCE(o.original_created_at, o.created_at)`;
  const APPROVED = `('В работе','Доставка','В пути','На почте','Продажа','Отказ','Возврат','Ошибка в ТТН','Переадресация')`;
  const p = [], c = [`o.status <> '✗✗✗'`, `oi.article IS NOT NULL`, `oi.article <> ''`];
  if (dateFrom) { p.push(dateFrom); c.push(`${lead} >= $${p.length}::date`); }
  if (dateTo)   { p.push(dateTo);   c.push(`${lead} < ($${p.length}::date + interval '1 day')`); }
  const r = await pool.query(`
    WITH leads AS (SELECT DISTINCT o.id, o.status, oi.article FROM orders o JOIN order_items oi ON oi.order_id=o.id WHERE ${c.join(' AND ')})
    SELECT l.article,
           COUNT(*)::int total_leads,
           COUNT(*) FILTER (WHERE status IN ${APPROVED})::int approved,
           COUNT(*) FILTER (WHERE status IN ('Продажа'))::int sold,
           COUNT(*) FILTER (WHERE status IN ('Отказ','Возврат'))::int refused_after,
           MAX(pr.price)::numeric price, MAX(pr.cost)::numeric cost, MAX(pr.target_roi_pct) target_roi
    FROM leads l LEFT JOIN products pr ON pr.article = l.article
    GROUP BY l.article`, p);
  const newApproval = Math.max(0, Math.min(100, Number(settings.new_approval_pct))) / 100 || 0.7;
  const newBuyout = Math.max(0, Math.min(100, Number(settings.new_buyout_pct))) / 100 || 0.6;
  const { smsCost, courierCost, overheadPerSale } = await overheadContext(dateFrom, dateTo);
  const map = {};
  for (const row of r.rows) {
    const price = Number(row.price) || 0, cost = Number(row.cost) || 0;
    if (!price) { map[row.article] = null; continue; }
    const targetRoi = (row.target_roi != null ? Number(row.target_roi) : defTargetRoi) / 100;
    const resolved = row.sold + row.refused_after;
    // Надійна історія — коли є ≥5 резолюцій. Інакше — орієнтир по припущених апрув/викуп.
    const reliable = resolved >= 5 && row.approved > 0;
    let approvalRate, buyoutRate, refusalRate, provisional;
    if (reliable) {
      approvalRate = row.total_leads ? row.approved / row.total_leads : 0;
      buyoutRate = row.sold / resolved;
      refusalRate = row.refused_after / resolved;
      provisional = false;
    } else {
      approvalRate = newApproval;
      buyoutRate = newBuyout;
      refusalRate = 1 - newBuyout;
      provisional = true;
    }
    const approved100 = 100 * approvalRate;
    const sold100 = 100 * approvalRate * buyoutRate, refused100 = 100 * approvalRate * refusalRate;
    // Валовий на 100 лідів = продажі×(ціна−собів.) − відмови×відмова − підтв.×SMS − відправлені×кур'єр − продажі×накладні
    const cplMax = (sold100 * price - sold100 * cost - refused100 * returnCost - approved100 * smsCost - (sold100 + refused100) * courierCost - sold100 * overheadPerSale) / 100;
    map[row.article] = { cpl_max: cplMax, cpl_recommended: cplMax / (1 + targetRoi), provisional, has_history: reliable };
  }
  return map;
}

// Дані для панелі: артикул → кампанії → групи, з метриками і статусами
app.get('/api/fb/control', checkAuth, async (req, res) => {
  const { dateFrom, dateTo } = req.query;
  const _s = await getEconomicsSettings();
  const rateFor = (cur) => (String(cur || '').toUpperCase() === 'USD') ? (Number(_s.fx_usd) || 41)
                        : (String(cur || '').toUpperCase() === 'EUR') ? (Number(_s.fx_eur) || 45) : 1;
  try {
    const sp = [], conds = [];
    if (dateFrom) { sp.push(dateFrom); conds.push(`date >= $${sp.length}::date`); }
    if (dateTo)   { sp.push(dateTo);   conds.push(`date <= $${sp.length}::date`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const agg = await pool.query(`
      SELECT ad_account_id, campaign_id, MAX(campaign_name) campaign_name,
             adset_id, MAX(adset_name) adset_name, MAX(article) article,
             SUM(spend)::numeric spend, SUM(${fxSpendSql(_s)})::numeric spend_uah, SUM(leads)::int leads,
             SUM(impressions)::bigint impressions, SUM(clicks)::bigint clicks,
             MAX(currency) currency, MAX(fx_rate)::numeric fx_rate
      FROM fb_spend_daily ${where}
      GROUP BY ad_account_id, campaign_id, adset_id
      ORDER BY article NULLS LAST, campaign_id, spend DESC`, sp);

    // Живі статуси по кабінетах
    const accIds = [...new Set(agg.rows.map(r => r.ad_account_id))];
    const accs = accIds.length ? (await pool.query(`SELECT id, name, fb_account_id, access_token FROM fb_ad_accounts WHERE id = ANY($1)`, [accIds])).rows : [];
    const accName = {};
    accs.forEach(a => { accName[a.id] = a.name; });
    const statusByAcc = {};
    for (const a of accs) {
      try { statusByAcc[a.id] = await fbLiveStatuses(a); }
      catch (e) { statusByAcc[a.id] = { campaigns: {}, adsets: {}, error: e.message }; }
    }
    const { map: roiMap, returnCost } = await articleRoiMap(dateFrom, dateTo);
    const cplMap = await articleCplMap(dateFrom, dateTo);

    // Будуємо ієрархію article → campaign → adset.
    // spend показуємо в РОДНІЙ валюті кабінету; для ROI рахуємо грн (spend*fx).
    const arts = {};
    for (const r of agg.rows) {
      const artKey = r.article || '— без артикула';
      const A = arts[artKey] = arts[artKey] || { article: artKey, spend: 0, spendUah: 0, leads: 0, currencies: new Set(), fx: 1, campaigns: {} };
      const cst = (statusByAcc[r.ad_account_id] || {});
      const cId = r.campaign_id;
      const C = A.campaigns[cId] = A.campaigns[cId] || {
        campaign_id: cId, campaign_name: r.campaign_name, ad_account_id: r.ad_account_id,
        ad_account_name: accName[r.ad_account_id] || ('#' + r.ad_account_id),
        status: (cst.campaigns && cst.campaigns[cId] && cst.campaigns[cId].status) || 'UNKNOWN',
        spend: 0, leads: 0, adsets: []
      };
      const sp2 = Number(r.spend) || 0, ld = Number(r.leads) || 0;
      const imp = Number(r.impressions) || 0, clk = Number(r.clicks) || 0;
      const fx = rateFor(r.currency); // поточний курс за валютою кабінету
      A.currencies.add((r.currency || 'UAH').toUpperCase()); A.fx = fx;
      C.adsets.push({
        adset_id: r.adset_id, adset_name: r.adset_name, ad_account_id: r.ad_account_id,
        status: (cst.adsets && cst.adsets[r.adset_id] && cst.adsets[r.adset_id].status) || 'UNKNOWN',
        spend: sp2, leads: ld, impressions: imp, clicks: clk,
        cpl: ld ? sp2 / ld : 0, ctr: imp ? clk / imp * 100 : 0
      });
      C.spend += sp2; C.leads += ld;
      A.spend += sp2; A.spendUah += Number(r.spend_uah) || 0; A.leads += ld;
    }

    const out = Object.values(arts).map(A => {
      const mixed = A.currencies.size > 1;
      const currency = mixed ? 'UAH' : ([...A.currencies][0] || 'UAH');
      const fx = mixed ? 1 : A.fx;               // курс валюти кабінету → грн
      const conv = mixed ? A.fx : 1;             // якщо змішано — показуємо в грн (native*fx)
      // spend/CPL для показу: рідна валюта (або грн якщо змішано)
      const dispSpend = mixed ? A.spendUah : A.spend;
      const ro = roiMap[A.article];
      let roi = null, revenue = 0, netHint = 0;
      if (ro) {
        revenue = ro.revenue; // грн
        const net = ro.revenue - ro.cost - A.spendUah - ro.refused * returnCost; // усе в грн
        roi = A.spendUah ? net / A.spendUah * 100 : null;
        netHint = net;
      }
      const econ = cplMap[A.article] || null;
      // пороги в грн → у валюту показу (ділимо на курс)
      const toDisp = v => (v == null ? null : (mixed ? v : v / (fx || 1)));
      return {
        article: A.article, currency,
        spend: dispSpend, leads: A.leads,
        cpl: A.leads ? dispSpend / A.leads : 0,
        revenue, roi, net: netHint,
        cpl_max: toDisp(econ ? econ.cpl_max : null),
        cpl_recommended: toDisp(econ ? econ.cpl_recommended : null),
        cpl_provisional: econ ? !!econ.provisional : false,
        campaigns: Object.values(A.campaigns).map(C => {
          const cSpend = mixed ? C.spend * conv : C.spend;
          return {
            ...C, spend: cSpend, cpl: C.leads ? cSpend / C.leads : 0,
            adsets: C.adsets.map(G => {
              const gSpend = mixed ? G.spend * conv : G.spend;
              return { ...G, spend: gSpend, cpl: G.leads ? gSpend / G.leads : 0 };
            })
          };
        })
      };
    }).sort((a, b) => (b.spend * (b.currency === 'UAH' ? 1 : 100)) - (a.spend * (a.currency === 'UAH' ? 1 : 100)));

    res.json({ articles: out, errors: Object.entries(statusByAcc).filter(([,v]) => v.error).map(([id,v]) => ({ account_id: +id, error: v.error })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Пауза/увімкнення кампанії або групи (потрібен токен ads_management)
app.post('/api/fb/entity/:level(campaign|adset)/:id/status', checkAuth, async (req, res) => {
  const { level, id } = req.params;
  const status = req.body && req.body.status;
  const accountId = req.body && req.body.account_id;
  if (!['ACTIVE', 'PAUSED'].includes(status)) return res.status(400).json({ error: 'status має бути ACTIVE або PAUSED' });
  try {
    const accRes = await pool.query(`SELECT access_token FROM fb_ad_accounts WHERE id = $1`, [accountId]);
    if (!accRes.rows.length) return res.status(404).json({ error: 'Кабінет не знайдено' });
    const token = accRes.rows[0].access_token;
    const resp = await fetch(`https://graph.facebook.com/${FB_API_VERSION}/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, access_token: token })
    });
    const j = await resp.json();
    if (!resp.ok || j.error) {
      const m = (j.error && j.error.message) || ('HTTP ' + resp.status);
      const hint = /permission|ads_management|(#200)/i.test(m) ? ' (потрібен токен з правом ads_management)' : '';
      return res.status(400).json({ error: m + hint });
    }
    res.json({ success: true, level, id, status });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ===================== ЗАПУСК РЕКЛАМИ З CRM (FB Marketing API) =====================
// Схема 1-N-1: 1 кампанія → N груп (по креативу) → 1 оголошення в групі.
// Все створюється зі статусом PAUSED — у Ads Manager перевіряєш і вмикаєш.
// Файли креативів тимчасово лежать у uploads/ (Railway: диск ефемерний — цього досить, бо запуск триває хвилини).
const UPLOAD_DIR = path.join(__dirname, 'uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {}

const FB_CTA_TYPES = ['SHOP_NOW', 'ORDER_NOW', 'BUY_NOW', 'LEARN_MORE', 'GET_OFFER', 'SIGN_UP', 'CONTACT_US', 'MESSAGE_PAGE'];

const AD_LAUNCH_DEFAULTS = {
  daily_budget: 8,          // $ на групу на день
  genders: [2],             // 1 = чоловіки, 2 = жінки, [] = всі
  age_min: 18,
  age_max: 65,
  countries: ['UA'],
  cta: 'SHOP_NOW',
  message: '',
  title: '',
  description: '',
  campaign_name_tpl: '[{article}] {name} {date}',
  adset_name_tpl: '{creative}'
};

async function getAdLaunchDefaults() {
  const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'fb_launch_defaults'`);
  return { ...AD_LAUNCH_DEFAULTS, ...(r.rows.length ? r.rows[0].value : {}) };
}

app.get('/api/fb/launch/defaults', checkAuth, async (req, res) => {
  try { res.json({ defaults: await getAdLaunchDefaults(), cta_types: FB_CTA_TYPES }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fb/launch/defaults', checkAuth, async (req, res) => {
  try {
    const cur = await getAdLaunchDefaults();
    const b = req.body || {};
    const next = { ...cur };
    for (const k of Object.keys(AD_LAUNCH_DEFAULTS)) if (b[k] !== undefined) next[k] = b[k];
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('fb_launch_defaults', $1)
                      ON CONFLICT (key) DO UPDATE SET value = $1`, [next]);
    res.json({ success: true, defaults: next });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Налаштування кабінету для запуску: сторінка / Instagram / піксель ---
app.get('/api/fb/launch/accounts', checkAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT id, name, fb_account_id, currency, is_active, page_id, instagram_id, pixel_id, page_name
                                FROM fb_ad_accounts WHERE is_active = true ORDER BY id`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/fb/launch/accounts/:id(\\d+)', checkAuth, async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = [];
  for (const k of ['page_id', 'instagram_id', 'pixel_id', 'page_name']) {
    if (b[k] !== undefined) { vals.push(String(b[k] || '').trim()); sets.push(`${k}=$${vals.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: 'Нічого оновлювати' });
  vals.push(req.params.id);
  try { await pool.query(`UPDATE fb_ad_accounts SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Автовизначення: піксель з adspixels, сторінка/Instagram — з останніх оголошень кабінету
app.post('/api/fb/launch/accounts/:id(\\d+)/detect', checkAuth, async (req, res) => {
  try {
    const acc = (await pool.query(`SELECT * FROM fb_ad_accounts WHERE id=$1`, [req.params.id])).rows[0];
    if (!acc) return res.status(404).json({ error: 'Кабінет не знайдено' });
    const tok = encodeURIComponent(acc.access_token);
    const base = `https://graph.facebook.com/${FB_API_VERSION}`;
    const found = { page_id: '', instagram_id: '', pixel_id: '', page_name: '', pixels: [], pages: [] };
    try {
      const px = await fbGet(`${base}/act_${acc.fb_account_id}/adspixels?fields=id,name,last_fired_time&access_token=${tok}`);
      found.pixels = px.data || [];
      if (found.pixels.length) found.pixel_id = found.pixels[0].id;
    } catch (e) {}
    try {
      const ads = await fbGet(`${base}/act_${acc.fb_account_id}/ads?fields=creative{object_story_spec}&limit=25&access_token=${tok}`);
      const seen = {};
      for (const a of (ads.data || [])) {
        const s = a.creative && a.creative.object_story_spec;
        if (s && s.page_id && !seen[s.page_id]) { seen[s.page_id] = true; found.pages.push({ id: s.page_id, instagram_id: s.instagram_user_id || '' }); }
      }
      if (found.pages.length) { found.page_id = found.pages[0].id; found.instagram_id = found.pages[0].instagram_id; }
    } catch (e) {}
    // Назва сторінки (може не дати без pages_* прав — тоді лишаємо id)
    if (found.page_id) {
      try { const pg = await fbGet(`${base}/${found.page_id}?fields=name&access_token=${tok}`); found.page_name = pg.name || ''; } catch (e) {}
    }
    const sets = [], vals = [];
    for (const k of ['page_id', 'instagram_id', 'pixel_id', 'page_name']) {
      if (found[k]) { vals.push(found[k]); sets.push(`${k}=$${vals.length}`); }
    }
    if (sets.length) { vals.push(acc.id); await pool.query(`UPDATE fb_ad_accounts SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals); }
    res.json({ success: true, ...found });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// --- Завантаження креативів (тимчасово на диск) ---
// Файл іде сирим тілом; ім'я — у заголовку x-filename (URL-encoded)
app.post('/api/fb/launch/upload', checkAuth, express.raw({ type: () => true, limit: '300mb' }), async (req, res) => {
  try {
    const name = decodeURIComponent(req.headers['x-filename'] || 'file');
    const buf = req.body;
    if (!buf || !buf.length) return res.status(400).json({ error: 'Порожній файл' });
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
    const isVideo = ['mp4', 'mov', 'm4v', 'webm'].includes(ext);
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
    if (!isVideo && !isImage) return res.status(400).json({ error: 'Підтримуються jpg/png/gif/webp і mp4/mov' });
    const id = crypto.randomBytes(12).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, id), buf);
    res.json({ id, name, size: buf.length, kind: isVideo ? 'video' : 'image' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/fb/launch/upload/:id', checkAuth, (req, res) => {
  const id = String(req.params.id).replace(/[^a-z0-9.]/gi, '');
  try { fs.unlinkSync(path.join(UPLOAD_DIR, id)); } catch (e) {}
  res.json({ success: true });
});

// --- FB helpers для створення ---
async function fbPost(url, body) {
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await resp.json();
  if (!resp.ok || j.error) {
    const e = j.error || {};
    throw new Error((e.error_user_msg || e.message || ('HTTP ' + resp.status)) + (e.error_subcode ? ` [${e.code}/${e.error_subcode}]` : ''));
  }
  return j;
}

async function fbUploadImage(acc, filePath, filename) {
  const bytes = fs.readFileSync(filePath).toString('base64');
  const j = await fbPost(`https://graph.facebook.com/${FB_API_VERSION}/act_${acc.fb_account_id}/adimages`,
    { bytes, name: filename, access_token: acc.access_token });
  const img = j.images && Object.values(j.images)[0];
  if (!img || !img.hash) throw new Error('FB не повернув hash зображення');
  return { image_hash: img.hash, image_url: img.url };
}

async function fbUploadVideo(acc, filePath, filename) {
  const fd = new FormData();
  fd.append('access_token', acc.access_token);
  fd.append('name', filename);
  fd.append('source', new Blob([fs.readFileSync(filePath)]), filename);
  const resp = await fetch(`https://graph.facebook.com/${FB_API_VERSION}/act_${acc.fb_account_id}/advideos`, { method: 'POST', body: fd });
  const j = await resp.json();
  if (!resp.ok || j.error) throw new Error((j.error && (j.error.error_user_msg || j.error.message)) || ('HTTP ' + resp.status));
  if (!j.id) throw new Error('FB не повернув id відео');
  return j.id;
}

// Чекаємо поки FB обробить відео і віддасть прев'ю (потрібне для креативу)
async function fbWaitVideoReady(acc, videoId, log, maxMs = 6 * 60 * 1000) {
  const started = Date.now();
  const tok = encodeURIComponent(acc.access_token);
  while (Date.now() - started < maxMs) {
    const v = await fbGet(`https://graph.facebook.com/${FB_API_VERSION}/${videoId}?fields=status,thumbnails{uri,is_preferred}&access_token=${tok}`);
    const st = v.status && v.status.video_status;
    const thumbs = (v.thumbnails && v.thumbnails.data) || [];
    if (st === 'error') throw new Error('FB: помилка обробки відео');
    if (st === 'ready' && thumbs.length) {
      const t = thumbs.find(x => x.is_preferred) || thumbs[0];
      return t.uri;
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Відео обробляється надто довго — спробуй запустити пізніше');
}

function fillTpl(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}

// --- Головне: створити кампанію в кабінеті ---
async function runAdLaunch(launchId) {
  const L = (await pool.query(`SELECT * FROM fb_launches WHERE id=$1`, [launchId])).rows[0];
  if (!L) return;
  const acc = (await pool.query(`SELECT * FROM fb_ad_accounts WHERE id=$1`, [L.ad_account_id])).rows[0];
  const cfg = L.config || {};
  const creatives = L.creatives || [];
  const log = [];
  const ids = { campaign_id: '', adsets: [] };
  const say = async (msg, level = 'info') => {
    log.push({ t: new Date().toISOString(), level, msg });
    await pool.query(`UPDATE fb_launches SET log=$1, fb_ids=$2 WHERE id=$3`, [JSON.stringify(log), JSON.stringify(ids), launchId]);
  };
  const base = `https://graph.facebook.com/${FB_API_VERSION}`;
  const actUrl = `${base}/act_${acc.fb_account_id}`;

  await pool.query(`UPDATE fb_launches SET status='running', started_at=now() WHERE id=$1`, [launchId]);
  try {
    if (!acc) throw new Error('Кабінет не знайдено');
    if (!acc.page_id) throw new Error('У кабінету не вказано сторінку FB (page_id) — заповни в налаштуваннях запуску');
    if (!acc.pixel_id) throw new Error('У кабінету не вказано піксель — заповни в налаштуваннях запуску');
    if (!creatives.length) throw new Error('Немає креативів');
    if (!cfg.link) throw new Error('Не вказано посилання на лендінг');

    // 1. Креативи → FB
    await say(`Завантажую ${creatives.length} креатив(ів) у act_${acc.fb_account_id}…`);
    for (const c of creatives) {
      const fp = path.join(UPLOAD_DIR, String(c.file_id).replace(/[^a-z0-9.]/gi, ''));
      if (!fs.existsSync(fp)) throw new Error(`Файл ${c.name} не знайдено на сервері (перезавантаж креативи)`);
      if (c.kind === 'video') {
        c.video_id = await fbUploadVideo(acc, fp, c.name);
        await say(`Відео «${c.name}» → ${c.video_id}, чекаю обробку…`);
        c.image_url = await fbWaitVideoReady(acc, c.video_id, say);
        await say(`Відео «${c.name}» готове`);
      } else {
        const r = await fbUploadImage(acc, fp, c.name);
        c.image_hash = r.image_hash; c.image_url = r.image_url;
        await say(`Зображення «${c.name}» → ${c.image_hash}`);
      }
    }

    // 2. Кампанія (бюджет на рівні груп, тому без daily_budget тут)
    const camp = await fbPost(`${actUrl}/campaigns`, {
      name: cfg.campaign_name,
      objective: 'OUTCOME_LEADS',
      buying_type: 'AUCTION',
      status: 'PAUSED',
      special_ad_categories: [],
      access_token: acc.access_token
    });
    ids.campaign_id = camp.id;
    await say(`Кампанія «${cfg.campaign_name}» → ${camp.id}`);

    // 3. Групи + оголошення
    const budgetMinor = Math.round(Number(cfg.daily_budget) * 100); // USD → центи
    const genders = Array.isArray(cfg.genders) ? cfg.genders.map(Number).filter(Boolean) : [];
    const targeting = {
      geo_locations: { countries: cfg.countries && cfg.countries.length ? cfg.countries : ['UA'], location_types: ['home', 'recent'] },
      age_min: Number(cfg.age_min) || 18,
      age_max: Number(cfg.age_max) || 65,
      targeting_automation: { advantage_audience: 1, individual_setting: { age: 1, gender: genders.length ? 1 : 0 } }
    };
    if (genders.length) targeting.genders = genders;

    for (let i = 0; i < creatives.length; i++) {
      const c = creatives[i];
      const adsetName = c.adset_name || c.name;
      const adset = await fbPost(`${actUrl}/adsets`, {
        name: adsetName,
        campaign_id: ids.campaign_id,
        daily_budget: budgetMinor,
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'OFFSITE_CONVERSIONS',
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        promoted_object: { pixel_id: acc.pixel_id, custom_event_type: 'LEAD' },
        targeting,
        start_time: new Date().toISOString(),
        status: 'PAUSED',
        access_token: acc.access_token
      });
      await say(`Група «${adsetName}» → ${adset.id}`);

      const cta = { type: cfg.cta || 'SHOP_NOW', value: { link: cfg.link } };
      const spec = { page_id: acc.page_id };
      if (acc.instagram_id) spec.instagram_user_id = acc.instagram_id;
      if (c.kind === 'video') {
        spec.video_data = { video_id: c.video_id, image_url: c.image_url, message: cfg.message || '', title: cfg.title || '', link_description: cfg.description || '', call_to_action: cta };
      } else {
        spec.link_data = { image_hash: c.image_hash, link: cfg.link, message: cfg.message || '', name: cfg.title || '', description: cfg.description || '', call_to_action: cta };
      }
      const creative = await fbPost(`${actUrl}/adcreatives`, { name: `${adsetName} — creative`, object_story_spec: spec, access_token: acc.access_token });
      const ad = await fbPost(`${actUrl}/ads`, { name: adsetName, adset_id: adset.id, creative: { creative_id: creative.id }, status: 'PAUSED', access_token: acc.access_token });
      ids.adsets.push({ adset_id: adset.id, creative_id: creative.id, ad_id: ad.id, name: adsetName });
      await say(`Оголошення «${adsetName}» → ${ad.id}`);
    }

    await say(`Готово: кампанія ${ids.campaign_id}, ${ids.adsets.length} груп. Статус PAUSED — увімкни в Ads Manager.`, 'ok');
    await pool.query(`UPDATE fb_launches SET status='done', finished_at=now(), fb_campaign_id=$2, creatives=$3 WHERE id=$1`,
      [launchId, ids.campaign_id, JSON.stringify(creatives)]);
  } catch (e) {
    await say('ПОМИЛКА: ' + e.message, 'error');
    // Прибираємо недороблену кампанію, щоб не лишати сміття в кабінеті
    if (ids.campaign_id) {
      try {
        await fetch(`${base}/${ids.campaign_id}?access_token=${encodeURIComponent(acc.access_token)}`, { method: 'DELETE' });
        await say(`Недороблену кампанію ${ids.campaign_id} видалено`, 'warn');
      } catch (e2) { await say(`Не вдалося видалити кампанію ${ids.campaign_id}: ${e2.message} — видали вручну`, 'warn'); }
    }
    await pool.query(`UPDATE fb_launches SET status='error', finished_at=now(), error=$2 WHERE id=$1`, [launchId, e.message]);
  }
}

// Запуск: по одному fb_launches на кожен кабінет, виконуються послідовно у фоні
app.post('/api/fb/launch', checkAuth, async (req, res) => {
  const b = req.body || {};
  const accountIds = (Array.isArray(b.account_ids) ? b.account_ids : []).map(Number).filter(Boolean);
  const creatives = (Array.isArray(b.creatives) ? b.creatives : []).filter(c => c && c.file_id);
  if (!accountIds.length) return res.status(400).json({ error: 'Обери хоча б один кабінет' });
  if (!creatives.length) return res.status(400).json({ error: 'Додай хоча б один креатив' });
  if (!b.link) return res.status(400).json({ error: 'Вкажи посилання на лендінг' });
  if (!(Number(b.daily_budget) > 0)) return res.status(400).json({ error: 'Вкажи денний бюджет' });
  if (!FB_CTA_TYPES.includes(b.cta || 'SHOP_NOW')) return res.status(400).json({ error: 'Невірний CTA' });

  const d = await getAdLaunchDefaults();
  const article = String(b.article || '').trim();
  const product = article ? (await pool.query(`SELECT name FROM products WHERE article=$1 LIMIT 1`, [article])).rows[0] : null;
  const dateStr = new Date().toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
  const vars = { article, name: product ? product.name : '', date: dateStr };
  const campaignName = fillTpl(b.campaign_name || d.campaign_name_tpl, vars).replace(/\s+/g, ' ').trim();
  const cfg = {
    campaign_name: campaignName,
    link: String(b.link).trim(),
    daily_budget: Number(b.daily_budget),
    genders: Array.isArray(b.genders) ? b.genders : d.genders,
    age_min: Number(b.age_min) || d.age_min,
    age_max: Number(b.age_max) || d.age_max,
    countries: Array.isArray(b.countries) && b.countries.length ? b.countries : d.countries,
    cta: b.cta || d.cta,
    message: String(b.message || ''),
    title: String(b.title || ''),
    description: String(b.description || '')
  };
  const crs = creatives.map((c, i) => ({
    file_id: String(c.file_id), name: String(c.name || `creative ${i + 1}`), kind: c.kind === 'video' ? 'video' : 'image',
    adset_name: fillTpl(b.adset_name_tpl || d.adset_name_tpl, { ...vars, creative: String(c.name || '').replace(/\.[a-z0-9]+$/i, ''), n: i + 1 }).trim() || `creative ${i + 1}`
  }));

  try {
    const ids = [];
    for (const accId of accountIds) {
      const r = await pool.query(
        `INSERT INTO fb_launches (ad_account_id, article, config, creatives, status) VALUES ($1,$2,$3,$4,'pending') RETURNING id`,
        [accId, article, JSON.stringify(cfg), JSON.stringify(crs)]);
      ids.push(r.rows[0].id);
    }
    // У фоні, послідовно (не навантажуємо FB паралельно)
    (async () => {
      for (const id of ids) { try { await runAdLaunch(id); } catch (e) { console.error('[ad launch]', id, e.message); } }
      // Файли більше не потрібні
      for (const c of crs) { try { fs.unlinkSync(path.join(UPLOAD_DIR, c.file_id)); } catch (e) {} }
    })();
    res.json({ success: true, launch_ids: ids });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fb/launches', checkAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT l.id, l.ad_account_id, a.name AS account_name, a.fb_account_id, l.article, l.status, l.error,
             l.config->>'campaign_name' AS campaign_name, l.fb_campaign_id, l.fb_ids, l.log,
             jsonb_array_length(l.creatives) AS creatives_count, l.created_at, l.finished_at
      FROM fb_launches l LEFT JOIN fb_ad_accounts a ON a.id = l.ad_account_id
      ORDER BY l.id DESC LIMIT 100`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fb/launches/:id(\\d+)', checkAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT l.*, a.name AS account_name, a.fb_account_id FROM fb_launches l LEFT JOIN fb_ad_accounts a ON a.id=l.ad_account_id WHERE l.id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Не знайдено' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== АВТОПРАВИЛА РЕКЛАМИ =====

// Пауза сутності у FB (повертає {ok, error})
async function fbPauseEntity(entityId, adAccountId, status) {
  const acc = (await pool.query(`SELECT access_token FROM fb_ad_accounts WHERE id=$1`, [adAccountId])).rows[0];
  if (!acc) return { ok: false, error: 'Кабінет не знайдено' };
  try {
    const resp = await fetch(`https://graph.facebook.com/${FB_API_VERSION}/${entityId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, access_token: acc.access_token })
    });
    const j = await resp.json();
    if (!resp.ok || j.error) return { ok: false, error: (j.error && j.error.message) || ('HTTP ' + resp.status) };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Продажі по артикулах за вікно (для правил spend_no_sales / roi)
async function articleSalesWindow(df, dt) {
  const lead = `COALESCE(o.original_created_at, o.created_at)`;
  const p = [], c = [`o.status='Продажа'`];
  if (df) { p.push(df); c.push(`${lead} >= $${p.length}::date`); }
  if (dt) { p.push(dt); c.push(`${lead} < ($${p.length}::date + interval '1 day')`); }
  const r = await pool.query(`
    SELECT oi.article,
           COUNT(DISTINCT o.id)::int sold,
           COALESCE(SUM(oi.price*oi.quantity),0)::numeric revenue,
           COALESCE(SUM(COALESCE((SELECT MAX(cost) FROM products p WHERE p.article=oi.article),0)*oi.quantity),0)::numeric cost
    FROM orders o JOIN order_items oi ON oi.order_id=o.id
    WHERE ${c.join(' AND ')} AND oi.article IS NOT NULL AND oi.article <> ''
    GROUP BY oi.article`, p);
  const map = {};
  r.rows.forEach(x => { map[x.article] = { sold: x.sold, revenue: +x.revenue, cost: +x.cost }; });
  return map;
}

async function logRuleAction(o) {
  await pool.query(`
    INSERT INTO fb_rule_log (rule_id, rule_name, level, entity_id, entity_name, article, ad_account_id, metric_value, threshold, action, mode, result, message)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [o.rule_id, o.rule_name, o.level, o.entity_id, o.entity_name, o.article || '', o.ad_account_id || null,
     o.metric_value, o.threshold, o.action, o.mode, o.result, o.message || '']);
}

// Оцінка й застосування всіх активних правил
async function evaluateFbRules() {
  const gs = (await pool.query(`SELECT value FROM app_settings WHERE key='fb_rules_enabled'`)).rows[0];
  const globalOn = gs ? (gs.value === true || gs.value === 'true') : true;
  const settings = await getEconomicsSettings();
  const grnSpend = fxSpendSql(settings);
  const returnCost = Number(settings.return_cost) || 0;
  const rules = (await pool.query(`SELECT * FROM fb_rules WHERE is_active=true`)).rows;
  const out = [];

  for (const rule of rules) {
    const to = new Date(); const from = new Date(); from.setDate(from.getDate() - (rule.window_days || 7));
    const iso = d => d.toLocaleDateString('sv-SE');
    const df = iso(from), dt = iso(to);
    const cplMap = await articleCplMap(df, dt);
    const salesMap = await articleSalesWindow(df, dt);

    async function cooled(entityId) {
      const r = await pool.query(`SELECT 1 FROM fb_rule_log WHERE rule_id=$1 AND entity_id=$2 AND result IN ('would','done') AND created_at > now() - ($3 * interval '1 hour') LIMIT 1`,
        [rule.id, entityId, rule.cooldown_hours || 24]);
      return r.rows.length > 0;
    }
    async function act(level, entity_id, entity_name, article, ad_account_id, mv, thr, reason) {
      if (await cooled(entity_id)) return;
      const doLive = rule.mode === 'live' && globalOn;
      let result = 'would', message = reason;
      if (doLive) {
        const r = await fbPauseEntity(entity_id, ad_account_id, 'PAUSED');
        result = r.ok ? 'done' : 'error';
        if (!r.ok) message = reason + ' | FB: ' + r.error;
      }
      await logRuleAction({ rule_id: rule.id, rule_name: rule.name, level, entity_id, entity_name, article, ad_account_id, metric_value: mv, threshold: thr, action: 'pause', mode: rule.mode, result, message });
      out.push({ rule: rule.name, level, entity: entity_name, article, result, mv, thr, reason });
    }

    if (rule.scope === 'article') {
      // ROI по артикулу → пауза всіх кампаній артикула
      const spendRows = await pool.query(`
        SELECT article, campaign_id, MAX(campaign_name) campaign_name, MAX(ad_account_id) ad_account_id,
               SUM(${grnSpend})::numeric spend, SUM(leads)::int leads
        FROM fb_spend_daily WHERE date>=$1 AND date<=$2 AND article IS NOT NULL AND article <> ''
        GROUP BY article, campaign_id`, [df, dt]);
      const byArt = {};
      spendRows.rows.forEach(r => {
        const A = byArt[r.article] = byArt[r.article] || { spend: 0, campaigns: [] };
        A.spend += Number(r.spend) || 0;
        A.campaigns.push(r);
      });
      for (const [article, A] of Object.entries(byArt)) {
        const s = salesMap[article] || { sold: 0, revenue: 0, cost: 0 };
        if (A.spend < Number(rule.min_spend)) continue;
        const refCost = 0; // спрощено: повернення тут не рахуємо (беремо валовий − реклама)
        const net = s.revenue - s.cost - A.spend - refCost;
        const roi = A.spend ? net / A.spend * 100 : null;
        if (roi == null) continue;
        const thr = Number(rule.param) || 0;
        if (roi < thr) {
          for (const c of A.campaigns) {
            await act('campaign', c.campaign_id, c.campaign_name, article, c.ad_account_id, Math.round(roi * 10) / 10, thr,
              `ROI моделі ${Math.round(roi)}% < ${thr}% за ${rule.window_days} дн`);
          }
        }
      }
    } else {
      // adset | campaign: метрики по сутності
      const idCol = rule.scope === 'adset' ? 'adset_id' : 'campaign_id';
      const nameCol = rule.scope === 'adset' ? 'adset_name' : 'campaign_name';
      const rows = await pool.query(`
        SELECT ${idCol} entity_id, MAX(${nameCol}) entity_name, MAX(article) article, MAX(ad_account_id) ad_account_id,
               SUM(${grnSpend})::numeric spend, SUM(leads)::int leads
        FROM fb_spend_daily WHERE date>=$1 AND date<=$2
        GROUP BY ${idCol}`, [df, dt]);
      for (const e of rows.rows) {
        if (!e.entity_id) continue;
        const spend = Number(e.spend) || 0, leads = Number(e.leads) || 0;
        if (spend < Number(rule.min_spend)) continue;
        const econ = e.article ? cplMap[e.article] : null;
        if (!econ) continue; // без економіки моделі порогів нема
        if (rule.metric === 'cpl') {
          if (leads < (rule.min_leads || 5)) continue;
          const cpl = leads ? spend / leads : 0;
          const thr = econ.cpl_max * (Number(rule.param) || 1);
          if (cpl > thr) await act(rule.scope, e.entity_id, e.entity_name, e.article, e.ad_account_id, Math.round(cpl * 100) / 100, Math.round(thr * 100) / 100,
            `CPL ${Math.round(cpl)}₴ > поріг ${Math.round(thr)}₴ (×${rule.param} граничного)`);
        } else if (rule.metric === 'spend_no_sales') {
          const s = salesMap[e.article] || { sold: 0 };
          const thr = econ.cpl_max * (Number(rule.param) || 3);
          if (s.sold === 0 && spend >= thr) await act(rule.scope, e.entity_id, e.entity_name, e.article, e.ad_account_id, Math.round(spend), Math.round(thr),
            `Трата ${Math.round(spend)}₴ ≥ ${Math.round(thr)}₴ без жодного продажу`);
        }
      }
    }
    await pool.query(`UPDATE fb_rules SET last_run_at=now() WHERE id=$1`, [rule.id]);
  }
  return { globalOn, rulesRun: rules.length, actions: out };
}

// CRUD правил
app.get('/api/fb/rules', checkAuth, async (req, res) => {
  try {
    const gs = (await pool.query(`SELECT value FROM app_settings WHERE key='fb_rules_enabled'`)).rows[0];
    const globalOn = gs ? (gs.value === true || gs.value === 'true') : true;
    const rules = (await pool.query(`SELECT * FROM fb_rules ORDER BY is_active DESC, id`)).rows;
    res.json({ globalOn, rules });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fb/rules', checkAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Назва обовʼязкова' });
  try {
    const r = await pool.query(`
      INSERT INTO fb_rules (name, scope, metric, window_days, param, action, min_leads, min_spend, cooldown_hours, mode, is_active)
      VALUES ($1,$2,$3,$4,$5,'pause',$6,$7,$8,$9,$10) RETURNING id`,
      [b.name, b.scope || 'adset', b.metric || 'cpl', Number(b.window_days) || 7, Number(b.param) || 1,
       Number(b.min_leads) || 5, Number(b.min_spend) || 0, Number(b.cooldown_hours) || 24, b.mode === 'live' ? 'live' : 'dry', b.is_active !== false]);
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/fb/rules/:id(\\d+)', checkAuth, async (req, res) => {
  const allowed = ['name', 'scope', 'metric', 'window_days', 'param', 'min_leads', 'min_spend', 'cooldown_hours', 'mode', 'is_active'];
  const keys = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!keys.length) return res.status(400).json({ error: 'Нічого оновити' });
  const set = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const vals = keys.map(k => req.body[k]); vals.push(req.params.id);
  try { await pool.query(`UPDATE fb_rules SET ${set} WHERE id=$${vals.length}`, vals); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/fb/rules/:id(\\d+)', checkAuth, async (req, res) => {
  try { await pool.query(`DELETE FROM fb_rules WHERE id=$1`, [req.params.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Глобальний вимикач
app.post('/api/fb/rules/toggle', checkAuth, async (req, res) => {
  const on = !!(req.body && req.body.on);
  try {
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('fb_rules_enabled', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value=$1::jsonb`, [JSON.stringify(on)]);
    res.json({ success: true, globalOn: on });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ручний прогін
app.post('/api/fb/rules/run', checkAuth, async (req, res) => {
  try { res.json({ success: true, ...(await evaluateFbRules()) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Лог
app.get('/api/fb/rules/log', checkAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM fb_rule_log ORDER BY created_at DESC LIMIT 200`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cron: автоправила кожні 2 години (перший — через 3 хв після старту)
setTimeout(() => { evaluateFbRules().catch(e => console.error('[FB rules init]', e.message)); }, 3 * 60 * 1000);
setInterval(() => { evaluateFbRules().catch(e => console.error('[FB rules cron]', e.message)); }, 2 * 60 * 60 * 1000);

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
    const REFUSED_AFTER = `('Отказ','Возврат')`;
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
    // Змінні витрати (SMS на підтверджене + накладні на продаж) за вікно lookback
    const _to = new Date(); const _from = new Date(); _from.setDate(_from.getDate() - lookback);
    const iso = d => d.toLocaleDateString('sv-SE');
    const { smsCost, courierCost, overheadPerSale } = await overheadContext(iso(_from), iso(_to));
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
      const approved100 = 100 * approvalRate;
      const sold100 = 100 * approvalRate * buyoutRate;
      const refused100 = 100 * approvalRate * refusalRate;
      const grossProfit100 = sold100 * sellPrice - sold100 * productCost - refused100 * returnCost - approved100 * smsCost - (sold100 + refused100) * courierCost - sold100 * overheadPerSale;
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

    res.json({ rows, settings: { lookback_days: lookback, return_cost: returnCost, courier_cost: courierCost, default_target_roi_pct: defaultTargetRoi } });
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
    await syncReturnForOrderStatus(orderId, b.status || 'Новый');
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
      if (newStatus && RETURN_TRIGGER_STATUSES.includes(newStatus)) {
        try { await ensureReturnForOrder(row.id); } catch (e) {}
      }
      updated++;
    }
  }
  return { updated };
}

app.post('/api/np/refresh', checkAuth, async (req, res) => {
  try { res.json({ success: true, ...(await refreshNpStatuses()) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ===================== ПОВЕРНЕННЯ (відмови → назад до кур'єра) =====================
// Кожна відмова = рядок у returns. Життєвий цикл:
//   in_transit (їде назад) → at_branch (на відділенні НП у місті повернення)
//   → picked_up (кур'єр забрав з відділення = НП зафіксувала одержання) → received (я отримав від кур'єра, вручну)
//   → problem (загублено / пошкоджено / інше, вручну)
// НП веде до picked_up автоматично через зворотну ЕН; received/problem — тільки руками, НП їх не перетирає.
const RETURN_TRIGGER_STATUSES = ['Отказ', 'Возврат'];
const RETURN_RANK = { in_transit: 1, at_branch: 2, picked_up: 3, received: 4, problem: 4 };

// Гарантує рядок повернення для замовлення (ідемпотентно)
async function ensureReturnForOrder(orderId) {
  const o = await pool.query(`SELECT id, ttn, status FROM orders WHERE id = $1`, [orderId]);
  if (!o.rows.length) return null;
  const row = o.rows[0];
  if (!row.ttn) return null; // без ТТН нічого не їхало
  const r = await pool.query(
    `INSERT INTO returns (order_id, ttn) VALUES ($1, $2)
     ON CONFLICT (order_id) DO NOTHING RETURNING id`, [row.id, row.ttn]);
  return r.rows.length ? r.rows[0].id : null;
}

// Статус замовлення змінився → завести повернення або прибрати зайве.
// Якщо замовлення «повернули в гру» (Продажа/Доставка/В пути/На почте), а посилка ще не їхала
// назад (немає зворотної ЕН і не відмічено вручну) — рядок повернення зайвий, видаляємо.
async function syncReturnForOrderStatus(orderId, status) {
  try {
    if (RETURN_TRIGGER_STATUSES.includes(status)) { await ensureReturnForOrder(orderId); return; }
    if (['Продажа', 'Доставка', 'В пути', 'На почте'].includes(status)) {
      await pool.query(
        `DELETE FROM returns WHERE order_id = $1 AND status = 'in_transit'
           AND (return_ttn IS NULL OR return_ttn = '') AND arrived_at IS NULL AND picked_up_at IS NULL`,
        [orderId]);
    }
  } catch (e) { console.error('[returns sync status]', e.message); }
}

// Бекфіл: усі замовлення зі статусом відмови й ТТН, у яких ще немає повернення
async function backfillReturns() {
  const r = await pool.query(`
    INSERT INTO returns (order_id, ttn, refused_at)
    SELECT o.id, o.ttn, COALESCE(o.np_updated_at, o.created_at)
    FROM orders o
    WHERE o.status = ANY($1) AND o.ttn <> '' AND o.ttn IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM returns rt WHERE rt.order_id = o.id)
    RETURNING id`, [RETURN_TRIGGER_STATUSES]);
  return r.rowCount;
}

// Код статусу НП по зворотній ЕН → статус повернення
function npCodeToReturnStatus(code) {
  code = String(code || '');
  if (['7', '8', '12'].includes(code)) return 'at_branch';
  if (['9', '10', '11', '106'].includes(code)) return 'picked_up';
  if (['102', '103', '105'].includes(code)) return 'problem';
  if (['1', '2', '3', '4', '5', '6', '41', '101', '104', '111', '112'].includes(code)) return 'in_transit';
  return null;
}

// Витягуємо з відповіді НП дату (у НП формат 'DD.MM.YYYY HH:MI:SS' або 'YYYY-MM-DD HH:MI:SS')
function npDateToIso(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}`;
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return `${m[3]}-${m[2]}-${m[1]} ${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}`;
  return null;
}

// Синк повернень з НП: спершу дізнаємось зворотну ЕН по оригінальній ТТН, далі трекаємо її
async function syncReturns() {
  const created = await backfillReturns();
  const s = await getNpSettings();
  if (!s.apiKey) return { created, tracked: 0, skipped: 'no api key' };

  const q = await pool.query(
    `SELECT id, ttn, return_ttn, status, arrived_at, picked_up_at
     FROM returns WHERE status NOT IN ('received', 'problem')`);
  if (!q.rows.length) return { created, tracked: 0 };

  // Трекаємо зворотну ЕН якщо є, інакше оригінальну (щоб дізнатись номер зворотної)
  const docs = q.rows.map(r => ({ DocumentNumber: r.return_ttn || r.ttn, Phone: '' }));
  const byNumber = {};
  q.rows.forEach(r => { byNumber[r.return_ttn || r.ttn] = r; });

  let tracked = 0;
  for (let i = 0; i < docs.length; i += 100) {
    let data;
    try { data = await npCall('TrackingDocument', 'getStatusDocuments', { Documents: docs.slice(i, i + 100) }); }
    catch (e) { continue; }
    for (const st of data) {
      const row = byNumber[st.Number];
      if (!row) continue;
      const trackingReturnDoc = !!row.return_ttn;
      const sets = [], vals = [];
      const set = (k, v) => { vals.push(v); sets.push(`${k}=$${vals.length}`); };

      // Оригінальна ТТН: НП дає номер зворотної ЕН у LastCreatedOnTheBasisNumber
      if (!trackingReturnDoc) {
        const retNum = String(st.LastCreatedOnTheBasisNumber || '').trim();
        if (retNum && retNum !== row.ttn) set('return_ttn', retNum);
        // Місто повернення = місто відправника оригіналу (посилка їде назад туди)
        if (st.CitySender) set('return_city', String(st.CitySender));
        if (st.WarehouseSender) set('return_branch', String(st.WarehouseSender));
        // Поки зворотна ЕН невідома — по оригіналу лише фіксуємо факт; статуси 9-11 по оригіналу
        // означають "повернення одержано відправником" (коли НП не створює окрему ЕН)
        const code = String(st.StatusCode || '');
        if (['9', '10', '11', '106'].includes(code) && RETURN_RANK[row.status] < RETURN_RANK.picked_up) {
          set('status', 'picked_up');
          if (!row.picked_up_at) set('picked_up_at', npDateToIso(st.RecipientDateTime) || new Date());
        }
        set('np_status_code', code);
        set('np_status_text', String(st.Status || ''));
      } else {
        // Зворотна ЕН: одержувач = ми (місто/відділення повернення), її статус = де посилка
        if (st.CityRecipient) set('return_city', String(st.CityRecipient));
        if (st.WarehouseRecipient) set('return_branch', String(st.WarehouseRecipient));
        const cost = Number(st.DocumentCost) || 0;
        if (cost > 0) set('np_return_cost', cost);
        const code = String(st.StatusCode || '');
        set('np_status_code', code);
        set('np_status_text', String(st.Status || ''));
        const next = npCodeToReturnStatus(code);
        // Статус лише вперед; received/problem НП не чіпає
        if (next && next !== 'problem' && RETURN_RANK[next] > RETURN_RANK[row.status]) {
          set('status', next);
          if (next === 'at_branch' && !row.arrived_at) set('arrived_at', npDateToIso(st.RecipientDateTime) || new Date());
          if (next === 'picked_up') {
            if (!row.arrived_at) set('arrived_at', npDateToIso(st.ScheduledDeliveryDate) || new Date());
            if (!row.picked_up_at) set('picked_up_at', npDateToIso(st.RecipientDateTime) || new Date());
          }
        } else if (next === 'at_branch' && !row.arrived_at) {
          set('arrived_at', npDateToIso(st.RecipientDateTime) || new Date());
        }
      }
      sets.push('np_updated_at=now()');
      vals.push(row.id);
      await pool.query(`UPDATE returns SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
      tracked++;
    }
  }
  return { created, tracked };
}

const RETURNS_SELECT = `
  SELECT rt.*, o.status AS order_status, o.city AS order_city, o.price AS order_price,
         c.full_name AS customer_name, c.phone AS customer_phone,
         COALESCE((SELECT string_agg(trim(oi.article || ' ' || oi.size || ' ' || oi.color), ', ')
                   FROM order_items oi WHERE oi.order_id = o.id), '') AS items_text,
         COALESCE((SELECT string_agg(oi.article, ',') FROM order_items oi WHERE oi.order_id = o.id), '') AS articles
  FROM returns rt
  JOIN orders o ON o.id = rt.order_id
  LEFT JOIN customers c ON c.id = o.customer_id`;

// Список повернень з фільтрами
app.get('/api/returns', checkAuth, async (req, res) => {
  const { status, city, dateFrom, dateTo, q } = req.query;
  try {
    const p = [], c = [];
    if (status) { p.push(status); c.push(`rt.status = $${p.length}`); }
    if (city) { p.push(city); c.push(`rt.return_city = $${p.length}`); }
    if (dateFrom) { p.push(dateFrom); c.push(`rt.refused_at >= $${p.length}::date`); }
    if (dateTo) { p.push(dateTo); c.push(`rt.refused_at < ($${p.length}::date + interval '1 day')`); }
    if (q) {
      p.push('%' + String(q).trim() + '%');
      c.push(`(rt.ttn ILIKE $${p.length} OR rt.return_ttn ILIKE $${p.length} OR c.full_name ILIKE $${p.length} OR c.phone ILIKE $${p.length}
               OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.article ILIKE $${p.length}))`);
    }
    const where = c.length ? 'WHERE ' + c.join(' AND ') : '';
    const r = await pool.query(`${RETURNS_SELECT} ${where} ORDER BY rt.refused_at DESC, rt.id DESC`, p);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Зведення по містах: скільки де, і головне — "у кур'єра на руках" (забрав, а мені не віддав)
app.get('/api/returns/summary', checkAuth, async (req, res) => {
  const { dateFrom, dateTo } = req.query;
  try {
    const p = [], c = [];
    if (dateFrom) { p.push(dateFrom); c.push(`refused_at >= $${p.length}::date`); }
    if (dateTo) { p.push(dateTo); c.push(`refused_at < ($${p.length}::date + interval '1 day')`); }
    const where = c.length ? 'WHERE ' + c.join(' AND ') : '';
    const r = await pool.query(`
      SELECT COALESCE(NULLIF(return_city, ''), '— не визначено') AS city,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status = 'in_transit')::int AS in_transit,
             COUNT(*) FILTER (WHERE status = 'at_branch')::int AS at_branch,
             COUNT(*) FILTER (WHERE status = 'at_branch' AND arrived_at < now() - interval '5 days')::int AS at_branch_stale,
             COUNT(*) FILTER (WHERE status = 'picked_up')::int AS on_hands,
             COUNT(*) FILTER (WHERE status = 'received')::int AS received,
             COUNT(*) FILTER (WHERE status = 'problem')::int AS problem,
             COALESCE(SUM(np_return_cost), 0)::numeric AS np_return_cost
      FROM returns ${where}
      GROUP BY 1 ORDER BY total DESC`, p);
    // Від чого відмовляються: розбивка по артикулах
    const byArt = await pool.query(`
      SELECT oi.article,
             MAX(p.name) AS name,
             COUNT(DISTINCT rt.id)::int AS refused,
             COUNT(DISTINCT rt.id) FILTER (WHERE rt.status = 'received')::int AS received,
             COUNT(DISTINCT rt.id) FILTER (WHERE rt.status = 'picked_up')::int AS on_hands,
             COUNT(DISTINCT rt.id) FILTER (WHERE rt.status IN ('in_transit','at_branch'))::int AS on_way
      FROM returns rt
      JOIN order_items oi ON oi.order_id = rt.order_id
      LEFT JOIN products p ON p.article = oi.article
      ${where ? where.replace(/refused_at/g, 'rt.refused_at') : ''}
      ${where ? 'AND' : 'WHERE'} oi.article IS NOT NULL AND oi.article <> ''
      GROUP BY oi.article ORDER BY refused DESC`, p);

    // Скільки всього продано цих артикулів за період — щоб бачити % відмов
    const soldP = [], soldC = [`o.status = 'Продажа'`];
    const lead = `COALESCE(o.original_created_at, o.created_at)`;
    if (dateFrom) { soldP.push(dateFrom); soldC.push(`${lead} >= $${soldP.length}::date`); }
    if (dateTo) { soldP.push(dateTo); soldC.push(`${lead} < ($${soldP.length}::date + interval '1 day')`); }
    const sold = await pool.query(`
      SELECT oi.article, COUNT(DISTINCT o.id)::int AS sold
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE ${soldC.join(' AND ')} AND oi.article IS NOT NULL AND oi.article <> ''
      GROUP BY oi.article`, soldP);
    const soldMap = {};
    sold.rows.forEach(x => { soldMap[x.article] = x.sold; });
    const byArticle = byArt.rows.map(x => {
      const s = soldMap[x.article] || 0;
      return { ...x, sold: s, refusal_pct: (s + x.refused) ? Math.round(x.refused / (s + x.refused) * 1000) / 10 : 0 };
    });

    // Список міст для фільтра — по всій таблиці, не лише по періоду
    const cities = await pool.query(`SELECT DISTINCT return_city FROM returns WHERE return_city <> '' ORDER BY 1`);
    res.json({ byCity: r.rows, byArticle, cities: cities.rows.map(x => x.return_city) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Синк з НП вручну (кнопка)
app.post('/api/returns/sync', checkAuth, async (req, res) => {
  try { res.json({ success: true, ...(await syncReturns()) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Ручна зміна: статус / нотатка / зворотна ТТН / місто
app.patch('/api/returns/:id(\\d+)', checkAuth, async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = [];
  const set = (k, v) => { vals.push(v); sets.push(`${k}=$${vals.length}`); };
  try {
    if (b.status !== undefined) {
      if (!RETURN_RANK[b.status]) return res.status(400).json({ error: 'Невірний статус' });
      set('status', b.status);
      if (b.status === 'received') set('received_at', b.received_at ? new Date(b.received_at) : new Date());
      if (b.status === 'picked_up') sets.push(`picked_up_at = COALESCE(picked_up_at, now())`);
      if (b.status === 'at_branch') sets.push(`arrived_at = COALESCE(arrived_at, now())`);
      if (b.status !== 'received') set('received_at', null);
    }
    if (b.note !== undefined) set('note', String(b.note));
    if (b.return_ttn !== undefined) set('return_ttn', String(b.return_ttn).trim());
    if (b.return_city !== undefined) set('return_city', String(b.return_city).trim());
    if (!sets.length) return res.status(400).json({ error: 'Нічого оновлювати' });
    vals.push(req.params.id);
    await pool.query(`UPDATE returns SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Масово: кур'єр приніс пачку — відмітив усі як отримані
app.post('/api/returns/bulk', checkAuth, async (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Boolean);
  const status = req.body.status;
  if (!ids.length || !RETURN_RANK[status]) return res.status(400).json({ error: 'ids/status' });
  try {
    const extra = status === 'received' ? `, received_at = now()`
      : status === 'picked_up' ? `, picked_up_at = COALESCE(picked_up_at, now())` : '';
    const r = await pool.query(`UPDATE returns SET status=$1${extra} WHERE id = ANY($2)`, [status, ids]);
    res.json({ success: true, updated: r.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/returns/:id(\\d+)', checkAuth, async (req, res) => {
  try { await pool.query(`DELETE FROM returns WHERE id=$1`, [req.params.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
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
    DATE: new Date().toLocaleDateString('sv-SE') // YYYY-MM-DD у Europe/Kyiv (process.env.TZ)
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

// Авто-опитування кожні 30 хв (НП + повернення + SMS)
setInterval(async () => {
  try { await refreshNpStatuses(); } catch (e) {}
  try { await syncReturns(); } catch (e) { console.error('[returns sync]', e.message); }
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
        const params = [];
        let where = '';
        if (req.query.product_id) {
            params.push(req.query.product_id);
            where = `WHERE s.product_id = $${params.length}`;
        }
        const result = await pool.query(`
            SELECT s.*, p.article, p.name as product_name
            FROM stock s
            JOIN products p ON s.product_id = p.id
            ${where}
            ORDER BY p.article ASC, s.color ASC, s.size ASC
        `, params);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// mode=set — встановлює quantity (для матриці). За замовч. mode=add — додає до існуючого (для legacy "Прихід на склад").
app.post('/api/stock', checkAuth, async (req, res) => {
    const { product_id, color, size, quantity, mode } = req.body;
    try {
        const existing = await pool.query(
            'SELECT id, quantity FROM stock WHERE product_id = $1 AND color ILIKE $2 AND size ILIKE $3',
            [product_id, (color || '').trim(), (size || '').trim()]
        );

        const qty = parseInt(quantity) || 0;
        if (existing.rows.length > 0) {
            const newQty = mode === 'set'
                ? qty
                : (parseInt(existing.rows[0].quantity) + qty);
            await pool.query('UPDATE stock SET quantity = $1 WHERE id = $2', [newQty, existing.rows[0].id]);
            res.json({ success: true, id: existing.rows[0].id, quantity: newQty });
        } else {
            const ins = await pool.query(
                'INSERT INTO stock (product_id, color, size, quantity) VALUES ($1, $2, $3, $4) RETURNING id',
                [product_id, (color || '').trim(), (size || '').trim(), qty]
            );
            res.json({ success: true, id: ins.rows[0].id, quantity: qty });
        }
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

// ===================== ФІНАНСИ =====================

// --- РАХУНКИ ---
app.get('/api/finance/accounts', checkAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM finance_accounts ORDER BY sort_order, id`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/finance/accounts', checkAuth, async (req, res) => {
  const { name, initial_balance, color, icon } = req.body;
  if (!name) return res.status(400).json({ error: 'Назва обов\'язкова' });
  try {
    const r = await pool.query(
      `INSERT INTO finance_accounts (name, initial_balance, color, icon)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [name.trim(), Number(initial_balance) || 0, color || '#8b5cf6', icon || 'wallet']
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/finance/accounts/:id(\\d+)', checkAuth, async (req, res) => {
  const allowed = ['name', 'initial_balance', 'color', 'icon', 'is_archived', 'sort_order'];
  const keys = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!keys.length) return res.status(400).json({ error: 'Нічого оновити' });
  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = keys.map(k => req.body[k]);
  values.push(req.params.id);
  try {
    await pool.query(`UPDATE finance_accounts SET ${setClause} WHERE id = $${values.length}`, values);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/finance/accounts/:id(\\d+)', checkAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM finance_accounts WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- КАТЕГОРІЇ ---
app.get('/api/finance/categories', checkAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM finance_categories ORDER BY kind, sort_order, id`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/finance/categories', checkAuth, async (req, res) => {
  const { name, kind, color } = req.body;
  if (!name || !['income', 'expense'].includes(kind)) {
    return res.status(400).json({ error: 'Невірні дані' });
  }
  try {
    const r = await pool.query(
      `INSERT INTO finance_categories (name, kind, color) VALUES ($1, $2, $3) RETURNING id`,
      [name.trim(), kind, color || '#94a3b8']
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/finance/categories/:id(\\d+)', checkAuth, async (req, res) => {
  try {
    const cat = await pool.query(`SELECT is_system FROM finance_categories WHERE id = $1`, [req.params.id]);
    if (cat.rows[0] && cat.rows[0].is_system) {
      return res.status(400).json({ error: 'Системну категорію видалити не можна' });
    }
    await pool.query(`DELETE FROM finance_categories WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ТРАНЗАКЦІЇ ---
app.get('/api/finance/transactions', checkAuth, async (req, res) => {
  try {
    const params = [];
    const conds = [];
    if (req.query.dateFrom) { params.push(req.query.dateFrom); conds.push(`t.date >= $${params.length}::date`); }
    if (req.query.dateTo)   { params.push(req.query.dateTo);   conds.push(`t.date <= $${params.length}::date`); }
    if (req.query.account_id)  { params.push(req.query.account_id);  conds.push(`(t.account_id = $${params.length} OR t.to_account_id = $${params.length})`); }
    if (req.query.category_id) { params.push(req.query.category_id); conds.push(`t.category_id = $${params.length}`); }
    if (req.query.kind) { params.push(req.query.kind); conds.push(`t.kind = $${params.length}`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const r = await pool.query(`
      SELECT t.*,
             a.name AS account_name, a.color AS account_color,
             ta.name AS to_account_name, ta.color AS to_account_color,
             c.name AS category_name, c.color AS category_color, c.kind AS category_kind
      FROM finance_transactions t
      LEFT JOIN finance_accounts a  ON a.id = t.account_id
      LEFT JOIN finance_accounts ta ON ta.id = t.to_account_id
      LEFT JOIN finance_categories c ON c.id = t.category_id
      ${where}
      ORDER BY t.date DESC, t.id DESC
      LIMIT 500
    `, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/finance/transactions', checkAuth, async (req, res) => {
  const { date, kind, amount, account_id, to_account_id, category_id, description, source, source_ref } = req.body;
  if (!date || !kind || !amount) return res.status(400).json({ error: 'date, kind, amount обов\'язкові' });
  if (!['income', 'expense', 'transfer'].includes(kind)) return res.status(400).json({ error: 'Невірний kind' });
  const amt = Number(amount);
  if (!isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'amount має бути > 0' });
  if (kind === 'transfer' && (!account_id || !to_account_id || account_id === to_account_id)) {
    return res.status(400).json({ error: 'Для переказу потрібні різні account_id і to_account_id' });
  }
  if (kind !== 'transfer' && !account_id) return res.status(400).json({ error: 'account_id обов\'язковий' });
  try {
    const r = await pool.query(
      `INSERT INTO finance_transactions (date, kind, amount, account_id, to_account_id, category_id, description, source, source_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [date, kind, amt, account_id || null, to_account_id || null, category_id || null, description || '', source || 'manual', source_ref || '']
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/finance/transactions/:id(\\d+)', checkAuth, async (req, res) => {
  const allowed = ['date', 'kind', 'amount', 'account_id', 'to_account_id', 'category_id', 'description'];
  const keys = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!keys.length) return res.status(400).json({ error: 'Нічого оновити' });
  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = keys.map(k => req.body[k]);
  values.push(req.params.id);
  try {
    await pool.query(`UPDATE finance_transactions SET ${setClause} WHERE id = $${values.length}`, values);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/finance/transactions/:id(\\d+)', checkAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM finance_transactions WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- БАЛАНСИ РАХУНКІВ ---
app.get('/api/finance/balances', checkAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT a.id, a.name, a.color, a.icon, a.initial_balance,
             a.initial_balance
               + COALESCE((SELECT SUM(amount) FROM finance_transactions WHERE account_id = a.id AND kind = 'income'), 0)
               - COALESCE((SELECT SUM(amount) FROM finance_transactions WHERE account_id = a.id AND kind = 'expense'), 0)
               - COALESCE((SELECT SUM(amount) FROM finance_transactions WHERE account_id = a.id AND kind = 'transfer'), 0)
               + COALESCE((SELECT SUM(amount) FROM finance_transactions WHERE to_account_id = a.id AND kind = 'transfer'), 0)
               AS balance
      FROM finance_accounts a
      WHERE a.is_archived = false
      ORDER BY a.sort_order, a.id
    `);
    const accounts = r.rows.map(a => ({ ...a, balance: Number(a.balance) || 0, initial_balance: Number(a.initial_balance) || 0 }));
    const total = accounts.reduce((s, a) => s + a.balance, 0);

    // Гроші в дорозі: сума замовлень в статусах "Доставка/В пути/На почте"
    const inFlightRes = await pool.query(`
      SELECT COALESCE(SUM(oi.price * oi.quantity), 0)::numeric AS in_flight,
             COUNT(DISTINCT o.id)::int AS in_flight_count
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.status IN ('Доставка','В пути','На почте')
    `);
    res.json({
      accounts,
      total,
      in_flight: Number(inFlightRes.rows[0].in_flight) || 0,
      in_flight_count: inFlightRes.rows[0].in_flight_count || 0
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- РОЗРАХУНКОВІ ФІНАНСОВІ ПОТОКИ ---
// Продажі (виручка), собівартість (COGS), реклама (FB), повернення (пошта) рахуються НА ЛЬОТУ
// з orders/order_items/fb_spend_daily. Вони НЕ пишуться в finance_transactions → неможливі дублі/розсинхрон.
// Мітки (авто) відрізняють їх від ручних транзакцій.
const AUTO_CATS = {
  sales:   { category: 'Продаж (авто)',            color: '#10b981', kind: 'income'  },
  cogs:    { category: 'Собівартість товару (авто)', color: '#f97316', kind: 'expense' },
  ads:     { category: 'Реклама Facebook (авто)',   color: '#3b82f6', kind: 'expense' },
  returns: { category: 'Повернення пошта (авто)',   color: '#f43f5e', kind: 'expense' },
  courier: { category: "Кур'єр / відправка (авто)", color: '#a855f7', kind: 'expense' }
};

// Повертає map period -> {revenue, cogs, ads, returns, courier, orders} за gran ('day'|'week'|'month')
async function computedFinanceStreams(dateFrom, dateTo, gran) {
  const leadExpr = `COALESCE(o.original_created_at, o.created_at)`;

  const sp = [];
  const sConds = [`o.status = 'Продажа'`];
  if (dateFrom) { sp.push(dateFrom); sConds.push(`${leadExpr} >= $${sp.length}::date`); }
  if (dateTo)   { sp.push(dateTo);   sConds.push(`${leadExpr} < ($${sp.length}::date + interval '1 day')`); }
  const salesQ = `
    SELECT to_char(date_trunc('${gran}', ${leadExpr}), 'YYYY-MM-DD') AS period,
           COALESCE(SUM(oi.price * oi.quantity),0)::numeric AS revenue,
           COALESCE(SUM(COALESCE((SELECT MAX(cost) FROM products p WHERE p.article = oi.article),0) * oi.quantity),0)::numeric AS cogs,
           COUNT(DISTINCT o.id)::int AS orders,
           COUNT(DISTINCT o.id) FILTER (WHERE o.ttn <> '' AND o.ttn IS NOT NULL)::int AS orders_shipped
    FROM orders o JOIN order_items oi ON oi.order_id = o.id
    WHERE ${sConds.join(' AND ')}
    GROUP BY 1`;

  const fp = [];
  const fConds = [];
  if (dateFrom) { fp.push(dateFrom); fConds.push(`date >= $${fp.length}::date`); }
  if (dateTo)   { fp.push(dateTo);   fConds.push(`date < ($${fp.length}::date + interval '1 day')`); }
  const _s = await getEconomicsSettings();
  const adsQ = `
    SELECT to_char(date_trunc('${gran}', date), 'YYYY-MM-DD') AS period,
           COALESCE(SUM(${fxSpendSql(_s)}),0)::numeric AS spend
    FROM fb_spend_daily ${fConds.length ? 'WHERE ' + fConds.join(' AND ') : ''}
    GROUP BY 1`;

  const rp = [];
  const rConds = [`o.status IN ('Отказ','Возврат')`, `o.ttn <> ''`, `o.ttn IS NOT NULL`];
  if (dateFrom) { rp.push(dateFrom); rConds.push(`${leadExpr} >= $${rp.length}::date`); }
  if (dateTo)   { rp.push(dateTo);   rConds.push(`${leadExpr} < ($${rp.length}::date + interval '1 day')`); }
  const refQ = `
    SELECT to_char(date_trunc('${gran}', ${leadExpr}), 'YYYY-MM-DD') AS period, COUNT(DISTINCT o.id)::int AS refused
    FROM orders o WHERE ${rConds.join(' AND ')} GROUP BY 1`;

  const settings = await getEconomicsSettings();
  const returnCost = Number(settings.return_cost) || 0;
  const courierCost = Number(settings.courier_cost) || 0;
  const [sales, ads, refs] = await Promise.all([
    pool.query(salesQ, sp), pool.query(adsQ, fp), pool.query(refQ, rp)
  ]);

  const map = {};
  const ensure = p => (map[p] = map[p] || { period: p, revenue: 0, cogs: 0, ads: 0, returns: 0, courier: 0, refused: 0, orders: 0, shipped: 0 });
  sales.rows.forEach(r => { const m = ensure(r.period); m.revenue = Number(r.revenue) || 0; m.cogs = Number(r.cogs) || 0; m.orders = Number(r.orders) || 0; m.shipped = Number(r.orders_shipped) || 0; });
  ads.rows.forEach(r => { ensure(r.period).ads = Number(r.spend) || 0; });
  refs.rows.forEach(r => { const m = ensure(r.period); m.refused = Number(r.refused) || 0; m.returns = m.refused * returnCost; });
  // Кур'єр — за кожну відправлену посилку (продані + відмови)
  Object.values(map).forEach(m => { m.courier = (m.shipped + m.refused) * courierCost; });
  return map;
}

// --- ЗВІТ P&L ---
app.get('/api/finance/pnl', checkAuth, async (req, res) => {
  const { dateFrom, dateTo, granularity } = req.query;
  const gran = granularity === 'week' ? 'week' : 'month';
  try {
    const params = [];
    const conds = [];
    if (dateFrom) { params.push(dateFrom); conds.push(`date >= $${params.length}::date`); }
    if (dateTo)   { params.push(dateTo);   conds.push(`date <= $${params.length}::date`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const q = `
      SELECT to_char(date_trunc('${gran}', t.date), 'YYYY-MM-DD') AS period,
             COALESCE(c.name, '— Без категорії') AS category,
             COALESCE(c.kind, t.kind) AS kind,
             COALESCE(c.color, '#94a3b8') AS color,
             SUM(t.amount)::numeric AS total
      FROM finance_transactions t
      LEFT JOIN finance_categories c ON c.id = t.category_id
      ${where}
      ${conds.length ? 'AND' : 'WHERE'} t.kind IN ('income','expense')
      GROUP BY date_trunc('${gran}', t.date), c.name, c.kind, t.kind, c.color
      ORDER BY date_trunc('${gran}', t.date) DESC, kind, total DESC
    `;
    const r = await pool.query(q, params);

    // Групуємо в зручний формат: { period: { income: [{cat,total}], expense: [{cat,total}], totals: {income, expense, profit} } }
    const periods = {};
    const ensureP = p => (periods[p] = periods[p] || { period: p, income: [], expense: [], totals: { income: 0, expense: 0, profit: 0 } });
    for (const row of r.rows) {
      const P = ensureP(row.period);
      const item = { category: row.category, color: row.color, total: Number(row.total) || 0 };
      if (row.kind === 'income') { P.income.push(item); P.totals.income += item.total; }
      else                       { P.expense.push(item); P.totals.expense += item.total; }
    }

    // Додаємо розрахункові потоки
    const streams = await computedFinanceStreams(dateFrom, dateTo, gran);
    for (const s of Object.values(streams)) {
      const P = ensureP(s.period);
      if (s.revenue > 0) { P.income.push({ ...AUTO_CATS.sales, total: s.revenue }); P.totals.income += s.revenue; }
      if (s.cogs > 0)    { P.expense.push({ ...AUTO_CATS.cogs, total: s.cogs });    P.totals.expense += s.cogs; }
      if (s.ads > 0)     { P.expense.push({ ...AUTO_CATS.ads, total: s.ads });      P.totals.expense += s.ads; }
      if (s.returns > 0) { P.expense.push({ ...AUTO_CATS.returns, total: s.returns }); P.totals.expense += s.returns; }
      if (s.courier > 0) { P.expense.push({ ...AUTO_CATS.courier, total: s.courier }); P.totals.expense += s.courier; }
    }

    Object.values(periods).forEach(p => {
      p.income.sort((a, b) => b.total - a.total);
      p.expense.sort((a, b) => b.total - a.total);
      p.totals.profit = p.totals.income - p.totals.expense;
    });
    res.json(Object.values(periods).sort((a, b) => b.period.localeCompare(a.period)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- CASH FLOW ---
app.get('/api/finance/cashflow', checkAuth, async (req, res) => {
  const { dateFrom, dateTo, granularity } = req.query;
  const gran = granularity === 'week' ? 'week' : granularity === 'month' ? 'month' : 'day';
  try {
    const params = [];
    const conds = [];
    if (dateFrom) { params.push(dateFrom); conds.push(`date >= $${params.length}::date`); }
    if (dateTo)   { params.push(dateTo);   conds.push(`date <= $${params.length}::date`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const q = `
      SELECT to_char(date_trunc('${gran}', date), 'YYYY-MM-DD') AS period,
             SUM(amount) FILTER (WHERE kind = 'income')::numeric AS income,
             SUM(amount) FILTER (WHERE kind = 'expense')::numeric AS expense
      FROM finance_transactions
      ${where}
      GROUP BY date_trunc('${gran}', date)
    `;
    const r = await pool.query(q, params);

    const map = {};
    const ensure = p => (map[p] = map[p] || { period: p, income: 0, expense: 0 });
    r.rows.forEach(row => { const m = ensure(row.period); m.income += Number(row.income) || 0; m.expense += Number(row.expense) || 0; });

    const streams = await computedFinanceStreams(dateFrom, dateTo, gran);
    for (const s of Object.values(streams)) {
      const m = ensure(s.period);
      m.income += s.revenue;
      m.expense += s.cogs + s.ads + s.returns + s.courier;
    }

    const out = Object.values(map)
      .map(m => ({ period: m.period, income: m.income, expense: m.expense, net: m.income - m.expense }))
      .sort((a, b) => a.period.localeCompare(b.period));
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ЗВЕДЕННЯ (картки за період) ---
app.get('/api/finance/summary', checkAuth, async (req, res) => {
  const { dateFrom, dateTo } = req.query;
  try {
    // Розрахункові потоки одним відром
    const streams = await computedFinanceStreams(dateFrom, dateTo, 'year');
    let revenue = 0, cogs = 0, ads = 0, returns = 0, courier = 0, ordersSold = 0;
    for (const s of Object.values(streams)) { revenue += s.revenue; cogs += s.cogs; ads += s.ads; returns += s.returns; courier += s.courier; ordersSold += s.orders; }

    // Ручні транзакції за період
    const mp = [];
    const mConds = [];
    if (dateFrom) { mp.push(dateFrom); mConds.push(`date >= $${mp.length}::date`); }
    if (dateTo)   { mp.push(dateTo);   mConds.push(`date <= $${mp.length}::date`); }
    const mWhere = mConds.length ? 'WHERE ' + mConds.join(' AND ') : '';
    const mR = await pool.query(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE kind='income'),0)::numeric  AS manual_income,
        COALESCE(SUM(amount) FILTER (WHERE kind='expense'),0)::numeric AS manual_expense
      FROM finance_transactions ${mWhere}`, mp);
    const manualIncome  = Number(mR.rows[0].manual_income)  || 0;
    const manualExpense = Number(mR.rows[0].manual_expense) || 0;

    const totalIncome  = revenue + manualIncome;
    const totalExpense = cogs + ads + returns + courier + manualExpense;
    const profit = totalIncome - totalExpense;

    res.json({
      revenue, cogs, ads, returns, courier, manualIncome, manualExpense,
      totalIncome, totalExpense, profit,
      ordersSold,
      avgCheck: ordersSold ? revenue / ordersSold : 0,
      marginPct: totalIncome ? (profit / totalIncome) * 100 : 0,
      // розбивка витрат для міні-діаграми
      expenseBreakdown: [
        { label: 'Собівартість', value: cogs,          color: AUTO_CATS.cogs.color },
        { label: 'Реклама',      value: ads,           color: AUTO_CATS.ads.color },
        { label: 'Повернення',   value: returns,       color: AUTO_CATS.returns.color },
        { label: "Кур'єр",       value: courier,       color: AUTO_CATS.courier.color },
        { label: 'Інші (ручні)', value: manualExpense, color: '#64748b' }
      ].filter(x => x.value > 0)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- РЕГУЛЯРНІ (ПОСТІЙНІ) ВИТРАТИ ---
app.get('/api/finance/recurring', checkAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT rr.*, c.name AS category_name, c.color AS category_color, a.name AS account_name,
             EXISTS (
               SELECT 1 FROM finance_transactions t
               WHERE t.source = 'recurring' AND t.source_ref = rr.id::text || ':' || to_char(now(),'YYYY-MM')
             ) AS posted_this_month
      FROM finance_recurring rr
      LEFT JOIN finance_categories c ON c.id = rr.category_id
      LEFT JOIN finance_accounts a   ON a.id = rr.account_id
      ORDER BY rr.is_active DESC, rr.day_of_month, rr.id`);
    res.json(r.rows.map(x => ({ ...x, amount: Number(x.amount) || 0 })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/finance/recurring', checkAuth, async (req, res) => {
  const { name, amount, category_id, account_id, day_of_month, note } = req.body;
  if (!name || !amount) return res.status(400).json({ error: 'name та amount обовʼязкові' });
  const amt = Number(amount);
  if (!isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'amount має бути > 0' });
  try {
    const r = await pool.query(
      `INSERT INTO finance_recurring (name, amount, category_id, account_id, day_of_month, note)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [name, amt, category_id || null, account_id || null, Math.min(31, Math.max(1, Number(day_of_month) || 1)), note || '']
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/finance/recurring/:id(\\d+)', checkAuth, async (req, res) => {
  const allowed = ['name', 'amount', 'category_id', 'account_id', 'day_of_month', 'note', 'is_active'];
  const keys = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!keys.length) return res.status(400).json({ error: 'Нічого оновити' });
  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = keys.map(k => req.body[k]);
  values.push(req.params.id);
  try {
    await pool.query(`UPDATE finance_recurring SET ${setClause} WHERE id = $${values.length}`, values);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/finance/recurring/:id(\\d+)', checkAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM finance_recurring WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Провести регулярну витрату за місяць (ідемпотентно: один раз на місяць)
app.post('/api/finance/recurring/:id(\\d+)/post', checkAuth, async (req, res) => {
  try {
    const rr = await pool.query(`SELECT * FROM finance_recurring WHERE id = $1`, [req.params.id]);
    if (!rr.rows.length) return res.status(404).json({ error: 'Не знайдено' });
    const t = rr.rows[0];
    if (!t.account_id) return res.status(400).json({ error: 'У шаблоні не вказано рахунок — вкажи його спершу' });

    const month = (req.body && req.body.month) || new Date().toLocaleDateString('sv-SE').slice(0, 7); // YYYY-MM у Києві
    const ref = `${t.id}:${month}`;
    const dup = await pool.query(`SELECT id FROM finance_transactions WHERE source='recurring' AND source_ref=$1`, [ref]);
    if (dup.rows.length) return res.status(409).json({ error: 'Вже проведено за цей місяць' });

    const day = String(Math.min(28, Math.max(1, t.day_of_month || 1))).padStart(2, '0');
    const date = `${month}-${day}`;
    const ins = await pool.query(
      `INSERT INTO finance_transactions (date, kind, amount, account_id, category_id, description, source, source_ref)
       VALUES ($1,'expense',$2,$3,$4,$5,'recurring',$6) RETURNING id`,
      [date, t.amount, t.account_id, t.category_id, t.name + (t.note ? ' — ' + t.note : ''), ref]
    );
    res.json({ success: true, id: ins.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', checkAuth, (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`tomireal CRM running on ${PORT}`));
