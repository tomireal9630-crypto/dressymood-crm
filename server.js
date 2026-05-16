const express = require('express');
const db = require('./db');
const path = require('path');
const session = require('express-session');
require('dotenv').config();

const app = express();
const PORT = 3000;

app.use(express.json());

// Отдаем статику ДО всех маршрутов, чтобы login.html и стили были доступны
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Настройка сессий
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback_secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // В реальном проекте с HTTPS поставить true
}));

// Middleware для проверки авторизации
const checkAuth = (req, res, next) => {
    if (req.session.isAuthenticated) {
        return next();
    }
    // Если запрос к API (кроме публичных) — возвращаем JSON ошибку
    if (req.originalUrl.startsWith('/api/')) {
        return res.status(401).json({ error: 'Не авторизован' });
    }
    // Иначе перенаправляем на страницу логина
    res.redirect('/login.html');
};

// Явный роут для страницы входа
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Защищаем корень (index.html)
app.get('/', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Эндпоинт входа
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
        req.session.isAuthenticated = true;
        res.json({ message: 'Успешный вход' });
    } else {
        res.status(401).json({ error: 'Неверный логин или пароль' });
    }
});

// Эндпоинт выхода
app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ message: 'Вышли из системы' });
});

// POST-эндпоинт для приема заявок (оставляем ОТКРЫТЫМ, чтобы сайт мог создавать заказы)
app.post('/api/orders', async (req, res) => {
    const { fullName, phone, article, size, color, source } = req.body;

    try {
        let customerQuery = await db.query('SELECT id FROM customers WHERE phone = $1', [phone]);
        let customerId;

        if (customerQuery.rows.length > 0) {
            customerId = customerQuery.rows[0].id;
        } else {
            const newCustomer = await db.query(
                'INSERT INTO customers (full_name, phone) VALUES ($1, $2) RETURNING id',
                [fullName, phone]
            );
            customerId = newCustomer.rows[0].id;
        }

        const newOrder = await db.query(
            'INSERT INTO orders (customer_id, source) VALUES ($1, $2) RETURNING id, created_at',
            [customerId, source]
        );
        const orderId = newOrder.rows[0].id;

        await db.query(
            'INSERT INTO order_items (order_id, product_article, size, color) VALUES ($1, $2, $3, $4)',
            [orderId, article, size, color]
        );

        console.log('\n--- Новая заявка сохранена в БД ---');
        console.log({ orderId, customerId, article, size, color, source });

        res.status(201).json({ 
            message: 'Заявка успешно создана в базе данных', 
            orderId: orderId 
        });
    } catch (error) {
        console.error('Ошибка при сохранении заявки:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// GET-эндпоинт для вывода заявок из БД (ЗАЩИЩЕН)
app.get('/api/orders', checkAuth, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT 
                o.id as order_id, 
                c.full_name, 
                c.phone, 
                oi.product_article as article, 
                oi.size, 
                oi.color, 
                o.source, 
                o.created_at,
                o.status
            FROM orders o
            JOIN customers c ON o.customer_id = c.id
            JOIN order_items oi ON oi.order_id = o.id
            ORDER BY o.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Ошибка при получении заявок:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// PATCH-эндпоинт для обновления статуса заказа (ЗАЩИЩЕН)
app.patch('/api/orders/:id/status', checkAuth, async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    
    try {
        await db.query('UPDATE orders SET status = $1 WHERE id = $2', [status, id]);
        res.json({ message: 'Статус успешно обновлен' });
    } catch (error) {
        console.error('Ошибка при обновлении статуса:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

app.listen(PORT, async () => {
    try {
        await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Новый';`);
    } catch (e) {
        // Игнорируем ошибку при запуске
    }
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log(`Админ-панель доступна по адресу: http://localhost:${PORT}`);
});
