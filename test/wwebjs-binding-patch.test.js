const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

test('aplica o patch de binding de forma idempotente', () => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wwebjs-binding-'));
  const utilPath = path.join(packageRoot, 'src', 'util', 'Puppeteer.js');
  const patchPath = path.resolve(__dirname, '..', 'scripts', 'patch-wwebjs-binding.js');

  try {
    fs.mkdirSync(path.dirname(utilPath), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      '{"name":"whatsapp-web.js","version":"1.34.7"}'
    );
    fs.writeFileSync(utilPath, 'module.exports = {};');

    const runPatch = () => spawnSync(process.execPath, [patchPath], {
      env: { ...process.env, WWEBJS_PACKAGE_ROOT: packageRoot },
      encoding: 'utf8'
    });

    const firstRun = runPatch();
    assert.equal(firstRun.status, 0, firstRun.stderr);
    const firstContent = fs.readFileSync(utilPath, 'utf8');
    assert.match(firstContent, /WWEBJS_BINDING_RACE_PATCH/);

    const secondRun = runPatch();
    assert.equal(secondRun.status, 0, secondRun.stderr);
    assert.equal(fs.readFileSync(utilPath, 'utf8'), firstContent);
  } finally {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});
