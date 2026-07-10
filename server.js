
require('dotenv').config();
const fs = require('fs');
const https = require('https');
const axios = require('axios');
const crypto = require('crypto');

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
const MP_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN;
const CORA_CLIENT_ID = String(process.env.CORA_CLIENT_ID || '').trim();
const CORA_CERT_PATH = process.env.CORA_CERT_PATH || './certs/certificate.pem';
const CORA_KEY_PATH = process.env.CORA_KEY_PATH || './certs/private-key.key';

let sock = null;
let qrAtual = '';
let status = 'iniciando';

let fila = Promise.resolve();

function entrarNaFila(tarefa) {
  fila = fila.then(tarefa).catch(err => {
    console.error('Erro na fila:', err);
  });
  return fila;
}

let operadoresOnline = [];
let indiceOperador = 0;
let totalBancasEnviadas = 0;
let totalPixGerados = 0;
let totalPixPagos = 0;

const DESTINOS_PIX = {
  arthur: '5511961501252@s.whatsapp.net',
  lucao: '120363426172706411@g.us',
  gordao: '5524999205460@s.whatsapp.net'
};

const historicoPixRecebidos = [];

const bancasPorMensagemOriginal = new Map();
const bancasPorMensagemOperador = new Map();
const pagamentosPendentes = new Map();
const bancasPagasPendentes = [];

const MSG_DEPOSITO_CONFIRMADO =
`✅ DEU CERTO! DEPÓSITO CONFIRMADO!

⚠️ ATENÇÃO - MUITO IMPORTANTE!

Meu número de atendimento pode cair a qualquer momento!

Se a mensagem NÃO CHEGAR, não fique sem resposta!

📲 CHAMA DIRETO NO NÚMERO RESERVA:
48 98425-5049

🕐 Horário de atendimento:
Todos os dias das 09:00 às 00:30

🙏 Obrigado pela confiança!

Att: Equipe Meia do Lucão`;

