

async function test() {
    try {
        // First login to get the cookie
        const loginRes = await fetch('http://localhost:3000/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: process.env.ADMIN_USERNAME || 'admin', password: process.env.ADMIN_PASSWORD || 'dressy2025' }) // Need to check .env
        });
        
        console.log('Login status:', loginRes.status);
        const cookie = loginRes.headers.get('set-cookie');
        console.log('Cookie:', cookie);

        // Test orders
        const orderRes = await fetch('http://localhost:3000/api/orders/manual', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Cookie': cookie
            },
            body: JSON.stringify({
                fullName: 'Test API',
                phone: '111222333',
                article: 'A1',
                size: 'M',
                color: 'Red',
                price: 100,
                cost: 50,
                source: 'Сайт'
            })
        });
        console.log('Order status:', orderRes.status);
        console.log('Order body:', await orderRes.text());

        // Test suppliers
        const supRes = await fetch('http://localhost:3000/api/warehouse/suppliers', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Cookie': cookie
            },
            body: JSON.stringify({ name: 'Supplier API Test' })
        });
        console.log('Supplier status:', supRes.status);
        console.log('Supplier body:', await supRes.text());

        // Test products
        const prodRes = await fetch('http://localhost:3000/api/warehouse/products', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Cookie': cookie
            },
            body: JSON.stringify({
                article: 'P-API-1',
                name: 'API Prod',
                cost: 10,
                price: 20,
                supplier_id: '',
                links: ''
            })
        });
        console.log('Product status:', prodRes.status);
        console.log('Product body:', await prodRes.text());

    } catch(e) {
        console.error('Error in test:', e);
    }
}

test();
