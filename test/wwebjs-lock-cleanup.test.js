const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

test('remove somente o lock obsoleto e preserva o perfil LocalAuth', () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wwebjs-lock-'));
  const lockPath = path.join(dataPath, '.bot-local.lock');
  const arquivoSessao = path.join(dataPath, 'session-bot-paliativo', 'Default', 'Preferences');

  try {
    fs.mkdirSync(path.dirname(arquivoSessao), { recursive: true });
    fs.writeFileSync(lockPath, '{"pid":86}');
    fs.writeFileSync(arquivoSessao, '{"sessao":"preservada"}');

    const resultado = spawnSync(process.execPath, [
      path.resolve(__dirname, '..', 'scripts', 'corrigir-lock-wwebjs.js')
    ], {
      env: { ...process.env, WWEBJS_AUTH_PATH: dataPath },
      encoding: 'utf8'
    });

    assert.equal(resultado.status, 0, resultado.stderr);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.readFileSync(arquivoSessao, 'utf8'), '{"sessao":"preservada"}');
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
