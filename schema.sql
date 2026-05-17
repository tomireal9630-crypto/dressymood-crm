-- Эта схема соответствует тому, что server.js создаёт автоматически при старте
-- (функция updateDatabaseSchema). Файл — справочный/для ручного развёртывания.

-- Клиенты
CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Поставщики
CREATE TABLE IF NOT EXISTS suppliers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE
);

-- Товары (база)
CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    article VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    cost NUMERIC DEFAULT 0,
    price NUMERIC DEFAULT 0,
    supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
    links TEXT DEFAULT ''
);

-- Заказы
CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(id),
    article VARCHAR(255) DEFAULT '',
    size VARCHAR(50) DEFAULT '',
    color VARCHAR(50) DEFAULT '',
    status VARCHAR(50) DEFAULT 'Новий',
    ttn VARCHAR(255) DEFAULT '',
    price NUMERIC DEFAULT 0,
    cost NUMERIC DEFAULT 0,
    source VARCHAR(100) DEFAULT 'Вручну',
    comment TEXT DEFAULT '',
    delivery_service VARCHAR(50) DEFAULT 'НП',
    city VARCHAR(255) DEFAULT '',
    branch TEXT DEFAULT '',
    payment_type VARCHAR(50) DEFAULT 'на счет',
    delivery_payment VARCHAR(50) DEFAULT 'Отримувач',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Позиции заказа (несколько товаров в одном заказе)
CREATE TABLE IF NOT EXISTS order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
    article VARCHAR(255) DEFAULT '',
    name VARCHAR(255) DEFAULT '',
    supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
    supplier_name VARCHAR(255) DEFAULT '',
    size VARCHAR(50) DEFAULT '',
    color VARCHAR(50) DEFAULT '',
    price NUMERIC DEFAULT 0,
    quantity INTEGER NOT NULL DEFAULT 1
);

-- Наличие на складе (остатки по цвету/размеру)
CREATE TABLE IF NOT EXISTS stock (
    id SERIAL PRIMARY KEY,
    product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
    color VARCHAR(100) NOT NULL DEFAULT '',
    size VARCHAR(50) NOT NULL DEFAULT '',
    quantity INTEGER NOT NULL DEFAULT 0
);
