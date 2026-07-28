const fs = require('fs');
const path = require('path');

const arquivo = path.resolve(process.cwd(), 'server.js');
let codigo = fs.readFileSync(arquivo, 'utf8');

if (codigo.includes("const WHATSAPP_PROVIDER = String(process.env.WHATSAPP_PROVIDER")) {
  console.log('[MIGRAÇÃO] server.js já está preparado para WHATSAPP_PROVIDER.');
  process.exit(0);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.resolve(process.cwd(), 'backups-locais', `server-pre-wwebjs-${timestamp}.js`);
fs.mkdirSync(path.dirname(backup), { recursive: true });
fs.copyFileSync(arquivo, backup);
console.log('[MIGRAÇÃO] Backup:', backup);

const blocoBaileys = `const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  downloadContentFromMessage
} = require('@whiskeysockets/baileys');`;

if (!codigo.includes(blocoBaileys)) {
  throw new Error('Bloco de importação do Baileys não encontrado; nenhuma alteração foi gravada.');
}

codigo = codigo.replace(
  blocoBaileys,
  `${blocoBaileys}\n\nconst { criarProvider: criarWwebjsProvider } = require('./src/whatsapp/wwebjs-provider');\nconst WHATSAPP_PROVIDER = String(process.env.WHATSAPP_PROVIDER || 'baileys').toLowerCase();\nlet wwebjsProvider = null;`
);

const assinatura = 'async function conectarWhatsApp() {';
if (!codigo.includes(assinatura)) {
  throw new Error('Função conectarWhatsApp não encontrada; nenhuma alteração foi gravada.');
}
codigo = codigo.replace(assinatura, 'async function conectarWhatsAppBaileys() {');

const ancora = '\nfunction numeroPixBR(valor) {';
if (!codigo.includes(ancora)) {
  throw new Error('Âncora numeroPixBR não encontrada; nenhuma alteração foi gravada.');
}

const novoTransporte = `
async function processarMensagemEntrada(msg) {
  try {
    if (!msg?.message) return;

    const remetente = msg.key.remoteJid;
    const autorJid = autorDaMensagem(msg);
    const autorNome = nomeDaMensagem(msg, autorJid);
    const isAdmin = await mensagemDeAdmin(msg);
    const texto = textoDaMensagem(msg.message);
    const messageId = msg.key.id || '';

    const comandoProcessado = await entrarNaFila(() =>
      processarComandos(msg, texto, remetente, isAdmin, autorJid, autorNome)
    );
    if (comandoProcessado) return;

    const fotoProcessada = await entrarNaFila(() =>
      processarFotoOperador(msg, remetente)
    );
    if (fotoProcessada) return;

    if (msg.key.fromMe) return;
    if (!texto) return;

    if (ARTAUTO_ENABLED) {
      entrarNaFila(() => artautoProcessarMensagem(msg, texto, remetente, messageId));
    }

    await entrarNaFila(() => salvarNaPlanilha({ texto, messageId }));
  } catch (err) {
    console.error('[WHATSAPP] Erro ao processar mensagem:', err);
  }
}

async function conectarWhatsAppWwebjs() {
  await carregarBlacklistRemota();
  console.log('[WWEBJS] Inicializando com a sessão .wwebjs_auth existente...');
  status = 'inicializando_wwebjs';

  wwebjsProvider = criarWwebjsProvider({
    headless: String(process.env.WWEBJS_HEADLESS || 'false').toLowerCase() === 'true'
  });
  sock = wwebjsProvider;

  wwebjsProvider.on('qr', qr => {
    qrAtual = qr;
    status = 'aguardando_qr';
    console.log('[WWEBJS] QR disponível em /qr. A sessão existente não foi apagada.');
  });
  wwebjsProvider.on('authenticated', () => {
    status = 'autenticado';
    console.log('[WWEBJS] Sessão autenticada.');
  });
  wwebjsProvider.on('ready', () => {
    qrAtual = '';
    status = 'conectado';
    console.log('[WWEBJS] WhatsApp conectado e pronto.');
  });
  wwebjsProvider.on('disconnected', motivo => {
    status = 'desconectado';
    console.error('[WWEBJS] Desconectado:', motivo);
  });
  wwebjsProvider.on('auth_failure', motivo => {
    status = 'falha_autenticacao';
    console.error('[WWEBJS] Falha de autenticação:', motivo);
  });
  wwebjsProvider.on('error', erro => {
    status = 'erro_wwebjs';
    console.error('[WWEBJS] Erro:', erro);
  });
  wwebjsProvider.on('message', msg => processarMensagemEntrada(msg));

  await wwebjsProvider.initialize();
}

async function conectarWhatsApp() {
  console.log('[WHATSAPP] Provider selecionado:', WHATSAPP_PROVIDER);
  if (WHATSAPP_PROVIDER === 'wwebjs') {
    return conectarWhatsAppWwebjs();
  }
  return conectarWhatsAppBaileys();
}
`;

codigo = codigo.replace(ancora, `${novoTransporte}${ancora}`);

const downloadOriginal = 'const buffer = await baixarImagem(msg.message);';
if (!codigo.includes(downloadOriginal)) {
  throw new Error('Ponto de download de imagem não encontrado; nenhuma alteração foi gravada.');
}
codigo = codigo.replace(
  downloadOriginal,
  `const buffer = msg._wwebjsRaw && wwebjsProvider
    ? await wwebjsProvider.downloadMedia(msg._wwebjsRaw)
    : await baixarImagem(msg.message);`
);

fs.writeFileSync(arquivo, codigo, 'utf8');
console.log('[MIGRAÇÃO] server.js atualizado para provider selecionável.');
