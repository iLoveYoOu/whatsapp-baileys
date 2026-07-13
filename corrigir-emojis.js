const fs = require('fs');

let txt = fs.readFileSync('./server.js', 'utf8');

const mapa = {
  'âœ…': '✅',
  'âŒ›': '⌛',
  'âš ': '⚠️',
  'âœ…': '✅',
  '💰': '??',
  '📋': '??',
  '📷': '??',
  '🎉': '??',
  '👤': '??',
  '💵': '??',
  '📲': '??',
  '🔗': '??'
};

for (const [errado, certo] of Object.entries(mapa)) {
  txt = txt.split(errado).join(certo);
}

fs.writeFileSync('./server.js', txt, 'utf8');

console.log('Emojis corrigidos.');
