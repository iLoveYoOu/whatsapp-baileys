const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

function localizarChrome() {
  const candidatos = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].filter(Boolean);
  return candidatos.find(arquivo => fs.existsSync(arquivo));
}

function jidParaWpp(jid) {
  return String(jid || '').replace('@s.whatsapp.net', '@c.us');
}

function jidParaBaileys(jid) {
  return String(jid?._serialized || jid || '').replace('@c.us', '@s.whatsapp.net');
}

function idSerializado(id) {
  return String(id?._serialized || id?.id || id || '');
}

function normalizarMensagem(raw) {
  const remoto = jidParaBaileys(raw.from || raw.chatId || raw.to);
  const participante = jidParaBaileys(raw.author || raw.sender?.id);
  const texto = raw.body || raw.caption || raw.content || '';
  const message = {};

  if (raw.type === 'image') message.imageMessage = { caption: texto };
  else if (raw.type === 'video') message.videoMessage = { caption: texto };
  else if (raw.type === 'document') message.documentMessage = { caption: texto };
  else if (raw.quotedMsgId) {
    message.extendedTextMessage = {
      text: texto,
      contextInfo: { stanzaId: idSerializado(raw.quotedMsgId) }
    };
  } else {
    message.conversation = texto;
  }

  return {
    key: {
      remoteJid: remoto,
      participant: participante || undefined,
      id: idSerializado(raw.id),
      fromMe: Boolean(raw.fromMe)
    },
    participant: participante || undefined,
    pushName: raw.notifyName || raw.sender?.pushname || raw.sender?.name || '',
    message,
    _wppRaw: raw
  };
}

