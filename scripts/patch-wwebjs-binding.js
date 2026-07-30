const fs = require('fs');
const path = require('path');

const packageRoot = process.env.WWEBJS_PACKAGE_ROOT ||
  path.join(process.cwd(), 'node_modules', 'whatsapp-web.js');
const packageJsonPath = path.join(packageRoot, 'package.json');
const puppeteerUtilPath = path.join(packageRoot, 'src', 'util', 'Puppeteer.js');
const PATCH_MARKER = 'WWEBJS_BINDING_RACE_PATCH';

if (!fs.existsSync(packageJsonPath) || !fs.existsSync(puppeteerUtilPath)) {
  throw new Error('[PATCH-WWEBJS] Instalação do whatsapp-web.js não encontrada.');
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
if (packageJson.name !== 'whatsapp-web.js') {
  throw new Error(`[PATCH-WWEBJS] Pacote inesperado: ${packageJson.name || 'sem nome'}.`);
}

const currentSource = fs.readFileSync(puppeteerUtilPath, 'utf8');
if (currentSource.includes(PATCH_MARKER)) {
  console.log('[PATCH-WWEBJS] Correção idempotente de bindings já aplicada.');
  process.exit(0);
}

const patchedSource = `'use strict';

// ${PATCH_MARKER}
async function exposeFunctionIfAbsent(page, name, fn) {
  try {
    await page.exposeFunction(name, fn);
  } catch (error) {
    const message = String(error?.message || error || '');
    const bindingAlreadyExists =
      message.includes('Failed to add page binding') &&
      message.includes(\`window['\${name}'] already exists\`);

    if (bindingAlreadyExists) return;
    throw error;
  }
}

module.exports = { exposeFunctionIfAbsent };
`;

fs.writeFileSync(puppeteerUtilPath, patchedSource, 'utf8');
console.log('[PATCH-WWEBJS] Corrida de registro de bindings corrigida.');
