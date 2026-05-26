require('dotenv').config();

const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const { google } = require('googleapis');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  downloadContentFromMessage
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json({ limit: '20mb' }));

const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

let sock = null;
let qrAtual = '';
let status = 'iniciando';

/* FILA ANTI-SOBRESCRITA */
let fila = Promise.resolve();

function entrarNaFila(tarefa) {
  fila = fila.then(tarefa).catch(err => {
    console.error('Erro na fila:', err);
  });

  return fila;
}

/* FILA DE OPERADORES */
let operadoresOnline = [];
let indiceOperador = 0;
let totalLeadsEnviados = 0;

const leadsPorMensagemOriginal = new Map();
const leadsPorMensagemOperador = new Map();

function operadorNome(jid) {
  const index = operadoresOnline.indexOf(jid);
  return index >= 0 ? `Operador ${index + 1}` : 'Operador';
}

function normalizarNumero(txt) {
  return String(txt || '').replace(/\D/g, '');
}

function isComandoValor(texto) {
  return /^\/\d+([.,]\d{1,2})?$/.test(String(texto || '').trim());
}

function valorDoComando(texto) {
  return String(texto || '').trim().replace('/', '').replace(',', '.');
}

function textoDaMensagem(message) {
  if (!message) return '';

  const type = getContentType(message);

  if (type === 'conversation') return message.conversation || '';
  if (type === 'extendedTextMessage') return message.extendedTextMessage?.text || '';
  if (type === 'imageMessage') return message.imageMessage?.caption || '';
  if (type === 'videoMessage') return message.videoMessage?.caption || '';
  if (type === 'documentMessage') return message.documentMessage?.caption || '';

  return '';
}

function getQuotedInfo(message) {
  const type = getContentType(message);
  const msg = message?.[type];
  const ctx = msg?.contextInfo;

  return {
    stanzaId: ctx?.stanzaId || '',
    participant: ctx?.participant || '',
    quotedMessage: ctx?.quotedMessage || null
  };
}

function textoDaQuotedMessage(quotedMessage) {
  if (!quotedMessage) return '';

  if (quotedMessage.conversation) return quotedMessage.conversation || '';
  if (quotedMessage.extendedTextMessage) return quotedMessage.extendedTextMessage.text || '';
  if (quotedMessage.imageMessage) return quotedMessage.imageMessage.caption || '';
  if (quotedMessage.videoMessage) return quotedMessage.videoMessage.caption || '';
  if (quotedMessage.documentMessage) return quotedMessage.documentMessage.caption || '';

  return '';
}

async function baixarImagem(message) {
  const stream = await downloadContentFromMessage(message.imageMessage, 'image');
  let buffer = Buffer.from([]);

  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
  }

  return buffer;
}

/* TABELA BASE */
const lucroTabela = {
  300: 60, 350: 60, 400: 60, 450: 60, 500: 60,
  550: 70, 600: 80, 650: 90, 700: 90, 750: 100,
  800: 100, 850: 110, 900: 110, 950: 120, 1000: 120,
  1050: 125, 1100: 130, 1150: 135, 1200: 140,
  1250: 145, 1300: 150, 1350: 155, 1400: 160,
  1450: 165, 1500: 170, 1600: 190, 1650: 195,
  1700: 200, 1750: 205, 1800: 210, 1850: 215,
  1900: 220, 1950: 225, 2000: 240, 2050: 245,
  2100: 250, 2150: 255, 2200: 260, 2250: 265,
  2300: 270, 2350: 275, 2400: 280, 2450: 285,
  2500: 290, 2600: 310, 2650: 315, 2700: 320,
  2750: 325, 2800: 330, 2850: 335, 2900: 340,
  2950: 345, 3000: 360
};

function calcularLucro(deposito) {
  const valores = Object.keys(lucroTabela)
    .map(Number)
    .sort((a, b) => a - b);

  let lucro = 0;

  for (const valor of valores) {
    if (deposito >= valor) {
      lucro = lucroTabela[valor];
    }
  }

  return lucro;
}

function hojeBR() {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit'
  }).format(new Date());
}

function extrair(texto, regex) {
  const m = String(texto || '').match(regex);
  return m ? String(m[1]).trim() : '';
}

function dividirBlocos(texto) {
  const partes = String(texto || '')
    .split(/(?=pix\s*:|cpf\s*:|ret\s*:)/i)
    .map(p => p.trim())
    .filter(p => /ret\s*:|dep\s*:|plat\s*:/i.test(p));

  return partes.length ? partes : [String(texto || '')];
}