function operadorNome(jid) {
  const index = operadoresOnline.indexOf(jid);
  return index >= 0 ? `Operador ${index + 1}` : 'Operador';
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


/* BLACKLIST PIX */
const fsBlacklist = require('fs');

const BLACKLIST_PATH = `${__dirname}/blacklist.json`;

function normalizarNomeBlacklist(nome) {
  return String(nome || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function carregarBlacklist() {
  try {
    if (!fsBlacklist.existsSync(BLACKLIST_PATH)) {
      fsBlacklist.writeFileSync(BLACKLIST_PATH, '[]', 'utf8');
      return [];
    }

    const conteudo = fsBlacklist.readFileSync(BLACKLIST_PATH, 'utf8');
    const lista = JSON.parse(conteudo || '[]');

    return Array.isArray(lista) ? lista : [];
  } catch (err) {
    console.error('Erro ao carregar blacklist:', err);
    return [];
  }
}

function salvarBlacklist(lista) {
  fsBlacklist.writeFileSync(
    BLACKLIST_PATH,
    JSON.stringify(lista, null, 2),
    'utf8'
  );
}

function extrairNomePix(texto) {
  const match = String(texto || '').match(/👤\s*(.+)/i);
  return match ? String(match[1]).trim() : '';
}

function buscarNaBlacklist(nome) {
  const nomeNormalizado = normalizarNomeBlacklist(nome);

  return carregarBlacklist().find(
    item => normalizarNomeBlacklist(item.nome) === nomeNormalizado
  );
}

async function baixarImagem(message) {
  const stream = await downloadContentFromMessage(message.imageMessage, 'image');
  let buffer = Buffer.from([]);

  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
  }

  return buffer;
}
/* CORA API */
function lerPem(valorEnv, caminhoArquivo) {
  if (valorEnv) return String(valorEnv).replace(/\\n/g, '\n');
  return fs.readFileSync(caminhoArquivo);
}

function criarCoraAgent() {
  return new https.Agent({
    cert: lerPem(process.env.CORA_CERT_PEM, CORA_CERT_PATH),
    key: lerPem(process.env.CORA_KEY_PEM, CORA_KEY_PATH),
    rejectUnauthorized: true
  });
}
async function obterTokenCora() {
  if (!CORA_CLIENT_ID) {
    throw new Error('CORA_CLIENT_ID não configurado.');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CORA_CLIENT_ID
  });

  const resp = await axios.post(
    'https://matls-clients.api.cora.com.br/token',
    body.toString(),
    {
      httpsAgent: criarCoraAgent(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      timeout: 30000
    }
  );

  return resp.data.access_token;
}

async function consultarFaturaCora(invoiceId) {
  const token = await obterTokenCora();

  const resp = await axios.get(
    `https://matls-clients.api.cora.com.br/v2/invoices/${invoiceId}`,
    {
      httpsAgent: criarCoraAgent(),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      },
      timeout: 30000
    }
  );

  return resp.data;
}

async function gerarPixCora(valor) {
  const token = await obterTokenCora();

  const valorCentavos = Math.round(Number(valor) * 100);

  if (!valorCentavos || valorCentavos < 500) {
    throw new Error('Valor mínimo da Cora é R$ 5,00.');
  }

  const vencimento = new Date();
  vencimento.setDate(vencimento.getDate() + 1);

  const payload = {
    code: `pixcora-${Date.now()}`,
    customer: {
      name: 'Cliente Pix Cora',
      email: 'cliente@teste.com',
      document: {
        identity: '12345678909',
        type: 'CPF'
      },
      address: {
        street: 'Rua Teste',
        number: '123',
        district: 'Centro',
        city: 'Praia Grande',
        state: 'SP',
        complement: '',
        zip_code: '11700000'
      }
    },
    services: [
      {
        name: `Banca Meia do Lucão - R$ ${Number(valor).toFixed(2)}`,
        amount: valorCentavos
      }
    ],
    payment_terms: {
      due_date: vencimento.toISOString().split('T')[0]
    },
    payment_forms: ['PIX']
  };

  const resp = await axios.post(
    'https://matls-clients.api.cora.com.br/v2/invoices',
    payload,
    {
      httpsAgent: criarCoraAgent(),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID()
      },
      timeout: 30000
    }
  );

  const emv =
    resp.data?.payment_options?.pix?.emv ||
    resp.data?.pix?.emv;

  const qrUrl =
    resp.data?.payment_options?.bank_slip?.url ||
    resp.data?.payment_options?.pix?.url ||
    '';

  const invoiceId = resp.data?.id || resp.data?.code || '';

  if (!emv) {
    throw new Error('Cora não retornou EMV Pix.');
  }

  return {
    id: invoiceId,
    emv,
    qrUrl,
    raw: resp.data
  };
}
/* MERCADO PAGO ORDERS API */
async function gerarPixMercadoPago(valor, descricao) {
  if (!MP_TOKEN) {
    throw new Error('MERCADO_PAGO_ACCESS_TOKEN não configurado no Render.');
  }

  const valorFormatado = Number(valor).toFixed(2);
  const externalReference = `banca_${Date.now()}_${Math.floor(Math.random() * 999999)}`;

  const resp = await fetch('https://api.mercadopago.com/v1/orders', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MP_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Idempotency-Key': externalReference
    },
    body: JSON.stringify({
      type: 'online',
      total_amount: valorFormatado,
      external_reference: externalReference,
      processing_mode: 'automatic',
      transactions: {
        payments: [
          {
            amount: valorFormatado,
            payment_method: {
              id: 'pix',
              type: 'bank_transfer'
            }
          }
        ]
      },
      payer: {
        email: `cliente${Date.now()}@email.com`
      }
    })
  });

  const data = await resp.json();

  if (!resp.ok) {
    console.error('Erro Mercado Pago Orders:', data);
    throw new Error(data?.message || 'Erro ao gerar Pix Mercado Pago Orders.');
  }

  const payment = data.transactions?.payments?.[0] || {};
  const method = payment.payment_method || {};

  return {
    id: data.id,
    payment_id: payment.id || '',
    status: data.status,
    status_detail: data.status_detail,
    qr_code: method.qr_code || '',
    qr_code_base64: method.qr_code_base64 || '',
    ticket_url: method.ticket_url || ''
  };
}

