require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const session = require('express-session');

const app = express();

// Настройка сессий для авторизации
app.use(session({
  secret: process.env.SESSION_SECRET || 'super_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // false для работы на бесплатном тарифе Render
}));

app.use(express.json());
// Раздача файлов из папки public (стили, скрипты, картинки)
app.use(express.static(path.join(__dirname, 'public')));

// Middleware для проверки: залогинен ли пользователь
const checkAuth = (req, res, next) => {
  if (req.session.isLoggedIn) {
    next();
  } else {
    res.redirect('/login.html');
  }
};

// Маршрут для входа
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    req.session.isLoggedIn = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Неверный логин или пароль' });
  }
});

// Маршрут для выхода
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ПОЛУЧЕНИЕ ВСЕХ ЗАКАЗОВ (Защищено авторизацией)
app.get('/api/orders', checkAuth, async (req, res) => {
  const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } 
  });
  try {
    const result = await pool.query(`
      SELECT o.id, c.full_name as "fullName", c.phone, o.article, o.size, o.color, o.status, o.created_at as "createdAt"
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      ORDER BY o.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

// ОБНОВЛЕНИЕ СТАТУСА ЗАКАЗА (Защищено авторизацией)
app.patch('/api/orders/:id/status', checkAuth, async (req, res) => {
  const { status } = req.body;
  const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } 
  });
  try {
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

// УДАЛЕНИЕ ЗАКАЗА (Защищено авторизацией)
app.delete('/api/orders/:id', checkAuth, async (req, res) => {
  const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } 
  });
  try {
    await pool.query('DELETE FROM orders WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

// ПРИЕМ НОВОГО ЗАКАЗА (Открытый API для вашего сайта)
app.post('/api/orders', async (req, res) => {
    const { fullName, phone, article, size, color } = req.body;
    const pool = new Pool({ 
        connectionString: process.env.DATABASE_URL, 
        ssl: { rejectUnauthorized: false } 
    });
    try {
        // Создаем или находим клиента
        const customerRes = await pool.query(
            'INSERT INTO customers (full_name, phone) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET full_name = $1 RETURNING id',
            [fullName, phone]
        );
        const customerId = customerRes.rows[0].id;

        // Создаем заказ
        const orderRes = await pool.query(
            'INSERT INTO orders (customer_id, article, size, color, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [customerId, article, size, color, 'Новый']
        );
        res.json({ success: true, orderId: orderRes.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await pool.end();
    }
});

// Главная страница CRM
app.get('/', checkAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CRM-сервер запущен на порту ${PORT}`));