function authSheets() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY;

  if (!email || !key) {
    throw new Error('Configure GOOGLE_SERVICE_ACCOUNT_EMAIL e GOOGLE_PRIVATE_KEY');
  }

  key = key.replace(/\\n/g, '\n');

  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  return google.sheets({
    version: 'v4',
    auth
  });
}

async function garantirAba(sheets, aba) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID
  });

  const existe = meta.data.sheets.some(
    s => s.properties.title === aba
  );

  if (!existe) {
    throw new Error(`Aba não encontrada: ${aba}`);
  }
}

async function ocultarColunaH(sheets, aba) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID
  });

  const sheetInfo = meta.data.sheets.find(
    s => s.properties.title === aba
  );

  if (!sheetInfo) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        {
          updateDimensionProperties: {
            range: {
              sheetId: sheetInfo.properties.sheetId,
              dimension: 'COLUMNS',
              startIndex: 7,
              endIndex: 8
            },
            properties: {
              hiddenByUser: true
            },
            fields: 'hiddenByUser'
          }
        }
      ]
    }
  });
}

async function proximaLinhaColunaB(sheets, aba) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${aba}'!A2:B200`
  });

  const rows = resp.data.values || [];

  for (let i = 0; i < rows.length; i++) {
    const colunaA = String(rows[i][0] || '').trim().toLowerCase();
    const colunaB = String(rows[i][1] || '').trim();

    if (colunaA.includes('total')) break;

    if (!colunaB) return i + 2;
  }

  throw new Error('Não encontrei linha vazia antes do TOTAL.');
}

async function salvarNaPlanilha({ texto, messageId }) {
  const sheets = authSheets();
  const aba = hojeBR();

  await garantirAba(sheets, aba);
  await ocultarColunaH(sheets, aba);

  const blocos = dividirBlocos(texto);
  let salvos = 0;

  for (let i = 0; i < blocos.length; i++) {
    const bloco = blocos[i];

    const deposito = Number(extrair(bloco, /dep\s*:\s*(\d+)/i));
    const sacado = Number(extrair(bloco, /ret\s*:\s*(\d+)/i));
    const casa = extrair(bloco, /plat\s*:\s*(.+)/i);

    if (!deposito || !sacado || !casa) continue;

    const lucro = calcularLucro(deposito);

    const faixaBase =
      Math.floor((deposito - 500) / 50) * 50 + 500;

    const banca =
      faixaBase > 0
        ? faixaBase - lucro
        : deposito - lucro;

    const idFinal =
      `${messageId || 'semid'}_${i}_${Date.now()}_${Math.floor(Math.random() * 999999)}`;

    const linha = await proximaLinhaColunaB(sheets, aba);

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${aba}'!B${linha}:H${linha}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          deposito,
          sacado,
          casa,
          banca,
          lucro,
          aba,
          idFinal
        ]]
      }
    });

    salvos++;

    console.log('SALVO NOVA LINHA:', {
      linha,
      deposito,
      sacado,
      casa,
      banca,
      lucro,
      aba,
      idFinal
    });
  }

  return salvos;
}

async function apagarDaPlanilha(messageId) {
  if (!messageId) return false;

  const sheets = authSheets();
  const aba = hojeBR();

  await garantirAba(sheets, aba);

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID
  });

  const sheetInfo = meta.data.sheets.find(
    s => s.properties.title === aba
  );

  if (!sheetInfo) return false;

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${aba}'!H2:H`
  });

  const rows = resp.data.values || [];
  const linhas = [];

  for (let i = 0; i < rows.length; i++) {
    const val = String(rows[i][0] || '');

    if (val.includes(messageId)) {
      linhas.push(i + 2);
    }
  }

  linhas.sort((a, b) => b - a);

  for (const linha of linhas) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: sheetInfo.properties.sheetId,
                dimension: 'ROWS',
                startIndex: linha - 1,
                endIndex: linha
              }
            }
          }
        ]
      }
    });
  }

  return linhas.length > 0;
}