async function consultarPagamentoMercadoPago(orderId) {
  if (!MP_TOKEN) {
    throw new Error('MERCADO_PAGO_ACCESS_TOKEN não configurado no Render.');
  }

  const resp = await fetch(`https://api.mercadopago.com/v1/orders/${orderId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${MP_TOKEN}`,
      Accept: 'application/json'
    }
  });

  const data = await resp.json();

  if (!resp.ok) {
    console.error('Erro ao consultar order:', data);
    return null;
  }

  return data;
}

async function liberarBancaParaOperador(banca) {
  if (!operadoresOnline.length) {
    bancasPagasPendentes.push(banca);

    await sock.sendMessage(banca.clienteJid, {
      text: '✅ Pagamento aprovado.\nÃ¢Å¡Â Ã¯Â¸Â Nenhum operador online no momento. Sua banca ficará aguardando atendimento.'
    });

    return { ok: false, pendente: true };
  }

  const operador = operadoresOnline[indiceOperador];
  const nomeOperador = operadorNome(operador);

  indiceOperador = (indiceOperador + 1) % operadoresOnline.length;
  totalBancasEnviadas++;

  const envio = await sock.sendMessage(operador, {
  text: 'Nova banca liberada' +
        '\n\nValor: R$ ' + banca.valor +
        '\n\n' + banca.textoBanca +
        '\n\nEnvie apenas a FOTO 1/2.' +
        '\n\nApos o pagamento confirmado, voce podera enviar a FOTO 2/2.'
});

  banca.operadorJid = operador;
  banca.operadorNome = nomeOperador;
  banca.operadorMsgId = envio.key.id;
  banca.fotosEnviadas = 0;
  banca.liberada = true;
  banca.pagamentoConfirmado = false;

  bancasPorMensagemOriginal.set(banca.originalMessageId, banca);
  bancasPorMensagemOperador.set(envio.key.id, banca);


  await sock.sendMessage(banca.clienteJid, {
    text: `✅ Banca liberada para ${nomeOperador}`
  });

  return { ok: true, operador: nomeOperador };
}

async function entregarBancasPendentes() {
  if (!operadoresOnline.length) return;

  while (bancasPagasPendentes.length && operadoresOnline.length) {
    const banca = bancasPagasPendentes.shift();
    await liberarBancaParaOperador(banca);
  }
}

setInterval(async () => {
  if (!sock || !MP_TOKEN) return;

  for (const [paymentId, banca] of pagamentosPendentes.entries()) {
    try {
            if (banca.tipo === 'cora') {
        const data = await consultarFaturaCora(banca.invoiceId);
        const statusCora = String(data.status || '').toUpperCase();

        if (statusCora === 'PAID') {
          pagamentosPendentes.delete(paymentId);
          totalPixPagos++;

          if (banca.banca) {
            banca.banca.pagamentoConfirmado = true;

            await sock.sendMessage(banca.clienteJid, {
              text: MSG_DEPOSITO_CONFIRMADO
            });

            if (banca.banca.operadorJid) {
              await sock.sendMessage(banca.banca.operadorJid, {
                text:
`💰 PAGAMENTO CONFIRMADO

Banca liberada.

Agora você pode enviar a FOTO 2/2.`
              });
            }
          } else {
            await sock.sendMessage(banca.clienteJid, {
              text: '✅ Pagamento confirmado.'
            });
          }
        }

        continue;
      }
      const data = await consultarPagamentoMercadoPago(paymentId);
      if (!data) continue;

      if (
        data.status === 'processed' ||
        data.status_detail === 'accredited' ||
        data.status === 'approved'
      ) {
        pagamentosPendentes.delete(paymentId);
        totalPixPagos++;

        banca.pagamentoConfirmado = true;

        await sock.sendMessage(banca.clienteJid, {
          text: MSG_DEPOSITO_CONFIRMADO
        });

        if (banca.operadorJid) {
          await sock.sendMessage(banca.operadorJid, {
            text:
`💰 PAGAMENTO CONFIRMADO

Banca liberada.

Agora você pode enviar a FOTO 2/2.`
          });
        }
      }

      if (
        data.status === 'cancelled' ||
        data.status === 'rejected' ||
        data.status === 'refunded'
      ) {
        pagamentosPendentes.delete(paymentId);

        await sock.sendMessage(banca.clienteJid, {
          text: `Ã¢Å¡Â Ã¯Â¸Â Pagamento não aprovado. Status: ${data.status}`
        });
      }
    } catch (err) {
      console.error('Erro no monitoramento Pix:', err);
    }
  }
}, 15000);

