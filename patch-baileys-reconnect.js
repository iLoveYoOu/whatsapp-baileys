const fs = require('fs');

const arquivo = './server.js';
let codigo = fs.readFileSync(arquivo, 'utf8');

if (codigo.includes('BAILEYS_RECONNECT_FIX_V1')) {
  console.log('[PATCH] Correção do Baileys já aplicada.');
  process.exit(0);
}

const estadoAntigo = "let status = 'iniciando';";
const estadoNovo = `let status = 'iniciando';
// BAILEYS_RECONNECT_FIX_V1
let conectandoWhatsApp = false;
let timerReconexao = null;
let tentativaReconexao = 0;`;

if (!codigo.includes(estadoAntigo)) {
  throw new Error('Não encontrei o ponto de estado do WhatsApp no server.js.');
}

codigo = codigo.replace(estadoAntigo, estadoNovo);

const inicioAntigo = `async function conectarWhatsApp() {
  await carregarBlacklistRemota();`;
const inicioNovo = `async function conectarWhatsApp() {
  if (conectandoWhatsApp) {
    console.log('[WA] Conexão já em andamento; nova tentativa ignorada.');
    return;
  }

  conectandoWhatsApp = true;
  status = 'conectando';

  try {
    await carregarBlacklistRemota();`;

if (!codigo.includes(inicioAntigo)) {
  throw new Error('Não encontrei o início de conectarWhatsApp no server.js.');
}

codigo = codigo.replace(inicioAntigo, inicioNovo);

const blocoAntigo = `    if (connection === 'open') {
      status = 'conectado';
      qrAtual = '';
      console.log('WhatsApp conectado');
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;

      status = shouldReconnect ? 'reconectando' : 'deslogado';

      console.log('Conexão fechada. Reconectar:', shouldReconnect);

      if (shouldReconnect) {
        setTimeout(() => conectarWhatsApp(), 5000);
      }
    }`;

const blocoNovo = `    if (connection === 'open') {
      status = 'conectado';
      qrAtual = '';
      tentativaReconexao = 0;
      conectandoWhatsApp = false;
      if (timerReconexao) {
        clearTimeout(timerReconexao);
        timerReconexao = null;
      }
      console.log('[WA] WhatsApp conectado');
    }

    if (connection === 'close') {
      conectandoWhatsApp = false;

      const erro = lastDisconnect?.error;
      const statusCode =
        erro?.output?.statusCode ||
        erro?.statusCode ||
        erro?.data?.statusCode ||
        null;
      const motivo =
        erro?.output?.payload?.message ||
        erro?.message ||
        erro?.data?.message ||
        'motivo não informado';
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const shouldReconnect = !loggedOut;

      status = shouldReconnect ? 'reconectando' : 'deslogado';

      console.error('[WA] Conexão fechada', {
        statusCode,
        motivo,
        loggedOut,
        shouldReconnect,
        erro: erro?.stack || String(erro || '')
      });

      if (loggedOut) {
        qrAtual = '';
        console.error('[WA] Sessão deslogada. É necessário gerar e escanear um novo QR.');
        return;
      }

      tentativaReconexao += 1;
      const atraso = Math.min(5000 * tentativaReconexao, 60000);

      if (timerReconexao) clearTimeout(timerReconexao);
      timerReconexao = setTimeout(() => {
        timerReconexao = null;
        conectarWhatsApp().catch(err => {
          conectandoWhatsApp = false;
          console.error('[WA] Falha ao reconectar:', err);
        });
      }, atraso);

      console.log('[WA] Nova tentativa em', atraso, 'ms');
    }`;

if (!codigo.includes(blocoAntigo)) {
  throw new Error('Não encontrei o bloco de connection.update esperado no server.js.');
}

codigo = codigo.replace(blocoAntigo, blocoNovo);

const finalAntigo = `  sock.ev.on('messages.update', async (updates) => {`;
const finalNovo = `  } catch (err) {
    conectandoWhatsApp = false;
    status = 'erro_conexao';
    console.error('[WA] Erro ao iniciar conexão:', err?.stack || err);
    if (timerReconexao) clearTimeout(timerReconexao);
    timerReconexao = setTimeout(() => {
      timerReconexao = null;
      conectarWhatsApp().catch(console.error);
    }, 15000);
    return;
  }

  sock.ev.on('messages.update', async (updates) => {`;

if (!codigo.includes(finalAntigo)) {
  throw new Error('Não encontrei o listener messages.update no server.js.');
}

codigo = codigo.replace(finalAntigo, finalNovo);

fs.writeFileSync(arquivo, codigo, 'utf8');
console.log('[PATCH] Correção do Baileys aplicada com sucesso.');
