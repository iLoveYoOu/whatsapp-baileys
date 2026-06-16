const fs = require('fs');

let txt = fs.readFileSync('./server.js', 'utf8');

const mapa = {
  'Ã¡': 'á',
  'Ã ': 'à',
  'Ã¢': 'â',
  'Ã£': 'ã',
  'Ã¤': 'ä',
  'Ã©': 'é',
  'Ãª': 'ê',
  'Ã­': 'í',
  'Ã³': 'ó',
  'Ã´': 'ô',
  'Ãµ': 'õ',
  'Ãº': 'ú',
  'Ã§': 'ç',
  'â†’': '→',
  'Ã': 'À'
};

for (const [errado, certo] of Object.entries(mapa)) {
  txt = txt.split(errado).join(certo);
}

fs.writeFileSync('./server.js', txt, 'utf8');

console.log('server.js corrigido.');