/* PLANILHA */
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

  return google.sheets({ version: 'v4', auth });
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

    const depositoTxt = extrair(bloco, /dep\s*:\s*(\d+)/i);
    const sacadoTxt = extrair(bloco, /ret\s*:\s*(\d+)/i);
    const casa = extrair(bloco, /plat\s*:\s*(.+)/i);

    const deposito = Number(depositoTxt);
    const sacado = Number(sacadoTxt);

    if (depositoTxt === '' || sacadoTxt === '' || !casa) continue;
    if (Number.isNaN(deposito) || Number.isNaN(sacado)) continue;    const regrasFixas = {
      301: { banca: 200, lucro: 100 },
      401: { banca: 280, lucro: 120 },
      501: { banca: 360, lucro: 140 },
      601: { banca: 430, lucro: 170 },
      701: { banca: 500, lucro: 200 },
      801: { banca: 570, lucro: 230 },
      901: { banca: 640, lucro: 260 },
      1001: { banca: 720, lucro: 280 }
    };

    const regraFixa = regrasFixas[deposito];

    const lucro = regraFixa ? regraFixa.lucro : calcularLucro(deposito);

    const faixaBase =
      Math.floor((deposito - 500) / 50) * 50 + 500;

    const banca = regraFixa
      ? regraFixa.banca
      : (
          faixaBase > 0
            ? faixaBase - lucro
            : deposito - lucro
        );

    const idFinal =
      `${messageId || 'semid'}_${i}_${Date.now()}_${Math.floor(Math.random() * 999999)}`;

    const linha = await proximaLinhaColunaB(sheets, aba);

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${aba}'!B${linha}:H${linha}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[deposito, sacado, casa, banca, lucro, aba, idFinal]]
      }
    });

    salvos++;
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

