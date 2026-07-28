const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = 3001;
const AUTH_DIR = path.resolve(process.cwd(), 'auth-local');
let qrAtual = '';
let status = 'iniciando';
let sock;

async function conectar() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    version: [2, 3000, 1032141294],
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Sheets Bot Local'),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    keepAliveIntervalMs: 30000
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrAtual = qr;
      status = 'aguardando_qr';
      console.log('\nQR gerado. Abra no navegador: http://localhost:3001/qr\n');
    }

    if (connection === 'open') {
      qrAtual = '';
      status = 'conectado';
      console.log('\n✅ WhatsApp conectado localmente.');
      console.log('A sessão foi salva em: ' + AUTH_DIR);
      console.log('Agora volte ao PowerShell para criar o pacote auth-local.zip.\n');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      status = code === DisconnectReason.loggedOut ? 'deslogado' : 'reconectando';
      console.error('[LOGIN LOCAL] Conexão fechada:', code, lastDisconnect?.error?.message || '');
      if (code !== DisconnectReason.loggedOut) setTimeout(conectar, 5000);
    }
  });
}

app.get('/', (req, res) => {
  res.send(`<h2>Login local WhatsApp</h2><p>Status: <b>${status}</b></p><p><a href="/qr">Abrir QR Code</a></p>`);
});

app.get('/qr', async (req, res) => {
  if (!qrAtual) return res.send(`<h3>Status: ${status}</h3><p>Nenhum QR disponível.</p>`);
  const img = await QRCode.toDataURL(qrAtual);
  res.send(`<h2>Escaneie no WhatsApp</h2><img src="${img}" style="width:360px;height:360px"><p>WhatsApp → Aparelhos conectados → Conectar aparelho</p>`);
});

app.listen(PORT, () => {
  console.log('Servidor de login local: http://localhost:' + PORT);
  conectar().catch(err => {
    console.error('Falha ao iniciar login local:', err);
    process.exitCode = 1;
  });
});
