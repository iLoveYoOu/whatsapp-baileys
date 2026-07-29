const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

test('aplica o patch de binding de forma idempotente', () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'wwebjs-binding-'));
  const utilPath = path.join(raiz, 'src', 'util', 'Puppeteer.js');
  const patchPath = path.resolve(__dirname, '..', 'scripts', 'patch-wwebjs-binding.js');

  try {
    fs.mkdirSync(path.dirname(utilPath), { recursive: true });
    fs.writeFileSync(path.join(raiz, 'package.json'), '{"version":"1.34.7"}');
    fs.writeFileSync(utilPath, 'module.exports = {};');

    const executar = () => spawnSync(process.execPath, [patchPath], {
      env: { ...process.env, WWEBJS_PACKAGE_ROOT: raiz },
      encoding: 'utf8'
    });

    const primeira = executar();
    assert.equal(primeira.status, 0, primeira.stderr);
    const conteudoPrimeiro = fs.readFileSync(utilPath, 'utf8');
    assert.match(conteudoPrimeiro, /WWEBJS_BINDING_RACE_PATCH/);

    const segunda = executar();
    assert.equal(segunda.status, 0, segunda.stderr);
    assert.equal(fs.readFileSync(utilPath, 'utf8'), conteudoPrimeiro);
  } finally {
    fs.rmSync(raiz, { recursive: true, force: true });
  }
});