/* COMANDOS */
async function processarComandos(msg, texto, remetente, isAdmin) {
  const comando = String(texto || '').trim().toLowerCase();

  if (comando === '/menu' || comando === '/ajuda') {
    await sock.sendMessage(remetente, {
      text:
`📋 MENU DE COMANDOS

Ã°Å¸â€˜Â¨Ã¢â‚¬ÂÃ°Å¸â€™Â» OPERADORES
/opon - entrar na fila
/opoff - sair da fila

Ã°Å¸â€˜â€˜ ADMIN
/fila - ver operadores online
/stats - estatísticas
/reset - resetar sistema
/clearfila - limpar fila
/kickop 1 - remover operador

💰 BANCAS
/next - liberar banca manual
/pix 500 - gerar Pix
/500 - enviar valor para operador

Ã°Å¸â€œÂ¸ OPERADOR
Responder banca com FOTO
Limite: 2 fotos por banca`
    });

    return true;
  }

  if (comando === '/opon') {
    if (!operadoresOnline.includes(remetente)) {
      operadoresOnline.push(remetente);
    }

    await sock.sendMessage(remetente, {
      text: '✅ Status atualizado: online'
    });

    await entregarBancasPendentes();

    return true;
  }

  if (comando === '/opoff') {
    operadoresOnline = operadoresOnline.filter(op => op !== remetente);

    if (indiceOperador >= operadoresOnline.length) {
      indiceOperador = 0;
    }

    await sock.sendMessage(remetente, {
      text: 'Ã¢â€ºâ€ Status atualizado: offline'
    });

    return true;
  }

  
  if (comando === '/grupos') {
    const grupos = await sock.groupFetchAllParticipating();

    let lista = '';

    for (const grupo of Object.values(grupos)) {
      lista += `📌 ${grupo.subject}` + "\n" + `🆔 ${grupo.id}` + "\n\n";
    }

    await sock.sendMessage(remetente, {
      text: lista || 'Nenhum grupo encontrado.'
    });

    return true;
  }
  
  if (comando === '/pixrel') {
    await sock.sendMessage(remetente, {
      text: gerarRelatorioPix('📊 RELATÓRIO PIX')
    });

    return true;
  }

  if (comando === '/pixfechar') {
    const relatorio = gerarRelatorioPix('📊 FECHAMENTO PIX');

    await sock.sendMessage(remetente, {
      text: relatorio + "\n\n✅ Dia encerrado"
    });

    const dataHoje = dataPixBR();

    for (let i = historicoPixRecebidos.length - 1; i >= 0; i--) {
      if (historicoPixRecebidos[i].data === dataHoje) {
        historicoPixRecebidos.splice(i, 1);
      }
    }

    return true;
  }
  if (!isAdmin) return false;

  if (comando === '/addblacklist') {
    const quoted = getQuotedInfo(msg.message);
    const textoRespondido = textoDaQuotedMessage(quoted.quotedMessage);
    const nome = extrairNomePix(textoRespondido);

    if (!quoted.stanzaId || !nome) {
      await sock.sendMessage(remetente, {
        text:
`⚠️ Responda a uma mensagem de PIX RECEBIDO com:

/addblacklist`
      });

      return true;
    }

    const lista = carregarBlacklist();
    const jaExiste = lista.some(
      item => normalizarNomeBlacklist(item.nome) === normalizarNomeBlacklist(nome)
    );

    if (jaExiste) {
      await sock.sendMessage(remetente, {
        text: `⚠️ ${nome} já está na blacklist.`
      });

      return true;
    }

    lista.push({
      nome,
      motivo: 'Fraude',
      data: new Date().toISOString(),
      adicionadoPor: remetente
    });

    salvarBlacklist(lista);

    await sock.sendMessage(remetente, {
      text:
`✅ ADICIONADO À BLACKLIST

👤 ${nome}

Novos Pix com esse nome receberão alerta automático.`
    });

    return true;
  }

  if (comando === '/listblacklist') {
    const lista = carregarBlacklist();

    if (!lista.length) {
      await sock.sendMessage(remetente, {
        text: '✅ A blacklist está vazia.'
      });

      return true;
    }

    const linhas = lista.map((item, index) => {
      const data = item.data
        ? new Date(item.data).toLocaleDateString('pt-BR', {
            timeZone: 'America/Sao_Paulo'
          })
        : 'Sem data';

      return `${index + 1}. ${item.nome}\n   Data: ${data}`;
    });

    await sock.sendMessage(remetente, {
      text:
`🚫 BLACKLIST PIX

${linhas.join('\n\n')}

Total: ${lista.length}`
    });

    return true;
  }

  if (comando.startsWith('/removeblacklist')) {
    const quoted = getQuotedInfo(msg.message);
    const textoRespondido = textoDaQuotedMessage(quoted.quotedMessage);
    const nomeRespondido = extrairNomePix(textoRespondido);

    const nomeDigitado = String(texto || '')
      .trim()
      .replace(/^\/removeblacklist\s*/i, '')
      .trim();

    const nome = nomeRespondido || nomeDigitado;

    if (!nome) {
      await sock.sendMessage(remetente, {
        text:
`⚠️ Use uma destas formas:

1. Responda ao PIX com:
/removeblacklist

2. Digite:
/removeblacklist Nome Completo`
      });

      return true;
    }

    const lista = carregarBlacklist();
    const nomeNormalizado = normalizarNomeBlacklist(nome);

    const novaLista = lista.filter(
      item => normalizarNomeBlacklist(item.nome) !== nomeNormalizado
    );

    if (novaLista.length === lista.length) {
      await sock.sendMessage(remetente, {
        text: `⚠️ ${nome} não foi encontrado na blacklist.`
      });

      return true;
    }

    salvarBlacklist(novaLista);

    await sock.sendMessage(remetente, {
      text:
`✅ REMOVIDO DA BLACKLIST

👤 ${nome}`
    });

    return true;
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
      text: 'Ã°Å¸Â§Â¹ Fila limpa com sucesso.'
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
      text: `Ã¢â€ºâ€ Operador ${numero} removido da fila.`
    });

    return true;
  }

  if (comando === '/stats') {
    const proximo = operadoresOnline.length
      ? `Operador ${indiceOperador + 1}`
      : 'Nenhum';

    await sock.sendMessage(remetente, {
      text:
`Ã°Å¸â€œÅ  Estatísticas

Pix gerados: ${totalPixGerados}
Pix pagos: ${totalPixPagos}
Bancas liberadas: ${totalBancasEnviadas}
Bancas pagas pendentes: ${bancasPagasPendentes.length}
Operadores online: ${operadoresOnline.length}
Próximo da fila: ${proximo}`
    });

    return true;
  }

  if (comando === '/reset') {
    operadoresOnline = [];
    indiceOperador = 0;
    totalBancasEnviadas = 0;
    totalPixGerados = 0;
    totalPixPagos = 0;
    bancasPorMensagemOriginal.clear();
    bancasPorMensagemOperador.clear();
    pagamentosPendentes.clear();
    bancasPagasPendentes.length = 0;

    await sock.sendMessage(remetente, {
      text:
`Ã¢â„¢Â»Ã¯Â¸Â Sistema resetado

Fila zerada
Ã€Ândice reiniciado
Bancas temporárias limpas
Pagamentos pendentes limpos`
    });

    return true;
  }

  if (comando === '/next') {
    if (!operadoresOnline.length) {
      await sock.sendMessage(remetente, {
        text: 'Ã¢Å¡Â Ã¯Â¸Â Nenhum operador online.'
      });
      return true;
    }

    const quoted = getQuotedInfo(msg.message);

    if (!quoted.stanzaId) {
      await sock.sendMessage(remetente, {
        text: 'Ã¢Å¡Â Ã¯Â¸Â Responda a mensagem do cliente com /next.'
      });
      return true;
    }

    const textoBanca = textoDaQuotedMessage(quoted.quotedMessage);

    if (!textoBanca) {
      await sock.sendMessage(remetente, {
        text: 'Ã¢Å¡Â Ã¯Â¸Â Não consegui ler a banca respondida.'
      });
      return true;
    }

    const banca = {
      originalMessageId: quoted.stanzaId,
      clienteJid: msg.key.remoteJid,
      textoBanca,
      valor: 'manual',
      fotosEnviadas: 0
    };

    const resultado = await liberarBancaParaOperador(banca);
    return true;
  }