async function processarComandos(msg, texto, remetente, isAdmin) {
  const comando = String(texto || '').trim().toLowerCase();

  if (comando === '/opon') {
    if (!operadoresOnline.includes(remetente)) {
      operadoresOnline.push(remetente);
    }

    await sock.sendMessage(remetente, {
      text: '✅ Status atualizado: online'
    });

    return true;
  }

  if (comando === '/opoff') {
    operadoresOnline = operadoresOnline.filter(op => op !== remetente);

    if (indiceOperador >= operadoresOnline.length) {
      indiceOperador = 0;
    }

    await sock.sendMessage(remetente, {
      text: '⛔ Status atualizado: offline'
    });

    return true;
  }

  if (!isAdmin) {
    return false;
  }

  if (comando === '/fila') {
    const lista = operadoresOnline.length
      ? operadoresOnline.map((op, i) => `${i + 1}. Operador ${i + 1}`).join('\n')
      : 'Nenhum operador online.';

    await sock.sendMessage(remetente, {
      text: `📋 Operadores online:\n\n${lista}`
    });

    return true;
  }

  if (comando === '/clearfila') {
    operadoresOnline = [];
    indiceOperador = 0;

    await sock.sendMessage(remetente, {
      text: '🧹 Fila limpa com sucesso.'
    });

    return true;
  }

  if (comando.startsWith('/kickop')) {
    const arg = comando.replace('/kickop', '').trim();

    if (!arg) {
      await sock.sendMessage(remetente, {
        text: 'Use: /kickop 1'
      });
      return true;
    }

    const numero = Number(arg);

    if (!numero || numero < 1 || numero > operadoresOnline.length) {
      await sock.sendMessage(remetente, {
        text: 'Operador não encontrado.'
      });
      return true;
    }

    operadoresOnline.splice(numero - 1, 1);

    if (indiceOperador >= operadoresOnline.length) {
      indiceOperador = 0;
    }

    await sock.sendMessage(remetente, {
      text: `⛔ Operador ${numero} removido da fila.`
    });

    return true;
  }

  if (comando === '/stats') {
    const proximo = operadoresOnline.length
      ? `Operador ${indiceOperador + 1}`
      : 'Nenhum';

    await sock.sendMessage(remetente, {
      text:
`📊 Estatísticas

Leads enviados hoje: ${totalLeadsEnviados}
Operadores online: ${operadoresOnline.length}
Próximo da fila: ${proximo}`
    });

    return true;
  }

  if (comando === '/reset') {
    operadoresOnline = [];
    indiceOperador = 0;
    totalLeadsEnviados = 0;
    leadsPorMensagemOriginal.clear();
    leadsPorMensagemOperador.clear();

    await sock.sendMessage(remetente, {
      text:
`♻️ Sistema resetado

Fila zerada
Índice reiniciado
Leads temporários limpos`
    });

    return true;
  }

  if (comando === '/next') {
    if (!operadoresOnline.length) {
      await sock.sendMessage(remetente, {
        text: '⚠️ Nenhum operador online.'
      });
      return true;
    }

    const quoted = getQuotedInfo(msg.message);

    if (!quoted.stanzaId) {
      await sock.sendMessage(remetente, {
        text: '⚠️ Responda a mensagem do cliente com /next.'
      });
      return true;
    }

    const textoLead = textoDaQuotedMessage(quoted.quotedMessage);

    if (!textoLead) {
      await sock.sendMessage(remetente, {
        text: '⚠️ Não consegui ler o lead respondido.'
      });
      return true;
    }

    const operador = operadoresOnline[indiceOperador];
    const nomeOperador = operadorNome(operador);

    indiceOperador = (indiceOperador + 1) % operadoresOnline.length;
    totalLeadsEnviados++;

    const envio = await sock.sendMessage(operador, {
      text:
`📥 Novo lead

${textoLead}

Responda esta mensagem com FOTO.
Limite: 2 fotos.`
    });

    const lead = {
      originalMessageId: quoted.stanzaId,
      clienteJid: msg.key.remoteJid,
      operadorJid: operador,
      operadorNome: nomeOperador,
      textoLead,
      fotosEnviadas: 0,
      operadorMsgId: envio.key.id
    };

    leadsPorMensagemOriginal.set(quoted.stanzaId, lead);
    leadsPorMensagemOperador.set(envio.key.id, lead);

    await sock.sendMessage(remetente, {
      text: `✅ Lead enviado para ${nomeOperador}`
    });

    return true;
  }

  if (isComandoValor(comando)) {
    const quoted = getQuotedInfo(msg.message);

    if (!quoted.stanzaId) {
      await sock.sendMessage(remetente, {
        text: '⚠️ Responda o lead original com o valor. Ex: /500'
      });
      return true;
    }

    const lead = leadsPorMensagemOriginal.get(quoted.stanzaId);

    if (!lead) {
      await sock.sendMessage(remetente, {
        text: '⚠️ Este lead ainda não foi distribuído com /next.'
      });
      return true;
    }

    const valor = valorDoComando(comando);

    await sock.sendMessage(lead.operadorJid, {
      text: `💰 Valor fechado: R$ ${valor}`
    });

    await sock.sendMessage(remetente, {
      text: `💰 Valor enviado para ${lead.operadorNome}`
    });

    return true;
  }

  return false;
}

