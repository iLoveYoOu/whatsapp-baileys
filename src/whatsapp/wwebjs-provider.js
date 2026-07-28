const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

function localizarNavegador() {
  const candidatos = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ].filter(Boolean);

  return candidatos.find(arquivo => fs.existsSync(arquivo));
}

function jidParaWwebjs(jid) {
  const valor = String(jid || '');
  if (valor.endsWith('@g.us') || valor.endsWith('@c.us')) return valor;
  if (valor.endsWith('@s.whatsapp.net')) return valor.replace('@s.whatsapp.net', '@c.us');
  if (valor.endsWith('@lid')) {
    console.warn('[WWEBJS] JID @lid sem mapeamento direto:', valor);
    return valor;
  }
  return valor;
}

function jidParaBaileys(jid) {
  const valor = String(jid || '');
  if (valor.endsWith('@c.us')) return valor.replace('@c.us', '@s.whatsapp.net');
  return valor;
}

async function normalizarMensagem(msg) {
  const remoto = jidParaBaileys(msg.from || msg.to || '');
  const participante = jidParaBaileys(msg.author || '');
  const message = {};
  const possuiMidiaSuportada = msg.hasMedia && ['image', 'video', 'document'].includes(msg.type);

  if (possuiMidiaSuportada) {
    const legenda = msg.body || '';
    if (msg.type === 'image') message.imageMessage = { caption: legenda };
    else if (msg.type === 'video') message.videoMessage = { caption: legenda };
    else message.documentMessage = { caption: legenda };
  } else if (msg.hasQuotedMsg) {
    message.extendedTextMessage = { text: msg.body || '' };
  } else {
    message.conversation = msg.body || '';
  }

  if (msg.hasQuotedMsg) {
    try {
      const quoted = await msg.getQuotedMessage();
      const quotedMessage = quoted.hasMedia
        ? quoted.type === 'image'
          ? { imageMessage: { caption: quoted.body || '' } }
          : quoted.type === 'video'
            ? { videoMessage: { caption: quoted.body || '' } }
            : { documentMessage: { caption: quoted.body || '' } }
        : { conversation: quoted.body || '' };

      const tipo = Object.keys(message)[0];
      message[tipo].contextInfo = {
        stanzaId: quoted.id?._serialized || quoted.id?.id || '',
        participant: jidParaBaileys(quoted.author || quoted.from || ''),
        quotedMessage
      };
    } catch (erro) {
      console.warn('[WWEBJS] Não foi possível normalizar a mensagem citada:', erro.message);
    }
  }

  return {
    key: {
      remoteJid: remoto,
      participant: participante || undefined,
      id: msg.id?._serialized || msg.id?.id || '',
      fromMe: Boolean(msg.fromMe)
    },
    participant: participante || undefined,
    pushName: msg._data?.notifyName || msg._data?.pushname || '',
    message,
    _wwebjsRaw: msg
  };
}

function criarProvider(options = {}) {
  const emitter = new EventEmitter();
  const navegador = localizarNavegador();
  const dataPath = path.resolve(process.cwd(), '.wwebjs_auth');
  const lockPath = path.join(dataPath, '.bot-local.lock');
  let lockCriado = false;

  fs.mkdirSync(dataPath, { recursive: true });
  if (fs.existsSync(lockPath)) {
    const pidAnterior = Number(fs.readFileSync(lockPath, 'utf8'));
    let ativo = false;
    if (pidAnterior) {
      try {
        process.kill(pidAnterior, 0);
        ativo = true;
      } catch (_) {
        ativo = false;
      }
    }
    if (ativo) {
      throw new Error(`Outra instância do bot já está usando .wwebjs_auth (PID ${pidAnterior}).`);
    }
    fs.rmSync(lockPath, { force: true });
  }
  fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  lockCriado = true;

  const liberarLock = () => {
    if (!lockCriado) return;
    try {
      fs.rmSync(lockPath, { force: true });
    } catch (_) {}
    lockCriado = false;
  };

  process.once('exit', liberarLock);

  if (!navegador) {
    console.warn('[WWEBJS] Chrome/Edge não encontrado nos caminhos padrão.');
  } else {
    console.log('[WWEBJS] Navegador:', navegador);
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'bot-paliativo', dataPath }),
    puppeteer: {
      headless: options.headless ?? false,
      executablePath: navegador || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
  });

  client.on('qr', qr => emitter.emit('qr', qr));
  client.on('authenticated', () => emitter.emit('authenticated'));
  client.on('ready', () => emitter.emit('ready'));
  client.on('auth_failure', mensagem => emitter.emit('auth_failure', mensagem));
  client.on('disconnected', motivo => emitter.emit('disconnected', motivo));
  client.on('message', async raw => {
    try {
      emitter.emit('message', await normalizarMensagem(raw));
    } catch (erro) {
      emitter.emit('error', erro);
    }
  });

  async function sendMessage(jid, payload = {}, optionsEnvio = {}) {
    const destino = jidParaWwebjs(jid);
    const opcoes = {};

    const quotedId = optionsEnvio?.quoted?.key?.id;
    if (quotedId) opcoes.quotedMessageId = quotedId;

    let enviado;
    if (payload.text !== undefined) {
      enviado = await client.sendMessage(destino, String(payload.text), opcoes);
    } else {
      let buffer;
      let mimetype;
      let filename;
      const caption = payload.caption || '';

      if (payload.image) {
        buffer = payload.image;
        mimetype = payload.mimetype || 'image/png';
        filename = payload.fileName || 'imagem.png';
      } else if (payload.video) {
        buffer = payload.video;
        mimetype = payload.mimetype || 'video/mp4';
        filename = payload.fileName || 'video.mp4';
      } else if (payload.document) {
        buffer = payload.document;
        mimetype = payload.mimetype || 'application/octet-stream';
        filename = payload.fileName || 'documento.bin';
        opcoes.sendMediaAsDocument = true;
      } else {
        throw new Error('Payload não suportado pelo provider whatsapp-web.js');
      }

      if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
      const media = new MessageMedia(mimetype, buffer.toString('base64'), filename);
      enviado = await client.sendMessage(destino, media, { ...opcoes, caption });
    }

    return {
      key: {
        id: enviado?.id?._serialized || enviado?.id?.id || '',
        remoteJid: jidParaBaileys(enviado?.to || destino),
        fromMe: true
      },
      _wwebjsRaw: enviado
    };
  }

  async function groupMetadata(jid) {
    const chat = await client.getChatById(jidParaWwebjs(jid));
    const participants = Array.isArray(chat?.participants)
      ? chat.participants.map(p => ({
          id: jidParaBaileys(p.id?._serialized || p.id || ''),
          admin: p.isSuperAdmin ? 'superadmin' : p.isAdmin ? 'admin' : null
        }))
      : [];
    return { id: jidParaBaileys(chat?.id?._serialized || jid), subject: chat?.name || '', participants };
  }

  async function downloadMedia(rawMessage) {
    const media = await rawMessage.downloadMedia();
    if (!media?.data) throw new Error('Mídia não disponível no whatsapp-web.js');
    return Buffer.from(media.data, 'base64');
  }

  async function destroy() {
    try {
      await client.destroy();
    } finally {
      liberarLock();
    }
  }

  return {
    client,
    on: (evento, handler) => emitter.on(evento, handler),
    initialize: () => client.initialize(),
    destroy,
    sendMessage,
    groupMetadata,
    downloadMedia,
    jidParaWwebjs,
    jidParaBaileys
  };
}

module.exports = { criarProvider, localizarNavegador, jidParaWwebjs, jidParaBaileys, normalizarMensagem };
