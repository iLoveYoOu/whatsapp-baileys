const fs = require('fs');
const path = require('path');

const raizPacote = process.env.WWEBJS_PACKAGE_ROOT ||
  path.join(process.cwd(), 'node_modules', 'whatsapp-web.js');
const packageJsonPath = path.join(raizPacote, 'package.json');
const puppeteerUtilPath = path.join(raizPacote, 'src', 'util', 'Puppeteer.js');
const clientPath = path.join(raizPacote, 'src', 'Client.js');
const MARCADOR_BINDING = 'WWEBJS_BINDING_RACE_PATCH';
const MARCADOR_INJECT = 'WWEBJS_INJECT_NAVIGATION_PATCH';

if (!fs.existsSync(packageJsonPath) || !fs.existsSync(puppeteerUtilPath) || !fs.existsSync(clientPath)) {
  throw new Error('[PATCH-WWEBJS] Instalação do whatsapp-web.js não encontrada.');
}

const pacote = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
if (pacote.version !== '1.34.7') {
  throw new Error(`[PATCH-WWEBJS] Versão inesperada: ${pacote.version}. Esperada: 1.34.7.`);
}

const utilAtual = fs.readFileSync(puppeteerUtilPath, 'utf8');
if (!utilAtual.includes(MARCADOR_BINDING)) {
  const utilCorrigido = `'use strict';

// ${MARCADOR_BINDING}
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

  fs.writeFileSync(puppeteerUtilPath, utilCorrigido, 'utf8');
  console.log('[PATCH-WWEBJS] Corrida de registro de bindings corrigida.');
} else {
  console.log('[PATCH-WWEBJS] Correção idempotente de bindings já aplicada.');
}

let clientAtual = fs.readFileSync(clientPath, 'utf8');
if (!clientAtual.includes(MARCADOR_INJECT)) {
  const ancora = /^([ \t]*)await this\.inject\(\);\r?\n(?:[ \t]*\r?\n)*\1this\.pupPage\.on\(['"]framenavigated['"]/m;
  const correspondencia = clientAtual.match(ancora);
  if (!correspondencia) {
    throw new Error('[PATCH-WWEBJS] Ponto de injeção esperado não encontrado em Client.js.');
  }

  const indentacao = correspondencia[1];
  const interno = `${indentacao}    `;
  const blocoCorrigido = `${indentacao}// ${MARCADOR_INJECT}
${indentacao}for (let tentativaInject = 1; tentativaInject <= 3; tentativaInject += 1) {
${interno}try {
${interno}    await this.inject();
${interno}    break;
${interno}} catch (erro) {
${interno}    const mensagem = String(erro?.message || erro || '');
${interno}    const contextoDestruido =
${interno}        mensagem.includes('Execution context was destroyed') ||
${interno}        mensagem.includes('Cannot find context with specified id');

${interno}    if (!contextoDestruido || tentativaInject >= 3) throw erro;
${interno}    await new Promise(resolve => setTimeout(resolve, 1000 * tentativaInject));
${interno}}
${indentacao}}
${indentacao}this.pupPage.on('framenavigated'`;

  clientAtual = clientAtual.replace(ancora, blocoCorrigido);
  fs.writeFileSync(clientPath, clientAtual, 'utf8');
  console.log('[PATCH-WWEBJS] Navegação durante injeção agora possui retentativa interna.');
} else {
  console.log('[PATCH-WWEBJS] Retentativa interna de injeção já aplicada.');
}