async function processarFotoOperador(msg, remetente) {
  const type = getContentType(msg.message);

  if (type !== 'imageMessage') return false;

  const quoted = getQuotedInfo(msg.message);

  if (!quoted.stanzaId) return false;

  const lead = leadsPorMensagemOperador.get(quoted.stanzaId);

  if (!lead) return false;

  if (lead.operadorJid !== remetente) {
    await sock.sendMessage(remetente, {
      text: '⚠️ Este lead não está vinculado a você.'
    });
    return true;
  }

  if (lead.fotosEnviadas >= 2) {
    await sock.sendMessage(remetente, {
      text: '⛔ Limite de 2 fotos atingido para este lead.'
    });
    return true;
  }

  const buffer = await baixarImagem(msg.message);

  await sock.sendMessage(lead.clienteJid, {
    image: buffer
  });

  lead.fotosEnviadas++;

  await sock.sendMessage(remetente, {
    text: `✅ Foto enviada ao cliente. (${lead.fotosEnviadas}/2)`
  });

  return true;
}

async function conectarWhatsApp() {
  const { state, saveCreds } =
    await useMultiFileAuthState('./auth');

  const { version } =
    await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Sheets Bot', 'Chrome', '1.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    keepAliveIntervalMs: 30000
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const {
      connection,
      lastDisconnect,
      qr
    } = update;

    if (qr) {
      qrAtual = qr;
      status = 'aguardando_qr';
      console.log('QR disponível em /qr');
    }

    if (connection === 'open') {
      status = 'conectado';
      qrAtual = '';
      console.log('WhatsApp conectado');
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;

      status = shouldReconnect
        ? 'reconectando'
        : 'deslogado';

      console.log(
        'Conexão fechada. Reconectar:',
        shouldReconnect
      );

      if (shouldReconnect) {
        setTimeout(() => conectarWhatsApp(), 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        if (!msg.message) continue;

        const remetente = msg.key.remoteJid;
        const isAdmin = msg.key.fromMe;

        const texto = textoDaMensagem(msg.message);
        const messageId = msg.key.id || '';

        const comandoProcessado = await entrarNaFila(() =>
          processarComandos(msg, texto, remetente, isAdmin)
        );

        if (comandoProcessado) continue;

        const fotoProcessada = await entrarNaFila(() =>
          processarFotoOperador(msg, remetente)
        );

        if (fotoProcessada) continue;

        if (isAdmin) continue;

        if (!texto) continue;

        await entrarNaFila(() =>
          salvarNaPlanilha({
            texto,
            messageId
          })
        );
      } catch (err) {
        console.error(
          'Erro ao processar mensagem:',
          err
        );
      }
    }
  });

  sock.ev.on('messages.update', async (updates) => {
    for (const update of updates) {
      try {
        const id = update.key?.id;

        if (
          update.update?.message === null ||
          update.update?.messageStubType
        ) {
          const ok = await entrarNaFila(() =>
            apagarDaPlanilha(id)
          );

          console.log('Mensagem apagada:', id, ok);
          continue;
        }

        const textoEditado = textoDaMensagem(update.update?.message);

        if (textoEditado && id) {
          await entrarNaFila(async () => {
            await apagarDaPlanilha(id);

            const salvos = await salvarNaPlanilha({
              texto: textoEditado,
              messageId: id
            });

            console.log(
              'Mensagem editada atualizada:',
              id,
              salvos
            );
          });
        }
      } catch (err) {
        console.error('Erro em messages.update:', err);
      }
    }
  });
}

app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

app.get('/', (req, res) => {
  res.send(`
    <h2>WhatsApp → Google Sheets</h2>
    <p>Status: <b>${status}</b></p>
    <p><a href="/qr">Abrir QR Code</a></p>
  `);
});

app.get('/status', (req, res) => {
  res.json({
    status,
    qr: Boolean(qrAtual),
    operadoresOnline: operadoresOnline.length,
    leadsEnviados: totalLeadsEnviados
  });
});

app.get('/qr', async (req, res) => {
  if (!qrAtual) {
    return res.send(`
      <h3>Status: ${status}</h3>
      <p>Nenhum QR disponível</p>
    `);
  }

  const img = await QRCode.toDataURL(qrAtual);

  res.send(`
    <h2>Escaneie o QR</h2>
    <img src="${img}" style="width:320px;height:320px" />
  `);
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  conectarWhatsApp();
});