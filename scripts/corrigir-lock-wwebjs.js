const fs = require('fs');
const path = require('path');

const arquivo = path.join(process.cwd(), 'src', 'whatsapp', 'wwebjs-provider.js');

if (!fs.existsSync(arquivo)) {
  console.error('[LOCK-WWEBJS] Provider não encontrado:', arquivo);
  process.exit(1);
}

let codigo = fs.readFileSync(arquivo, 'utf8');

if (!codigo.includes("const os = require('os');")) {
  codigo = codigo.replace(
    "const path = require('path');",
    "const path = require('path');\nconst os = require('os');"
  );
}

const inicio = "  fs.mkdirSync(dataPath, { recursive: true });\n";
const fim = "  lockCriado = true;\n";
const indiceInicio = codigo.indexOf(inicio);
const indiceFimBase = codigo.indexOf(fim, indiceInicio);

if (indiceInicio === -1 || indiceFimBase === -1) {
  if (codigo.includes('[WWEBJS] Lock pertencente a outra instância/container')) {
    console.log('[LOCK-WWEBJS] Correção já aplicada.');
    process.exit(0);
  }

  console.error('[LOCK-WWEBJS] Bloco de lock esperado não foi encontrado.');
  process.exit(1);
}

const indiceFim = indiceFimBase + fim.length;
const blocoNovo = `  fs.mkdirSync(dataPath, { recursive: true });
  const hostnameAtual = os.hostname();

  if (fs.existsSync(lockPath)) {
    let lockAnterior = null;

    try {
      const conteudoLock = fs.readFileSync(lockPath, 'utf8').trim();
      lockAnterior = conteudoLock.startsWith('{')
        ? JSON.parse(conteudoLock)
        : { pid: Number(conteudoLock), legacy: true };
    } catch (erro) {
      console.warn('[WWEBJS] Lock inválido encontrado; será substituído:', erro.message);
    }

    const mesmoContainer = lockAnterior?.hostname === hostnameAtual;
    const pidAnterior = Number(lockAnterior?.pid);
    let processoAtivo = false;

    if (mesmoContainer && pidAnterior) {
      try {
        process.kill(pidAnterior, 0);
        processoAtivo = true;
      } catch (_) {
        processoAtivo = false;
      }
    }

    if (mesmoContainer && processoAtivo) {
      throw new Error(\`Outra instância do bot já está usando .wwebjs_auth neste container (PID \${pidAnterior}).\`);
    }

    console.warn('[WWEBJS] Lock pertencente a outra instância/container ou processo encerrado; removendo lock obsoleto.');
    fs.rmSync(lockPath, { force: true });
  }

  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    hostname: hostnameAtual,
    startedAt: new Date().toISOString()
  }), { flag: 'wx' });
  lockCriado = true;
`;

codigo = codigo.slice(0, indiceInicio) + blocoNovo + codigo.slice(indiceFim);
fs.writeFileSync(arquivo, codigo, 'utf8');
console.log('[LOCK-WWEBJS] Lock corrigido para identificar container e ignorar PID obsoleto.');