if (comando.startsWith('/pix ')) {
  const partes = comando.split(/\s+/);
  const valor = Number(String(partes[1] || '').replace(',', '.'));

  if (!valor || valor < 5) {
    await sock.sendMessage(remetente, {
      text: 'Use: /pix 5\nValor mínimo: R$ 5,00'
    });
    return true;
  }

  try {
    const pix = await gerarPixCora(valor);
    
    const quoted = getQuotedInfo(msg.message);
const banca = quoted.stanzaId
  ? bancasPorMensagemOriginal.get(quoted.stanzaId)
  : null;

pagamentosPendentes.set(String(pix.id), {
  tipo: 'cora',
  invoiceId: pix.id,
  valor,
  clienteJid: remetente,
  banca
});

    await sock.sendMessage(remetente, {
      text:
`💰 PIX GERADO

Valor: R$ ${valor.toFixed(2).replace('.', ',')}

📋 PIX COPIA E COLA:`
    });

    await sock.sendMessage(remetente, {
      text: pix.emv
    });

   if (pix.qrUrl) {
  await sock.sendMessage(remetente, {
    image: { url: pix.qrUrl },
    caption:
`💰 PIX GERADO

Valor: R$ ${valor.toFixed(2).replace('.', ',')}

â³ Aguardando pagamento...`
  });
}

    await sock.sendMessage(remetente, {
      text: `✅ Pix criado.\nID: ${pix.id || 'sem id'}`
    });
  } catch (err) {
    console.error('Erro Pix Cora:', err.response?.data || err.message);

    await sock.sendMessage(remetente, {
      text:
`âŒ Erro ao gerar Pix Cora.

${err.response?.data?.message || err.message}`
    });
  }

  return true;
}
  if (comando.startsWith('/pixmp')) {
    const partes = comando.split(/\s+/);
    const valor = Number(String(partes[1] || '').replace(',', '.'));

    if (!valor || valor <= 0) {
      await sock.sendMessage(remetente, {
        text: 'Use: /pixmp 500'
      });
      return true;
    }

    const quoted = getQuotedInfo(msg.message);

    if (!quoted.stanzaId) {
      await sock.sendMessage(remetente, {
        text: 'Ã¢Å¡Â Ã¯Â¸Â Responda a mensagem/link do cliente com /pix 500.'
      });
      return true;
    }

    const textoBanca = textoDaQuotedMessage(quoted.quotedMessage);

    if (!textoBanca) {
      await sock.sendMessage(remetente, {
        text: 'Ã¢Å¡Â Ã¯Â¸Â Não consegui ler a banca respondida.'
      });
      return true;
    }

    const pix = await gerarPixMercadoPago(
      valor,
      `Banca Meia do Lucão - R$ ${valor}`
    );

    totalPixGerados++;

    const banca = bancasPorMensagemOriginal.get(quoted.stanzaId);

    if (!banca) {
      await sock.sendMessage(remetente, {
        text: 'âš ï¸ Primeiro use /next nesse link e aguarde o operador enviar a FOTO 1/2.'
      });
      return true;
    }

    banca.paymentId = pix.id;
    banca.valor = valor;

    pagamentosPendentes.set(String(pix.id), banca);

    if (pix.qr_code_base64) {
      await sock.sendMessage(remetente, {
        image: Buffer.from(pix.qr_code_base64, 'base64'),
        caption:
`💰 PIX GERADO

Valor: R$ ${valor.toFixed(2).replace('.', ',')}

Ã¢ÂÂ³ Aguardando pagamento...`
      });
    }

    if (pix.qr_code) {
      await sock.sendMessage(remetente, {
        text: '📋 PIX COPIA E COLA:'
      });

      await sock.sendMessage(remetente, {
        text: pix.qr_code
      });
    }

    await sock.sendMessage(remetente, {
      text: `✅ Pix criado. ID: ${pix.id}\nAssim que aprovar, a banca será liberada automaticamente.`
    });

    return true;
  }

  if (isComandoValor(comando)) {
    const quoted = getQuotedInfo(msg.message);

    if (!quoted.stanzaId) {
      await sock.sendMessage(remetente, {
        text: 'Ã¢Å¡Â Ã¯Â¸Â Responda a banca original com o valor. Ex: /500'
      });
      return true;
    }

    const banca = bancasPorMensagemOriginal.get(quoted.stanzaId);

    if (!banca) {
      await sock.sendMessage(remetente, {
        text: 'Ã¢Å¡Â Ã¯Â¸Â Esta banca ainda não foi liberada para operador.'
      });
      return true;
    }

    const valor = valorDoComando(comando);

    await sock.sendMessage(banca.operadorJid, {
      text: `💰 Valor fechado: R$ ${valor}`
    });

    await sock.sendMessage(remetente, {
      text: `💰 Valor enviado para ${banca.operadorNome}`
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

  const banca = bancasPorMensagemOperador.get(quoted.stanzaId);

  if (!banca) return false;

  if (banca.operadorJid !== remetente) {
    await sock.sendMessage(remetente, {
      text: 'âš ï¸ Esta banca não está vinculada a você.'
    });
    return true;
  }

  const limiteFotos = banca.pagamentoConfirmado ? 2 : 1;

  if (banca.fotosEnviadas >= limiteFotos) {
    await sock.sendMessage(remetente, {
      text: banca.pagamentoConfirmado
        ? 'â›” FOTO 2/2 já enviada. Limite final atingido.'
        : 'â›” Aguarde o pagamento do cliente para enviar a FOTO 2/2.'
    });
    return true;
  }

  const buffer = await baixarImagem(msg.message);

  await sock.sendMessage(banca.clienteJid, {
    image: buffer
  });

  banca.fotosEnviadas++;

  await sock.sendMessage(remetente, {
    text: `✅ Banca enviada ao cliente. (${banca.fotosEnviadas}/2)`
  });

  return true;
}

/* WHATSAPP */
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
    const { connection, lastDisconnect, qr } = update;

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

      status = shouldReconnect ? 'reconectando' : 'deslogado';

      console.log('Conexão fechada. Reconectar:', shouldReconnect);

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
        console.error('Erro ao processar mensagem:', err);
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

            console.log('Mensagem editada atualizada:', id, salvos);
          });
        }
      } catch (err) {
        console.error('Erro em messages.update:', err);
      }
    }
  });
}

