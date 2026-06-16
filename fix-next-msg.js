const fs = require('fs');

const file = './server.js';
let s = fs.readFileSync(file, 'utf8');

s = s.replace(/.*Nova banca liberada.*/g, '📥 Nova banca liberada');

s = s.replace(/.*Envie apenas a FOTO 1\/2.*/g, '📸 Envie apenas a FOTO 1/2.');

s = s.replace(/.*Após o pagamento confirmado, você poderá enviar a FOTO 2\/2.*/g, 'Após o pagamento confirmado, você poderá enviar a FOTO 2/2.');

fs.writeFileSync(file, s, 'utf8');

console.log('Mensagem do /next corrigida.');