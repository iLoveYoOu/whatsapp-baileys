const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = Number(process.env.WWEBJS_PORT || 3002);
const app = express();
let qrAtual = '';
let status = 'iniciando';
let encerrando = false;

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'bot-paliativo',
    dataPath: path.resolve(process.cwd(), '.wwebjs_auth')
  }),
  puppeteer: {
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', (qr) => {
  qrAtual = qr;
  status = 'aguardando_qr';
  console.log('\n[WWEBJS] QR gerado. Abra: http://localhost:' + PORT + '/qr\n');
});

client.on('authenticated', () => {
  status = 'autenticado';
  console.log('[WWEBJS] Sessão autenticada.');
});

client.on('ready', () => {
  qrAtual = '';
  status = 'conectado';
  console.log('\n[WWEBJS] WhatsApp conectado e pronto.\n');
});

client.on('auth_failure', (mensagem) => {
  status = 'falha_autenticacao';
  console.error('[WWEBJS] Falha de autenticação:', mensagem);
});

client.on('disconnected', (motivo) => {
  status = 'desconectado';
  console.error('[WWEBJS] Desconectado:', motivo);
});

client.on('message', async (msg) => {
  if (msg.body.trim().toLowerCase() === '/teste') {
    await msg.reply('✅ Teste whatsapp-web.js funcionando.');
  }
});

app.get('/', (req, res) => {
  res.send(`<h2>Teste paliativo whatsapp-web.js</h2><p>Status: <b>${status}</b></p><p><a href="/qr">Abrir QR Code</a></p>`);
});

app.get('/qr', async (req, res) => {
  if (!qrAtual) {
    return res.send(`<h3>Status: ${status}</h3><p>Nenhum QR disponível.</p>`);
  }

  try {
    const imagem = await QRCode.toDataURL(qrAtual);
    return res.send(`<h2>Escaneie no WhatsApp</h2><img src="${imagem}" style="width:360px;height:360px"><p>WhatsApp → Aparelhos conectados → Conectar aparelho</p>`);
  } catch (erro) {
    console.error('[WWEBJS] Erro ao gerar imagem do QR:', erro);
    return res.status(500).send('Erro ao gerar QR Code.');
  }
});

const servidor = app.listen(PORT, () => {
  console.log('Servidor paliativo local: http://localhost:' + PORT);
  client.initialize().catch((erro) => {
    status = 'erro_inicializacao';
    console.error('[WWEBJS] Falha ao iniciar:', erro);
  });
});

async function encerrar() {
  if (encerrando) return;
  encerrando = true;
  console.log('\n[WWEBJS] Encerrando...');

  servidor.close();
  try {
    await client.destroy();
  } catch (erro) {
    console.error('[WWEBJS] Erro ao encerrar cliente:', erro.message);
  }
  process.exit(0);
}

process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