function numeroPixBR(valor) {
  return Number(String(valor || '0').replace(/\./g, '').replace(',', '.')) || 0;
}

function moedaBR(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });
}

function dataPixBR() {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(new Date());
}

function horaPixBR() {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date());
}

function gerarRelatorioPix(titulo) {
  const dataHoje = dataPixBR();
  const itens = historicoPixRecebidos.filter(p => p.data === dataHoje);

  if (!itens.length) {
    return `${titulo}

📅 ${dataHoje}

Nenhum PIX registrado até agora.`;
  }

  const porCliente = {};

  for (const p of itens) {
    if (!porCliente[p.cliente]) {
      porCliente[p.cliente] = { qtd: 0, total: 0 };
    }

    porCliente[p.cliente].qtd++;
    porCliente[p.cliente].total += p.valorNumero;
  }

  let totalGeral = 0;
  let qtdGeral = 0;

  let texto = `${titulo}

📅 ${dataHoje}

`;

  for (const [cliente, dados] of Object.entries(porCliente)) {
    totalGeral += dados.total;
    qtdGeral += dados.qtd;

    texto += `👤 ${cliente}
Qtd: ${dados.qtd}
Total: ${moedaBR(dados.total)}

`;
  }

  texto += `💰 TOTAL GERAL: ${moedaBR(totalGeral)}
🔢 QTD GERAL: ${qtdGeral}`;

  return texto;
}
app.post('/pix/:cliente', async (req, res) => {
  try {
    const cliente = String(req.params.cliente || '').toLowerCase();
    const destino = DESTINOS_PIX[cliente];

    if (!destino) {
      return res.status(404).json({
        sucesso: false,
        erro: 'Cliente não cadastrado'
      });
    }

    if (!sock) {
      return res.status(503).json({
        sucesso: false,
        erro: 'WhatsApp não conectado'
      });
    }

    const mensagem = String(req.body.texto || '');

    const nome =
      mensagem.match(/^(.*?) te enviou um Pix/i)?.[1]?.trim()
      || 'Desconhecido';

    const valor =
      mensagem.match(/R\$\s*([\d.,]+)/i)?.[1]?.trim()
      || '0,00';

    historicoPixRecebidos.push({
      data: dataPixBR(),
      hora: horaPixBR(),
      cliente,
      nome,
      valor,
      valorNumero: numeroPixBR(valor),
      texto: mensagem
    });
    const registroFraude = buscarNaBlacklist(nome);

    const mensagemPix = registroFraude
      ? `━━━━━━━━━━━━━━━━━━━━━━

💰 PIX RECEBIDO

👤 ${nome}
💵 R$ ${valor}

🔴 STATUS: SUSPEITO

Motivo:
• Nome presente na lista de fraude.

Ação recomendada:
❌ Não liberar saldo
👤 Encaminhar para análise

━━━━━━━━━━━━━━━━━━━━━━`
      : `💰 PIX RECEBIDO

👤 ${nome}
💵 R$ ${valor}`;

    await sock.sendMessage(destino, {
      text: mensagemPix
    });

    return res.status(200).json({
      sucesso: true,
      cliente
    });

  } catch (err) {
    console.error('Erro PIX:', err);

    return res.status(500).json({
      sucesso: false,
      erro: err.message
    });
  }
});
/* ROTAS */
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
    pixGerados: totalPixGerados,
    pixPagos: totalPixPagos,
    bancasLiberadas: totalBancasEnviadas,
    bancasPagasPendentes: bancasPagasPendentes.length,
    pagamentosPendentes: pagamentosPendentes.size
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














