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
  getContentType
} = require('@whiskeysockets/baileys');

const app = express();

app.use(express.json({ limit: '20mb' }));

const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

let sock = null;
let qrAtual = '';
let status = 'iniciando';

const lucroTabela = {
  300: 60,
301: 100,
  350: 60,
  400: 60,
401: 120,
  450: 60,
  500: 60,
501: 140,
  550: 70,
  600: 80,
601: 170,
  650: 90,
  700: 90,
701: 200,
  750: 100,
  800: 100,
801: 230,
  850: 110,
  900: 110,
901: 260,
  950: 120,
  1000: 120,
1001: 280,
  1050: 125,
  1100: 130,
  1150: 135,
  1200: 140,
  1250: 145,
  1300: 150,
  1350: 155,
  1400: 160,
  1450: 165,
  1500: 170,
  1600: 190,
  1650: 195,
  1700: 200,
  1750: 205,
  1800: 210,
  1850: 215,
  1900: 220,
  1950: 225,
  2000: 240,
  2050: 245,
  2100: 250,
  2150: 255,
  2200: 260,
  2250: 265,
  2300: 270,
  2350: 275,
  2400: 280,
  2450: 285,
  2500: 290,
  2600: 310,
  2650: 315,
  2700: 320,
  2750: 325,
  2800: 330,
  2850: 335,
  2900: 340,
  2950: 345,
  3000: 360
};

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
    throw new Error(`Aba nÃ£o encontrada: ${aba}`);
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

async function salvarNaPlanilha({ texto, messageId }) {
  const sheets = authSheets();

  const aba = hojeBR();

  await garantirAba(sheets, aba);
  await ocultarColunaH(sheets, aba);

  const blocos = dividirBlocos(texto);

  let salvos = 0;

  for (let i = 0; i < blocos.length; i++) {
    const bloco = blocos[i];

    const deposito = Number(
      extrair(bloco, /dep\s*:\s*(\d+)/i)
    );

    const sacado = Number(
      extrair(bloco, /ret\s*:\s*(\d+)/i)
    );

    const casa = extrair(
      bloco,
      /plat\s*:\s*(.+)/i
    );

    if (!deposito || !sacado || !casa) continue;

    const lucroEspecial = {
  301: 100,
  401: 120,
  501: 140,
  601: 170,
  701: 200,
  801: 230,
  901: 260,
  1001: 280
};

const bancaEspecial = {
  301: 200,
  401: 280,
  501: 360,
  601: 430,
  701: 500,
  801: 570,
  901: 640,
  1001: 720
};

const lucro = lucroEspecial[deposito] || lucroTabela[deposito] || 0;

    const banca = bancaEspecial[deposito] || (deposito - lucro);

    const idFinal = `${messageId || 'semid'}_${i}_${Date.now()}`;

    // SEMPRE CRIA NOVA LINHA
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${aba}'!B:H`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
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

    console.log('SALVO:', {
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
    browser: ['Sheets Bot', 'Chrome', '1.0']
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
      console.log('QR disponÃ­vel');
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

      console.log('Reconectar:', shouldReconnect);

      if (shouldReconnect) {
        conectarWhatsApp();
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        if (!msg.message) continue;

        if (msg.key.fromMe) continue;

        const texto = textoDaMensagem(msg.message);

        const messageId = msg.key.id || '';

        if (!texto) continue;

        const salvos = await salvarNaPlanilha({
          texto,
          messageId
        });

        console.log(
          `Mensagem processada. ${salvos} linhas salvas`
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
          const ok = await apagarDaPlanilha(id);

          console.log(
            'Mensagem apagada:',
            id,
            ok
          );
        }
      } catch (err) {
        console.error(
          'Erro em messages.update:',
          err
        );
      }
    }
  });
}

app.get('/', (req, res) => {
  res.send(`
    <h2>WhatsApp â†’ Google Sheets</h2>
    <p>Status: <b>${status}</b></p>
    <p><a href="/qr">Abrir QR Code</a></p>
  `);
});

app.get('/status', (req, res) => {
  res.json({
    status,
    qr: Boolean(qrAtual)
  });
});

app.get('/qr', async (req, res) => {
  if (!qrAtual) {
    return res.send(`
      <h3>Status: ${status}</h3>
      <p>Nenhum QR disponÃ­vel</p>
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

