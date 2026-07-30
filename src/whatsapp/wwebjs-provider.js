const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const {
  CLIENT_ID_PADRAO,
  analisarSessao,
  registrarDiagnosticoSessao,
  resolverDataPath,
  resolverQrMaxRetries
} = require('./wwebjs-auth-path');

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
  const clientId = String(process.env.WWEBJS_CLIENT_ID || CLIENT_ID_PADRAO).trim();
  const { dataPath, origem: origemDataPath } = resolverDataPath();
  fs.mkdirSync(dataPath, { recursive: true });
  registrarDiagnosticoSessao(analisarSessao({ dataPath, clientId }), origemDataPath);

  if (!navegador) {
    console.warn('[WWEBJS] Chrome/Edge não encontrado nos caminhos configurados.');
  } else {
    console.log('[WWEBJS] Navegador:', navegador);
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId, dataPath }),
    authTimeoutMs: Number(process.env.WWEBJS_AUTH_TIMEOUT_MS) || 120000,
    // Zero desativa o limite: o QR continua sendo renovado até a autenticação.
    qrMaxRetries: resolverQrMaxRetries(),
    puppeteer: {
      headless: options.headless ?? false,
      executablePath: navegador || undefined,
      protocolTimeout: Number(process.env.WWEBJS_PROTOCOL_TIMEOUT_MS) || 180000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
        '--disable-site-isolation-trials',
        '--renderer-process-limit=1',
        '--mute-audio'
      ]
    }
  });

  let syncRecoveryTimer = null;
  let syncRecoveryRunning = false;
  let clientReady = false;
  let messagePollingTimer = null;
  let messagePollingRunning = false;
  let messagePollingSince = Math.floor(Date.now() / 1000);
  const mensagensRecebidas = new Map();
  const cancelSyncRecovery = () => {
    if (syncRecoveryTimer) clearTimeout(syncRecoveryTimer);
    syncRecoveryTimer = null;
  };

  client.on('qr', qr => emitter.emit('qr', qr));
  client.on('authenticated', () => emitter.emit('authenticated'));
  client.on('ready', () => {
    clientReady = true;
    cancelSyncRecovery();
    iniciarPollingMensagens();
    emitter.emit('ready');
  });
  client.on('loading_screen', (percent, message) => {
    emitter.emit('loading_screen', percent, message);

    if (Number(percent) < 99 || syncRecoveryTimer || syncRecoveryRunning) return;
    syncRecoveryTimer = setTimeout(async () => {
      syncRecoveryTimer = null;
      syncRecoveryRunning = true;
      try {
        if (clientReady) return;
        console.warn('[WWEBJS] Sincronização parada em 99%; recuperando injeção parcial.');
        const syncAlreadyCompleted = await client.pupPage.evaluate(() => {
          const Socket = window.require('WAWebSocketModel').Socket;
          const connected = String(Socket.state || '').toUpperCase() === 'CONNECTED';
          if (Socket.hasSynced !== true && !connected) return false;

          try {
            delete window.WWebJS;
          } catch (_) {
            window.WWebJS = undefined;
          }
          window.onAppStateHasSyncedEvent();
          return true;
        });

        if (syncAlreadyCompleted) {
          console.log('[WWEBJS] Estado conectado confirmado; callback oficial de ready reativado.');
          return;
        }

        console.warn('[WWEBJS] hasSynced ainda falso; reinjetando módulos no mesmo navegador.');
        await client.inject();
        console.log('[WWEBJS] Reinjeção pós-sincronização concluída; aguardando ready.');
      } catch (error) {
        emitter.emit('error', error);
      } finally {
        syncRecoveryRunning = false;
      }
    }, Number(process.env.WWEBJS_SYNC_RECOVERY_MS) || 15000);
  });
  client.on('change_state', state => emitter.emit('change_state', state));
  client.on('auth_failure', mensagem => emitter.emit('auth_failure', mensagem));
  client.on('disconnected', motivo => {
    clientReady = false;
    cancelSyncRecovery();
    cancelarPollingMensagens();
    if (client._injectAbort) client._injectAbort.abort();
    emitter.emit('disconnected', motivo);
  });
  const encaminharMensagemRecebida = async (raw, evento) => {
    try {
      if (!raw || raw.fromMe) return;

      const id = raw.id?._serialized || raw.id?.id || '';
      const agora = Date.now();
      for (const [idAntigo, recebidoEm] of mensagensRecebidas) {
        if (agora - recebidoEm > 120000) mensagensRecebidas.delete(idAntigo);
      }
      if (id && mensagensRecebidas.has(id)) return;
      if (id) mensagensRecebidas.set(id, agora);

      console.log(
        `[WWEBJS] Mensagem recebida (${evento}): ${id || 'sem-id'} de ${raw.from || 'origem-desconhecida'}`
      );
      emitter.emit('message', await normalizarMensagem(raw));
    } catch (erro) {
      emitter.emit('error', erro);
    }
  };

  // Algumas versÃµes do WhatsApp Web deixam de emitir `message`, mas ainda
  // entregam a mensagem recebida por `message_create`. A deduplicaÃ§Ã£o evita
  // processar duas vezes quando os dois eventos funcionam normalmente.
  client.on('message', raw => encaminharMensagemRecebida(raw, 'message'));
  client.on('message_create', raw => encaminharMensagemRecebida(raw, 'message_create'));

  const cancelarPollingMensagens = () => {
    if (messagePollingTimer) clearTimeout(messagePollingTimer);
    messagePollingTimer = null;
    messagePollingRunning = false;
  };

  const executarPollingMensagens = async () => {
    if (!clientReady || messagePollingRunning || !client.pupPage) return;
    messagePollingRunning = true;
    try {
      const mensagens = await client.pupPage.evaluate(desde => {
        const colecao =
          window.Store?.Msg ||
          window.require?.('WAWebCollections')?.Msg;
        const modelos = colecao?.getModelsArray?.() || colecao?.models || [];
        return modelos
          .filter(msg => !msg?.id?.fromMe && Number(msg?.t || 0) >= desde)
          .map(msg => ({
            id: msg.id?._serialized || msg.id?.toString?.() || '',
            timestamp: Number(msg.t || 0)
          }))
          .filter(item => item.id)
          .sort((a, b) => a.timestamp - b.timestamp)
          .slice(-100);
      }, messagePollingSince);

      for (const item of mensagens) {
        messagePollingSince = Math.max(messagePollingSince, item.timestamp);
        if (mensagensRecebidas.has(item.id)) continue;
        const raw = await client.getMessageById(item.id);
        if (raw) await encaminharMensagemRecebida(raw, 'polling');
      }
    } catch (erro) {
      const mensagem = String(erro?.message || erro || '');
      if (!mensagem.includes('Execution context was destroyed')) {
        console.warn('[WWEBJS] Falha temporária ao consultar mensagens:', mensagem);
      }
    } finally {
      messagePollingRunning = false;
      if (clientReady) {
        messagePollingTimer = setTimeout(executarPollingMensagens, 2000);
      }
    }
  };

  function iniciarPollingMensagens() {
    cancelarPollingMensagens();
    messagePollingSince = Math.floor(Date.now() / 1000) - 10;
    console.log('[WWEBJS] Monitor complementar de mensagens ativado.');
    messagePollingTimer = setTimeout(executarPollingMensagens, 500);
  }

  async function initialize() {
    console.log('[WWEBJS] Inicialização do cliente...');
    try {
      await client.initialize();
    } catch (error) {
      const message = String(error?.message || error || '');
      const navigationRace =
        message.includes('Execution context was destroyed') ||
        message.includes('Cannot find context with specified id');
      if (!navigationRace) throw error;

      console.warn(
        '[WWEBJS] Navegação durante a injeção inicial; repetindo no mesmo navegador.'
      );

      let lastError = error;
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
        try {
          await client.inject();
          console.log(`[WWEBJS] Reinjeção ${attempt}/5 concluída.`);
          return;
        } catch (retryError) {
          lastError = retryError;
          const retryMessage = String(retryError?.message || retryError || '');
          const retryable =
            retryMessage.includes('Execution context was destroyed') ||
            retryMessage.includes('Cannot find context with specified id');
          if (!retryable) throw retryError;
          console.warn(`[WWEBJS] Reinjeção ${attempt}/5 interrompida por navegação.`);
        }
      }
      throw lastError;
    }
  }

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

  async function destroy({ timeoutMs = 10000 } = {}) {
    cancelSyncRecovery();
    cancelarPollingMensagens();
    if (client._injectAbort) client._injectAbort.abort();
    if (client.pupPage) client.pupPage.removeAllListeners('framenavigated');
    let timer;
    try {
      await Promise.race([
        client.destroy(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Tempo limite de ${timeoutMs} ms ao encerrar Chromium`)),
            timeoutMs
          );
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    client,
    on: (evento, handler) => emitter.on(evento, handler),
    initialize,
    destroy,
    sendMessage,
    groupMetadata,
    downloadMedia,
    jidParaWwebjs,
    jidParaBaileys
  };
}

module.exports = { criarProvider, localizarNavegador, jidParaWwebjs, jidParaBaileys, normalizarMensagem };
