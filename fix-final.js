const fs = require('fs');

const file = './server.js';
let s = fs.readFileSync(file, 'utf8');

// Corrige mensagem principal
s = s.replace(
  /const MSG_DEPOSITO_CONFIRMADO\s*=\s*`[\s\S]*?`;/,
`const MSG_DEPOSITO_CONFIRMADO =
\`✅ DEU CERTO! DEPÓSITO CONFIRMADO!

⚠️ ATENÇÃO - MUITO IMPORTANTE!

Meu número de atendimento pode cair a qualquer momento!

Se a mensagem NÃO CHEGAR, não fique sem resposta!

📲 CHAMA DIRETO NO NÚMERO RESERVA:
48 98425-5049

🕐 Horário de atendimento:
Todos os dias das 09:00 às 00:30

🙏 Obrigado pela confiança!

Att: Equipe Meia do Lucão\`;`
);

// Remove duplicidade do /next: a função já avisa o cliente
s = s.replace(
  /\n\s*if \(resultado\.ok\) \{\s*\n\s*await sock\.sendMessage\(remetente,\s*\{\s*\n\s*text:\s*`.*?Banca liberada para \$\{resultado\.operador\}`\s*\n\s*\}\);\s*\n\s*\}\s*\n\s*return true;/s,
  '\n    return true;'
);

// Corrige textos corrompidos comuns
const map = {
  'âœ…': '✅',
  'âš ï¸': '⚠️',
  '💰': '??',
  '📋': '??',
  '📥': '??',
  '📸': '??',
  '📲': '??',
  '🕘': '??',
  '🙏': '??',
  'Ã§': 'ç',
  'Ã£': 'ã',
  'Ã¡': 'á',
  'Ã©': 'é',
  'Ãª': 'ê',
  'Ã­': 'í',
  'Ã³': 'ó',
  'Ãº': 'ú',
  'Ã ': 'à',
  'Ã‡': 'Ç',
  'â†’': '→'
};

for (const [a, b] of Object.entries(map)) {
  s = s.split(a).join(b);
}

fs.writeFileSync(file, s, 'utf8');
console.log('fix aplicado');