function criarProvider(options = {}) {
  const emitter = new EventEmitter();
  const session = String(process.env.WPPCONNECT_SESSION || 'bot-render').trim();
  const persistentRoot = process.env.RENDER ? '/var/data' : process.cwd();
  const tokenPath = path.resolve(
    process.env.WPPCONNECT_TOKEN_PATH || path.join(persistentRoot, '.wppconnect_tokens')
  );
  const userDataDir = path.resolve(
    process.env.WPPCONNECT_USER_DATA_PATH || path.join(persistentRoot, '.wppconnect_user_data', session)
  );
  const executablePath = localizarChrome();
  let client = null;
  let initializing = false;
  let readyEmitted = false;
  let pollingTimer = null;
  let pollingRunning = false;
  const iniciadoEm = Math.floor(Date.now() / 1000);
  const mensagensProcessadas = new Map();

  fs.mkdirSync(tokenPath, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  async function initialize() {
    if (initializing || client) return;
    initializing = true;
    console.log('[WPPCONNECT] Sessão:', session);
    console.log('[WPPCONNECT] Tokens:', tokenPath);
    console.log('[WPPCONNECT] Perfil Chromium:', userDataDir);
    console.log('[WPPCONNECT] Navegador:', executablePath || 'gerenciado pela biblioteca');

    try {
      const wppconnect = require('@wppconnect-team/wppconnect');
      client = await wppconnect.create({
        session,
        tokenStore: 'file',
        folderNameToken: tokenPath,
        headless: options.headless ?? true,
        useChrome: Boolean(executablePath),
        logQR: false,
        updatesLog: false,
        disableWelcome: true,
        disableGoogleAnalytics: true,
        autoClose: 0,
        waitForLogin: true,
        browserArgs: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-extensions',
          '--renderer-process-limit=1',
          '--mute-audio'
        ],
        puppeteerOptions: {
          executablePath,
          userDataDir,
          protocolTimeout: Number(process.env.WPPCONNECT_PROTOCOL_TIMEOUT_MS) || 180000
        },
        catchQR: (_base64, _ascii, tentativas, urlCode) => {
          console.log(`[WPPCONNECT] QR atualizado (tentativa ${tentativas}).`);
          emitter.emit('qr', urlCode);
        },
        onLoadingScreen: (percentual, mensagem) => {
          emitter.emit('loading_screen', percentual, mensagem);
        },
        statusFind: status => {
          emitter.emit('change_state', status);
          if (status === 'qrReadSuccess') emitter.emit('authenticated');
          if (['browserClose', 'desconnectedMobile', 'serverClose'].includes(status)) {
            emitter.emit('disconnected', status);
          }
          if (['qrReadFail', 'deleteToken'].includes(status)) {
            emitter.emit('auth_failure', status);
          }
        }
      });

      const encaminharMensagem = (raw, origem) => {
        if (!raw || raw.fromMe) return;
        try {
          const timestamp = Number(raw?.t || raw?.timestamp || 0);
          if (timestamp && timestamp < iniciadoEm - 60) return;
          const msg = normalizarMensagem(raw);
          const id = msg.key.id;
          const agora = Date.now();
          for (const [idAntigo, recebidoEm] of mensagensProcessadas) {
            if (agora - recebidoEm > 10 * 60 * 1000) mensagensProcessadas.delete(idAntigo);
          }
          if (id && mensagensProcessadas.has(id)) return;
          if (id) mensagensProcessadas.set(id, agora);
          console.log(
            `[WPPCONNECT] Mensagem recebida (${origem}): ${msg.key.id || 'sem-id'} de ${msg.key.remoteJid}`
          );
          emitter.emit('message', msg);
        } catch (erro) {
          emitter.emit('error', erro);
        }
      };
      const confirmarReady = () => {
        if (readyEmitted || !socketConnected || !interfaceReady) return;
        readyEmitted = true;
        emitter.emit('ready');
      };
      let socketConnected = false;
      let interfaceReady = false;
      const consultarNaoLidas = async () => {
        if (!client || pollingRunning) return;
        pollingRunning = true;
        try {
          const mensagens = await client.getAllUnreadMessages();
          for (const raw of (mensagens || []).slice(-100)) {
            const timestamp = Number(raw?.t || raw?.timestamp || 0);
            if (timestamp && timestamp < iniciadoEm - 60) continue;
            encaminharMensagem(raw, 'não-lidas');
          }
        } catch (erro) {
          const mensagem = String(erro?.message || erro || '');
          if (!mensagem.includes('not connected')) {
            console.warn('[WPPCONNECT] Consulta de mensagens não lidas falhou:', mensagem);
          }
        } finally {
          pollingRunning = false;
        }
      };

      client.onMessage(raw => encaminharMensagem(raw, 'onMessage'));
      client.onAnyMessage(raw => encaminharMensagem(raw, 'onAnyMessage'));
      client.onStateChange(estado => {
        emitter.emit('change_state', estado);
        socketConnected = String(estado).toUpperCase() === 'CONNECTED';
        confirmarReady();
      });
      client.onInterfaceChange(interfaceState => {
        const mode = String(interfaceState?.mode || '').toUpperCase();
        const displayInfo = String(interfaceState?.displayInfo || '').toUpperCase();
        console.log(`[WPPCONNECT] Interface: ${mode} (${displayInfo})`);
        interfaceReady = mode === 'MAIN' && displayInfo === 'NORMAL';
        confirmarReady();
      });
      client.startPhoneWatchdog?.(30000);
      pollingTimer = setInterval(consultarNaoLidas, 2000);
      await consultarNaoLidas();
      emitter.emit('authenticated');
    } catch (erro) {
      client = null;
      emitter.emit('error', erro);
      throw erro;
    } finally {
      initializing = false;
    }
  }

  async function sendMessage(jid, payload = {}, optionsEnvio = {}) {
    if (!client) throw new Error('WPPConnect ainda não está pronto');
    const destino = jidParaWpp(jid);
    const quotedMsg = optionsEnvio?.quoted?.key?.id;
    const opcoes = quotedMsg ? { quotedMsg } : {};
    let enviado;

    if (payload.text !== undefined) {
      enviado = await client.sendText(destino, String(payload.text), opcoes);
    } else {
      const buffer = Buffer.isBuffer(payload.image || payload.video || payload.document)
        ? (payload.image || payload.video || payload.document)
        : Buffer.from(payload.image || payload.video || payload.document || '');
      const mime = payload.mimetype ||
        (payload.image ? 'image/png' : payload.video ? 'video/mp4' : 'application/octet-stream');
      const filename = payload.fileName ||
        (payload.image ? 'imagem.png' : payload.video ? 'video.mp4' : 'documento.bin');
      const base64 = `data:${mime};base64,${buffer.toString('base64')}`;

      enviado = await client.sendFile(destino, base64, {
        type: payload.image ? 'image' : payload.video ? 'video' : 'document',
        filename,
        mimetype: mime,
        caption: payload.caption || '',
        ...opcoes
      });
    }

    return {
      key: {
        id: idSerializado(enviado?.id || enviado),
        remoteJid: jidParaBaileys(destino),
        fromMe: true
      },
      _wppRaw: enviado
    };
  }

  async function groupMetadata(jid) {
    if (!client) throw new Error('WPPConnect ainda não está pronto');
    const grupoJid = jidParaWpp(jid);
    const [chat, membros, administradores] = await Promise.all([
      client.getChatById(grupoJid),
      client.getGroupMembers(grupoJid),
      client.getGroupAdmins(grupoJid)
    ]);
    const admins = new Set((administradores || []).map(idSerializado));
    return {
      id: jidParaBaileys(grupoJid),
      subject: chat?.name || chat?.formattedTitle || '',
      participants: (membros || []).map(membro => ({
        id: jidParaBaileys(membro.id || membro),
        admin: admins.has(idSerializado(membro.id || membro)) ? 'admin' : null
      }))
    };
  }

  async function groupFetchAllParticipating() {
    const grupos = await client.getAllGroups();
    return Object.fromEntries((grupos || []).map(grupo => [
      jidParaBaileys(grupo.id),
      {
        id: jidParaBaileys(grupo.id),
        subject: grupo.name || grupo.formattedTitle || ''
      }
    ]));
  }

  async function onWhatsApp(numero) {
    const resultado = await client.checkNumberStatus(jidParaWpp(numero));
    return [{ exists: Boolean(resultado?.canReceiveMessage ?? resultado?.numberExists), jid: jidParaBaileys(resultado?.id) }];
  }

  async function downloadMedia(raw) {
    const base64 = await client.downloadMedia(raw);
    const conteudo = String(base64 || '').replace(/^data:[^;]+;base64,/, '');
    return Buffer.from(conteudo, 'base64');
  }

  async function destroy() {
    if (pollingTimer) clearInterval(pollingTimer);
    pollingTimer = null;
    if (!client) return;
    client.stopPhoneWatchdog?.();
    await client.close();
    client = null;
  }

  return {
    on: (evento, handler) => emitter.on(evento, handler),
    initialize,
    destroy,
    sendMessage,
    groupMetadata,
    groupFetchAllParticipating,
    onWhatsApp,
    downloadMedia
  };
}

module.exports = {
  criarProvider,
  localizarChrome,
  jidParaWpp,
  jidParaBaileys,
  normalizarMensagem
};
