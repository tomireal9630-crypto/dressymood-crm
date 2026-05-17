const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
fs.writeFileSync('test.js', script);
