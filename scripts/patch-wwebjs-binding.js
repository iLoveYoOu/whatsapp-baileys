const fs = require('fs');
const path = require('path');

const raizPacote = process.env.WWEBJS_PACKAGE_ROOT ||
  path.join(process.cwd(), 'node_modules', 'whatsapp-web.js');
const packageJsonPath = path.join(raizPacote, 'package.json');
const puppeteerUtilPath = path.join(raizPacote, 'src', 'util', 'Puppeteer.js');
const MARCADOR = 'WWEBJS_BINDING_RACE_PATCH';

if (!fs.existsSync(packageJsonPath) || !fs.existsSync(puppeteerUtilPath)) {
  throw new Error('[PATCH-WWEBJS] Instalação do whatsapp-web.js não encontrada.');
}

const pacote = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
if (pacote.version !== '1.34.7') {
  throw new Error(`[PATCH-WWEBJS] Versão inesperada: ${pacote.version}. Esperada: 1.34.7.`);
}

const atual = fs.readFileSync(puppeteerUtilPath, 'utf8');
if (atual.includes(MARCADOR)) {
  console.log('[PATCH-WWEBJS] Correção idempotente de bindings já aplicada.');
  process.exit(0);
}

const corrigido = `'use strict';

// ${MARCADOR}
async function exposeFunctionIfAbsent(page, name, fn) {
  const existeNaPagina = await page.evaluate(nome => typeof window[nome] === 'function', name);
  if (existeNaPagina) return;

  try {
    await page.exposeFunction(name, fn);
  } catch (erro) {
    const mensagem = String(erro?.message || erro || '');
    const bindingJaExiste =
      mensagem.includes('Failed to add page binding') &&
      mensagem.includes(\`window['\${name}'] already exists\`);

    if (bindingJaExiste) return;
    throw erro;
  }
}

module.exports = { exposeFunctionIfAbsent };
`;

fs.writeFileSync(puppeteerUtilPath, corrigido, 'utf8');
console.log('[PATCH-WWEBJS] Corrida de registro de bindings corrigida.');
