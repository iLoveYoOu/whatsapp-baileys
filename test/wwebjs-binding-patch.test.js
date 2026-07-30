const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

test('aplica o patch de binding de forma idempotente', () => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wwebjs-binding-'));
  const utilPath = path.join(packageRoot, 'src', 'util', 'Puppeteer.js');
  const clientPath = path.join(packageRoot, 'src', 'Client.js');
  const patchPath = path.resolve(__dirname, '..', 'scripts', 'patch-wwebjs-binding.js');

  try {
    fs.mkdirSync(path.dirname(utilPath), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      '{"name":"whatsapp-web.js","version":"1.34.7"}'
    );
    fs.writeFileSync(utilPath, 'module.exports = {};');
    fs.writeFileSync(clientPath, 'if (abort.signal.aborted) throw err;');

    const runPatch = () => spawnSync(process.execPath, [patchPath], {
      env: { ...process.env, WWEBJS_PACKAGE_ROOT: packageRoot },
      encoding: 'utf8'
    });

    const firstRun = runPatch();
    assert.equal(firstRun.status, 0, firstRun.stderr);
    const firstContent = fs.readFileSync(utilPath, 'utf8');
    assert.match(firstContent, /WWEBJS_BINDING_RACE_PATCH/);
    assert.doesNotMatch(firstContent, /page\.evaluate/);
    assert.match(firstContent, /await page\.exposeFunction/);
    const firstClientContent = fs.readFileSync(clientPath, 'utf8');
    assert.match(firstClientContent, /WWEBJS_ABORTED_INJECT_PATCH/);
    assert.doesNotMatch(firstClientContent, /abort\.signal\.aborted\) throw err/);

    const secondRun = runPatch();
    assert.equal(secondRun.status, 0, secondRun.stderr);
    assert.equal(fs.readFileSync(utilPath, 'utf8'), firstContent);
    assert.equal(fs.readFileSync(clientPath, 'utf8'), firstClientContent);
  } finally {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});
