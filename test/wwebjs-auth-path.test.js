const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  analisarSessao,
  nomeDiretorioSessao,
  resolverDataPath,
  resolverQrMaxRetries
} = require('../src/whatsapp/wwebjs-auth-path');

test('usa WWEBJS_AUTH_PATH quando configurado', () => {
  const resultado = resolverDataPath({
    authPath: './auth-personalizada',
    cwd: process.cwd(),
    renderDiskPath: path.join(os.tmpdir(), 'render-inexistente')
  });

  assert.equal(resultado.dataPath, path.resolve('./auth-personalizada'));
  assert.equal(resultado.origem, 'WWEBJS_AUTH_PATH');
});

test('usa o disco persistente do Render sem exigir variável adicional', () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'wwebjs-render-'));

  try {
    const resultado = resolverDataPath({ authPath: '', cwd: process.cwd(), renderDiskPath: raiz });
    assert.equal(resultado.dataPath, path.join(raiz, '.wwebjs_auth'));
    assert.equal(resultado.origem, 'disco persistente do Render');
  } finally {
    fs.rmSync(raiz, { recursive: true, force: true });
  }
});

test('LocalAuth com clientId usa session-<clientId>', () => {
  assert.equal(nomeDiretorioSessao('bot-render'), 'session-bot-render');
  assert.equal(nomeDiretorioSessao(''), 'session');
});

test('mantém o QR disponível sem limite por padrão', () => {
  assert.equal(resolverQrMaxRetries(), 0);
  assert.equal(resolverQrMaxRetries('0'), 0);
  assert.equal(resolverQrMaxRetries('3'), 3);
  assert.equal(resolverQrMaxRetries('inválido'), 0);
});

test('identifica perfil Chromium válido e sessões com outro clientId', () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wwebjs-auth-'));

  try {
    fs.mkdirSync(
      path.join(dataPath, 'session-bot-render', 'Default', 'Local Storage', 'leveldb'),
      { recursive: true }
    );
    fs.mkdirSync(path.join(dataPath, 'session-antigo'), { recursive: true });

    const diagnostico = analisarSessao({ dataPath, clientId: 'bot-render' });
    assert.equal(diagnostico.perfilExiste, true);
    assert.equal(diagnostico.defaultExiste, true);
    assert.equal(diagnostico.localStorageExiste, true);
    assert.deepEqual(diagnostico.outrasSessoes, ['session-antigo']);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('distingue credenciais Baileys de um perfil LocalAuth', () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wwebjs-baileys-'));

  try {
    fs.writeFileSync(path.join(dataPath, 'creds.json'), '{}');
    const diagnostico = analisarSessao({ dataPath, clientId: 'bot-render' });
    assert.equal(diagnostico.pareceBaileys, true);
    assert.equal(diagnostico.perfilExiste, false);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
