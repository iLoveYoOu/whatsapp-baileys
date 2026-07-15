
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



const EMOJI = Object.freeze({
  OK: '✅',
  ERRO: '⛔',
  ALERTA: '⚠️',
  PIX: '💰',
  PESSOA: '👤',
  DINHEIRO: '💵',
  FOTO: '📸',
  OPERADOR: '👨‍💻',
  ESTATISTICAS: '📊',
  FILA: '📋',
  FERRAMENTA: '🛠️',
  ESTRELA: '⭐',
  RECICLAR: '♻️',
  LIMPAR: '🧹',
  GRUPO: '👥'
});

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
const operadoresInfo = new Map();
const inicioProcesso = Date.now();

function autorDaMensagem(msg) {
  const remoto = msg?.key?.remoteJid || '';
  if (remoto.endsWith('@g.us')) {
    return msg?.key?.participant || msg?.participant || '';
  }
  return remoto;
}

function nomeDaMensagem(msg, jid) {
  const nome = String(msg?.pushName || '').trim();
  if (nome) return nome;
  const numero = String(jid || '').split('@')[0];
  return numero ? `Operador ${numero.slice(-4)}` : 'Operador';
}

function normalizarFilaOperadores() {
  const antes = operadoresOnline.length;
  const vistos = new Set();
  operadoresOnline = operadoresOnline.filter(jid => {
    if (!jid || typeof jid !== 'string') return false;
    if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) return false;
    if (vistos.has(jid)) return false;
    vistos.add(jid);
    return true;
  });

  if (!operadoresOnline.length || indiceOperador >= operadoresOnline.length || indiceOperador < 0) {
    indiceOperador = 0;
  }

  return antes - operadoresOnline.length;
}

function entrarOperadorNaFila(jid, nome) {
  normalizarFilaOperadores();
  const existente = operadoresOnline.includes(jid);
  if (!existente) operadoresOnline.push(jid);

  operadoresInfo.set(jid, {
    jid,
    nome: nome || operadoresInfo.get(jid)?.nome || 'Operador',
    entrouEm: operadoresInfo.get(jid)?.entrouEm || new Date().toISOString(),
    ultimaAtividade: new Date().toISOString()
  });

  return {
    novo: !existente,
    posicao: operadoresOnline.indexOf(jid) + 1,
    total: operadoresOnline.length
  };
}

function sairOperadorDaFila(jid) {
  const antes = operadoresOnline.length;
  operadoresOnline = operadoresOnline.filter(op => op !== jid);
  normalizarFilaOperadores();
  return antes !== operadoresOnline.length;
}

function proximoOperadorDaFila() {
  normalizarFilaOperadores();
  if (!operadoresOnline.length) return null;

  const jid = operadoresOnline[indiceOperador];
  indiceOperador = (indiceOperador + 1) % operadoresOnline.length;
  const info = operadoresInfo.get(jid);
  if (info) info.ultimaAtividade = new Date().toISOString();
  return jid;
}

function formatarDuracao(ms) {
  const totalSegundos = Math.floor(ms / 1000);
  const horas = Math.floor(totalSegundos / 3600);
  const minutos = Math.floor((totalSegundos % 3600) / 60);
  return `${horas}h ${minutos}min`;
}
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
const linksEmProcessamento = new Set();
const historicoNext = new Map();

/*
 * Sessões ativas:
 * - clienteJid -> banca daquele cliente
 * - operadorJid -> banca daquele operador
 */
const bancaAtivaPorCliente = new Map();
const bancaAtivaPorOperador = new Map();
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
  return operadoresInfo.get(jid)?.nome || 'Operador';
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
const axiosBlacklist = require('axios');

const BLACKLIST_PATH = `${__dirname}/blacklist.json`;
const BLACKLIST_GIST_ID = process.env.BLACKLIST_GIST_ID || '';
const BLACKLIST_GITHUB_TOKEN = process.env.BLACKLIST_GITHUB_TOKEN || '';

let blacklistCache = [];

function normalizarNomeBlacklist(nome) {
  return String(nome || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function carregarBlacklistLocal() {
  try {
    if (!fsBlacklist.existsSync(BLACKLIST_PATH)) {
      fsBlacklist.writeFileSync(BLACKLIST_PATH, '[]', 'utf8');
      return [];
    }

    const conteudo = fsBlacklist.readFileSync(BLACKLIST_PATH, 'utf8');
    const lista = JSON.parse(conteudo || '[]');

    return Array.isArray(lista) ? lista : [];
  } catch (err) {
    console.error('Erro ao carregar blacklist local:', err.message);
    return [];
  }
}

function headersGist() {
  return {
    Authorization: `Bearer ${BLACKLIST_GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'whatsapp-baileys-blacklist'
  };
}

async function carregarBlacklistRemota() {
  blacklistCache = carregarBlacklistLocal();

  if (!BLACKLIST_GIST_ID || !BLACKLIST_GITHUB_TOKEN) {
    console.warn('Gist não configurado. Blacklist usando apenas arquivo local.');
    return blacklistCache;
  }

  try {
    const resposta = await axiosBlacklist.get(
      `https://api.github.com/gists/${BLACKLIST_GIST_ID}`,
      {
        headers: headersGist(),
        timeout: 30000
      }
    );

    const arquivo = resposta.data?.files?.['blacklist.json'];

    if (!arquivo) {
      throw new Error('blacklist.json não encontrado no Gist.');
    }

    const lista = JSON.parse(arquivo.content || '[]');
    blacklistCache = Array.isArray(lista) ? lista : [];

    fsBlacklist.writeFileSync(
      BLACKLIST_PATH,
      JSON.stringify(blacklistCache, null, 2),
      'utf8'
    );

    console.log(
      `Blacklist carregada do Gist: ${blacklistCache.length} registro(s).`
    );

    return blacklistCache;
  } catch (err) {
    console.error(
      'Erro ao carregar blacklist do Gist:',
      err.response?.data || err.message
    );

    return blacklistCache;
  }
}

function carregarBlacklist() {
  return blacklistCache;
}

async function salvarBlacklist(lista) {
  blacklistCache = Array.isArray(lista) ? lista : [];

  const json = JSON.stringify(blacklistCache, null, 2);

  fsBlacklist.writeFileSync(
    BLACKLIST_PATH,
    json,
    'utf8'
  );

  if (!BLACKLIST_GIST_ID || !BLACKLIST_GITHUB_TOKEN) {
    console.warn('Blacklist salva somente localmente.');
    return;
  }

  await axiosBlacklist.patch(
    `https://api.github.com/gists/${BLACKLIST_GIST_ID}`,
    {
      files: {
        'blacklist.json': {
          content: json
        }
      }
    },
    {
      headers: headersGist(),
      timeout: 30000
    }
  );

  console.log(
    `Blacklist salva no Gist: ${blacklistCache.length} registro(s).`
  );
}

function extrairNomePix(texto) {
  const match = String(texto || '').match(/👤\s*(.+)/i);
  return match ? String(match[1]).trim() : '';
}

function buscarNaBlacklist(nome) {
  const nomeNormalizado = normalizarNomeBlacklist(nome);

  return blacklistCache.find(
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
/* MERCADO PAGO PAYMENTS API */
async function gerarPixMercadoPago(valor, descricao) {
  if (!MP_TOKEN) {
    throw new Error(
      'MERCADO_PAGO_ACCESS_TOKEN não configurado no Render.'
    );
  }

  const numero = Number(valor);

  if (!numero || numero <= 0) {
    throw new Error('Valor inválido.');
  }

  const idempotencyKey =
    `pix_${Date.now()}_${Math.floor(Math.random() * 999999)}`;

  const resposta = await fetch(
    'https://api.mercadopago.com/v1/payments',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MP_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        transaction_amount: numero,
        description:
          descricao || `Pix R$ ${numero.toFixed(2)}`,
        payment_method_id: 'pix',
        payer: {
          email: "arthurcesarmaga@gmail.com"
        },
        external_reference: idempotencyKey
      })
    }
  );

  const data = await resposta.json();

  if (!resposta.ok) {
    console.error('Erro Mercado Pago Payments:', data);

    throw new Error(
      data?.message ||
      data?.cause?.[0]?.description ||
      'Erro ao gerar Pix Mercado Pago.'
    );
  }

  const transactionData =
    data.point_of_interaction?.transaction_data || {};

  const qrCode = transactionData.qr_code || '';
  const qrCodeBase64 =
    transactionData.qr_code_base64 || '';

  if (!qrCode) {
    console.error(
      'Mercado Pago não retornou Pix Copia e Cola:',
      data
    );

    throw new Error(
      'Mercado Pago não retornou o Pix Copia e Cola.'
    );
  }

  return {
    id: String(data.id),
    payment_id: String(data.id),
    qr_code: qrCode,
    qr_code_base64: qrCodeBase64,
    status: data.status || '',
    raw: data
  };
}

async function consultarPagamentoMercadoPago(paymentId) {
  if (!MP_TOKEN) {
    throw new Error(
      'MERCADO_PAGO_ACCESS_TOKEN não configurado no Render.'
    );
  }

  const resposta = await fetch(
    `https://api.mercadopago.com/v1/payments/${paymentId}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${MP_TOKEN}`,
        Accept: 'application/json'
      }
    }
  );

  const data = await resposta.json();

  if (!resposta.ok) {
    console.error(
      'Erro ao consultar pagamento Mercado Pago:',
      data
    );

    return null;
  }

  return data;
}
setInterval(async () => {
  if (!sock || !MP_TOKEN) return;

  for (const [paymentId, banca] of pagamentosPendentes.entries()) {
    try {
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
          text: `⚠️ Pagamento não aprovado. Status: ${data.status}`
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
    if (Number.isNaN(deposito) || Number.isNaN(sacado)) continue;

    const regrasFixas = {
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


/* FILA E DISTRIBUIÇÃO DE BANCAS */
async function liberarBancaParaOperador(banca) {
  normalizarFilaOperadores();

  if (!operadoresOnline.length) {
    if (!bancasPagasPendentes.includes(banca)) {
      bancasPagasPendentes.push(banca);
    }

    await sock.sendMessage(banca.clienteJid, {
      text: '⚠️ Nenhum operador online no momento. Sua banca ficou aguardando atendimento.'
    });

    return { ok: false, pendente: true };
  }

  const operadorJid = proximoOperadorDaFila();
  const nomeOperador = operadorNome(operadorJid);

  banca.operadorJid = operadorJid;
  banca.operadorNome = nomeOperador;
  banca.pagamentoConfirmado = Boolean(banca.pagamentoConfirmado);
  banca.fotosEnviadas = Number(banca.fotosEnviadas || 0);

  const envio = await sock.sendMessage(operadorJid, {
    text:
`📥 NOVA BANCA

${banca.textoBanca}

📸 Envie a FOTO 1/2 respondendo a esta mensagem.
Após a confirmação do pagamento, você poderá enviar a FOTO 2/2.`
  });

  const mensagemOperadorId = envio?.key?.id || '';

  if (banca.originalMessageId) {
    bancasPorMensagemOriginal.set(banca.originalMessageId, banca);
  }
  if (mensagemOperadorId) {
    bancasPorMensagemOperador.set(mensagemOperadorId, banca);
  }

  bancaAtivaPorCliente.set(banca.clienteJid, banca);
  bancaAtivaPorOperador.set(operadorJid, banca);
  totalBancasEnviadas++;

  await sock.sendMessage(banca.clienteJid, {
    text: `${EMOJI.OK} Banca liberada para ${banca.operadorNome}`
  });

  return { ok: true, operadorJid, operadorNome: nomeOperador };
}

async function entregarBancasPendentes() {
  normalizarFilaOperadores();
  while (operadoresOnline.length && bancasPagasPendentes.length) {
    const banca = bancasPagasPendentes.shift();
    try {
      await liberarBancaParaOperador(banca);
    } catch (err) {
      console.error('[FILA] Erro ao entregar banca pendente:', err);
      bancasPagasPendentes.unshift(banca);
      break;
    }
  }
}

function desbugarFila() {
  const duplicadosRemovidos = normalizarFilaOperadores();
  let bancasOrfas = 0;

  for (const [jid, banca] of bancaAtivaPorOperador.entries()) {
    if (!banca || banca.operadorJid !== jid) {
      bancaAtivaPorOperador.delete(jid);
      bancasOrfas++;
    }
  }

  for (const [jid, banca] of bancaAtivaPorCliente.entries()) {
    if (!banca || banca.clienteJid !== jid) {
      bancaAtivaPorCliente.delete(jid);
      bancasOrfas++;
    }
  }

  let pagamentosInvalidos = 0;
  for (const [id, banca] of pagamentosPendentes.entries()) {
    if (!id || !banca || !banca.clienteJid) {
      pagamentosPendentes.delete(id);
      pagamentosInvalidos++;
    }
  }

  return { duplicadosRemovidos, bancasOrfas, pagamentosInvalidos };
}


/* PAINEL ADMIN SIMPLES */

function numeroLimpoJid(jid) {
  return String(jid || '')
    .split('@')[0]
    .split(':')[0]
    .replace(/\D/g, '');
}

function normalizarNumeroWhatsapp(valor) {
  let numero = String(valor || '').replace(/\D/g, '');
  if (!numero) return '';

  if (!numero.startsWith('55') && numero.length >= 10 && numero.length <= 11) {
    numero = '55' + numero;
  }

  return numero;
}

async function enviarTextoDividido(jid, texto, limite = 3500) {
  const conteudo = String(texto || '');

  if (conteudo.length <= limite) {
    await sock.sendMessage(jid, { text: conteudo });
    return;
  }

  const linhas = conteudo.split('\n');
  let parte = '';

  for (const linha of linhas) {
    const candidato = parte ? parte + '\n' + linha : linha;

    if (candidato.length > limite && parte) {
      await sock.sendMessage(jid, { text: parte });
      parte = linha;
    } else {
      parte = candidato;
    }
  }

  if (parte) {
    await sock.sendMessage(jid, { text: parte });
  }
}

function menuComandosCompleto() {
  return [
    '📋 COMANDOS DISPONÍVEIS',
    '',
    '👨‍💻 OPERADORES',
    '/opon - entrar na fila',
    '/opoff - sair da fila',
    '/fila - listar operadores',
    '',
    '💰 PIX E BANCAS',
    '/next - enviar banca',
    '/renext - liberar link já enviado',
    '/pix 500 - gerar cobrança',
    '/500 - liberar banca manualmente',
    '',
    '👥 GRUPOS E IDS',
    '/ids - listar membros do grupo',
    '/admins - listar administradores',
    '/exportargrupo - gerar JSON do grupo',
    '/consultarid 5567999999999',
    '/meuid - mostrar seu ID',
    '',
    '🚫 BLACKLIST',
    '/addblacklist',
    '/removeblacklist Nome',
    '/listblacklist',
    '',
    '🛠️ SISTEMA',
    '/stats',
    '/statusbot',
    '/desbugafila',
    '/clearfila',
    '/kickop 1',
    '/reset'
  ].join('\n');
}

/* COMANDOS */

async function mensagemDeAdmin(msg) {
  // O próprio número conectado ao Baileys sempre é admin
  if (msg?.key?.fromMe) return true;

  const grupoJid = msg?.key?.remoteJid || '';

  // Fora de grupo, outros números não recebem permissão administrativa
  if (!grupoJid.endsWith('@g.us')) return false;

  const autorJid =
    msg?.key?.participant ||
    msg?.participant ||
    '';

  if (!autorJid) return false;

  try {
    const metadata = await sock.groupMetadata(grupoJid);

    const participante = metadata.participants.find(p =>
      p.id === autorJid ||
      p.lid === autorJid ||
      p.phoneNumber === autorJid
    );

    return participante?.admin === 'admin' ||
           participante?.admin === 'superadmin';
  } catch (err) {
    console.error('Erro ao verificar admin do grupo:', err.message);
    return false;
  }
}

async function processarComandos(msg, texto, remetente, isAdmin, autorJid, autorNome) {
  let comando = String(texto || '').trim().toLowerCase();



  if (comando === '/menu' || comando === '/ajuda') {
    await sock.sendMessage(remetente, {
      text:
`📋 MENU DE COMANDOS

👨‍💻 OPERADORES
/opon - entrar na fila
/opoff - sair da fila

👑 ADMIN
/fila - ver operadores online
/stats - estatísticas
/reset - resetar sistema
/clearfila - limpar fila
/kickop 1 - remover operador
/desbugafila - verificar e reparar fila
/renext - liberar link para novo envio

💰 BANCAS
/next - liberar banca manual
/pix 500 - gerar Pix
/500 - enviar valor para operador

📸 OPERADOR
Responder banca com FOTO
Limite: 2 fotos por banca`
    });

    return true;
  }

  if (comando === '/listarcomandos') {
    await sock.sendMessage(remetente, {
      text: menuComandosCompleto()
    });
    return true;
  }

  if (comando === '/meuid') {
    const jid = autorJid || autorDaMensagem(msg) || remetente;
    const numero = numeroLimpoJid(jid);

    await sock.sendMessage(remetente, {
      text: [
        '👤 SEU ID',
        '',
        'Nome: ' + (autorNome || 'Sem nome'),
        'Número: ' + (numero || 'Não identificado'),
        'JID: ' + (jid || 'Não identificado')
      ].join('\n')
    });

    return true;
  }

  if (comando === '/opon') {
    if (!autorJid) {
      await sock.sendMessage(remetente, { text: '⚠️ Não consegui identificar seu número.' });
      return true;
    }

    const resultado = entrarOperadorNaFila(autorJid, autorNome);

    await sock.sendMessage(remetente, {
      text:
`✅ ${autorNome} está online.

📍 Posição na fila: ${resultado.posicao}
👥 Operadores online: ${resultado.total}`
    });

    await entregarBancasPendentes();
    return true;
  }

  if (comando === '/opoff') {
    const saiu = sairOperadorDaFila(autorJid);

    await sock.sendMessage(remetente, {
      text:
`⛔ ${autorNome} está offline.

👥 Operadores online: ${operadoresOnline.length}${saiu ? '' : '\nℹ️ Você já não estava na fila.'}`
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

  if (comando.startsWith('/consultarid')) {
    const digitado = String(texto || '')
      .replace(/^\/consultarid\s*/i, '')
      .trim();

    const numero = normalizarNumeroWhatsapp(digitado);

    if (!numero) {
      await sock.sendMessage(remetente, {
        text: '⚠️ Use: /consultarid 5567999999999'
      });
      return true;
    }

    try {
      const resultado = await sock.onWhatsApp(numero);
      const encontrado = Array.isArray(resultado)
        ? resultado.find(item => item && item.exists)
        : null;

      if (!encontrado || !encontrado.jid) {
        await sock.sendMessage(remetente, {
          text: '⛔ Número não encontrado no WhatsApp.\n\nNúmero: ' + numero
        });
        return true;
      }

      await sock.sendMessage(remetente, {
        text: [
          '✅ NÚMERO ENCONTRADO',
          '',
          'Número: ' + numero,
          'JID: ' + encontrado.jid
        ].join('\n')
      });
    } catch (err) {
      console.error('[CONSULTARID]', err);
      await sock.sendMessage(remetente, {
        text: '⛔ Não foi possível consultar esse número.'
      });
    }

    return true;
  }

  if (comando === '/ids' || comando === '/admins' || comando === '/exportargrupo') {
    const grupoJid = msg?.key?.remoteJid || '';

    if (!grupoJid.endsWith('@g.us')) {
      await sock.sendMessage(remetente, {
        text: '⚠️ Este comando só funciona dentro de grupos.'
      });
      return true;
    }

    const metadata = await sock.groupMetadata(grupoJid);

    if (comando === '/ids') {
      const linhas = metadata.participants.map((p, index) => {
        const jid = p.id || p.phoneNumber || p.lid || '';
        const numero = numeroLimpoJid(p.phoneNumber || jid);
        const admin = p.admin === 'admin' || p.admin === 'superadmin';

        return [
          (index + 1) + '. ' + (admin ? '👑 ADMIN' : '👤 MEMBRO'),
          'Número: ' + (numero || 'Não disponível'),
          'JID: ' + (jid || 'Não disponível')
        ].join('\n');
      });

      const cabecalho = [
        '👥 ' + metadata.subject,
        'Participantes: ' + metadata.participants.length,
        ''
      ].join('\n');

      await enviarTextoDividido(
        remetente,
        cabecalho + linhas.join('\n\n')
      );

      return true;
    }

    if (comando === '/admins') {
      const admins = metadata.participants.filter(p =>
        p.admin === 'admin' || p.admin === 'superadmin'
      );

      const lista = admins.length
        ? admins.map((p, index) => {
            const jid = p.id || p.phoneNumber || p.lid || '';
            return [
              (index + 1) + '. 👑 ADMIN',
              'Número: ' + (numeroLimpoJid(p.phoneNumber || jid) || 'Não disponível'),
              'JID: ' + jid
            ].join('\n');
          }).join('\n\n')
        : 'Nenhum administrador encontrado.';

      await enviarTextoDividido(
        remetente,
        '👑 ADMINISTRADORES\n\n' + lista
      );

      return true;
    }

    if (comando === '/exportargrupo') {
      const membros = metadata.participants.map(p => {
        const jid = p.id || p.phoneNumber || p.lid || '';

        return {
          numero: numeroLimpoJid(p.phoneNumber || jid),
          jid,
          lid: p.lid || null,
          phoneNumber: p.phoneNumber || null,
          admin: p.admin === 'admin' || p.admin === 'superadmin'
        };
      });

      const json = JSON.stringify({
        grupo: metadata.subject,
        jid: grupoJid,
        total: membros.length,
        exportadoEm: new Date().toISOString(),
        membros
      }, null, 2);

      await sock.sendMessage(remetente, {
        document: Buffer.from(json, 'utf8'),
        mimetype: 'application/json',
        fileName: 'grupo-' + Date.now() + '.json',
        caption: '✅ Grupo exportado com sucesso.'
      });

      return true;
    }
  }

  if (comando === '/statusbot') {
    const memoriaMb = Math.round(
      process.memoryUsage().rss / 1024 / 1024
    );

    await sock.sendMessage(remetente, {
      text: [
        '🛠️ STATUS DO BOT',
        '',
        'WhatsApp: ' + status,
        'Tempo online: ' + formatarDuracao(Date.now() - inicioProcesso),
        'Memória: ' + memoriaMb + ' MB',
        'Node: ' + process.version,
        '',
        'Operadores online: ' + operadoresOnline.length,
        'Bancas liberadas: ' + totalBancasEnviadas,
        'Pagamentos pendentes: ' + pagamentosPendentes.size,
        'Blacklist: ' + blacklistCache.length
      ].join('\n')
    });

    return true;
  }


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

    await salvarBlacklist(lista);

    await sock.sendMessage(remetente, {
      text:
`✅ ADICIONADO Ã€ BLACKLIST

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

    await salvarBlacklist(novaLista);

    await sock.sendMessage(remetente, {
      text:
`✅ REMOVIDO DA BLACKLIST

👤 ${nome}`
    });

    return true;
  }


  if (comando === '/desbugafila') {
    const reparo = desbugarFila();
    const lista = operadoresOnline.length
      ? operadoresOnline.map((jid, i) => {
          const marcador = i === indiceOperador ? '➡️' : `${i + 1}.`;
          return `${marcador} ${operadorNome(jid)}`;
        }).join('\n')
      : 'Nenhum operador online.';

    const proximo = operadoresOnline.length
      ? operadorNome(operadoresOnline[indiceOperador])
      : 'Nenhum';

    await sock.sendMessage(remetente, {
      text:
`🛠️ DESBUGA FILA

👥 Operadores online: ${operadoresOnline.length}
${lista}

⭐ Próximo: ${proximo}
📦 Bancas ativas: ${bancaAtivaPorCliente.size}
💳 Pagamentos pendentes: ${pagamentosPendentes.size}

🔧 Reparos executados:
• Duplicados removidos: ${reparo.duplicadosRemovidos}
• Bancas órfãs removidas: ${reparo.bancasOrfas}
• Pagamentos inválidos removidos: ${reparo.pagamentosInvalidos}

✅ Fila verificada e reconstruída.`
    });

    return true;
  }

  if (comando === '/fila') {
    normalizarFilaOperadores();
    const lista = operadoresOnline.length
      ? operadoresOnline.map((jid, i) => {
          const marcador = i === indiceOperador ? '➡️' : `${i + 1}.`;
          return `${marcador} ${operadorNome(jid)}`;
        }).join('\n')
      : 'Nenhum operador online.';

    await sock.sendMessage(remetente, {
      text: `📋 FILA DE OPERADORES\n\n${lista}`
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

    const tempoOnline = formatarDuracao(
      Date.now() - inicioProcesso
    );

    await sock.sendMessage(remetente, {
      text:
`📊 ESTATÍSTICAS

🟢 Tempo online: ${tempoOnline}

💰 Pix gerados: ${totalPixGerados}
✅ Pix pagos: ${totalPixPagos}
📦 Bancas liberadas: ${totalBancasEnviadas}
💳 Bancas pendentes: ${bancasPagasPendentes.length}
💳 Pagamentos pendentes: ${pagamentosPendentes.size}

👥 Operadores online: ${operadoresOnline.length}
⭐ Próximo da fila: ${proximo}
🚫 Blacklist: ${blacklistCache.length}`
    });

    return true;
  }

  if (comando === '/reset') {
    operadoresOnline = [];
    operadoresInfo.clear();
    indiceOperador = 0;
    totalBancasEnviadas = 0;
    totalPixGerados = 0;
    totalPixPagos = 0;
    bancasPorMensagemOriginal.clear();
    bancasPorMensagemOperador.clear();
    bancaAtivaPorCliente.clear();
    bancaAtivaPorOperador.clear();
    pagamentosPendentes.clear();
    linksEmProcessamento.clear();
    historicoNext.clear();
    bancasPagasPendentes.length = 0;

    await sock.sendMessage(remetente, {
      text:
`♻️ Sistema resetado

Fila zerada
Ãndice reiniciado
Bancas temporárias limpas
Pagamentos pendentes limpos`
    });

    return true;
  }

  if (comando === '/next') {
    normalizarFilaOperadores();

    if (!operadoresOnline.length) {
      await sock.sendMessage(remetente, {
        text: '⚠️ Nenhum operador online.'
      });

      return true;
    }

    const quoted = getQuotedInfo(msg.message);

    if (!quoted.stanzaId) {
      await sock.sendMessage(remetente, {
        text: '⚠️ Responda à mensagem do cliente com /next.'
      });

      return true;
    }

    const linkId = quoted.stanzaId;

    if (
      linksEmProcessamento.has(linkId) ||
      bancasPorMensagemOriginal.has(linkId)
    ) {
      const registro = historicoNext.get(linkId);

      await sock.sendMessage(remetente, {
        text:
`⚠️ Este link já foi enviado ou está sendo processado.

Não foi criada uma banca duplicada.${registro
  ? `

Último envio:
Atendente: ${registro.atendenteNome}
Operador: ${registro.operadorNome}
Horário: ${registro.horario}`
  : ''}`
      });

      return true;
    }

    const textoBanca = textoDaQuotedMessage(
      quoted.quotedMessage
    );

    if (!textoBanca) {
      await sock.sendMessage(remetente, {
        text: '⚠️ Não consegui ler a banca respondida.'
      });

      return true;
    }

    linksEmProcessamento.add(linkId);

    try {
      const banca = {
        originalMessageId: linkId,
        clienteJid: msg.key.remoteJid,
        textoBanca,
        valor: 'manual',
        fotosEnviadas: 0,
        atendenteJid: autorJid,
        atendenteNome: autorNome,
        criadaEm: new Date().toISOString(),

        mensagemOriginal: {
          key: {
            remoteJid: msg.key.remoteJid,
            fromMe: false,
            id: linkId,
            participant:
              quoted.participant || undefined
          },
          message: quoted.quotedMessage
        }
      };

      const resultado =
        await liberarBancaParaOperador(banca);

      if (resultado?.ok) {
        historicoNext.set(linkId, {
          atendenteJid: autorJid,
          atendenteNome: autorNome,
          operadorJid: resultado.operadorJid,
          operadorNome: resultado.operadorNome,
          horario: new Date().toLocaleString(
            'pt-BR',
            {
              timeZone: 'America/Sao_Paulo'
            }
          )
        });
      }

      return true;
    } catch (err) {
      console.error(
        '[FILA] Erro ao distribuir banca:',
        err
      );

      bancasPorMensagemOriginal.delete(linkId);
      historicoNext.delete(linkId);

      await sock.sendMessage(remetente, {
        text:
`❌ Não foi possível enviar a banca ao operador.

Tente novamente em alguns segundos.`
      });

      return true;
    } finally {
      linksEmProcessamento.delete(linkId);
    }
  }

  if (comando === '/renext') {
    const quoted = getQuotedInfo(msg.message);

    if (!quoted.stanzaId) {
      await sock.sendMessage(remetente, {
        text:
`⚠️ Responda à mensagem original com:

/renext`
      });

      return true;
    }

    const linkId = quoted.stanzaId;

    linksEmProcessamento.delete(linkId);

    const bancaAnterior =
      bancasPorMensagemOriginal.get(linkId);

    if (bancaAnterior?.operadorJid) {
      bancaAtivaPorOperador.delete(
        bancaAnterior.operadorJid
      );
    }

    bancasPorMensagemOriginal.delete(linkId);
    historicoNext.delete(linkId);

    await sock.sendMessage(remetente, {
      text:
`✅ Trava removida.

Agora responda novamente ao mesmo link com /next.`
    });

    return true;
  }

  if (comando.startsWith('/pix ')) {
    const partes = String(texto || '').trim().split(/\s+/);
    const valor = Number(
      String(partes[1] || '').replace(',', '.')
    );

    if (!valor || valor <= 0) {
      await sock.sendMessage(remetente, {
        text:
`⚠️ Uso correto:

/pix 500`
      });

      return true;
    }

    try {
      const quoted = getQuotedInfo(msg.message);

      /*
       * Ordem para localizar a banca:
       *
       * 1. Mensagem original respondida;
       * 2. Mensagem enviada ao operador respondida;
       * 3. Sessão ativa da conversa atual como cliente;
       * 4. Sessão ativa da conversa atual como operador;
       * 5. Cobrança avulsa.
       */
      let banca = null;

      if (quoted.stanzaId) {
        banca =
          bancasPorMensagemOriginal.get(quoted.stanzaId) ||
          bancasPorMensagemOperador.get(quoted.stanzaId) ||
          null;
      }

      if (!banca) {
        banca =
          bancaAtivaPorCliente.get(remetente) ||
          bancaAtivaPorOperador.get(remetente) ||
          null;
      }

      /*
       * O /pix também funciona sem /next.
       * Nesse caso, cria uma cobrança avulsa para a conversa atual.
       */
      if (!banca) {
        banca = {
          originalMessageId: '',
          clienteJid: remetente,
          textoBanca: 'Cobrança avulsa',
          valor,
          fotosEnviadas: 0,
          pagamentoConfirmado: false,
          operadorJid: null,
          operadorNome: null,
          cobrancaAvulsa: true
        };

        bancaAtivaPorCliente.set(remetente, banca);
      }

      const pix = await gerarPixMercadoPago(
        valor,
        `Banca Meia do Lucão - R$ ${valor.toFixed(2)}`
      );

      totalPixGerados++;

      banca.paymentId = pix.id;
      banca.valor = valor;
      banca.pagamentoConfirmado = false;

      /*
       * A confirmação automática já utiliza este Map.
       */
      pagamentosPendentes.set(
        String(pix.id),
        banca
      );

      bancaAtivaPorCliente.set(
        banca.clienteJid,
        banca
      );

      if (banca.operadorJid) {
        bancaAtivaPorOperador.set(
          banca.operadorJid,
          banca
        );

        await sock.sendMessage(banca.operadorJid, {
          text:
`💰 VALOR DEFINIDO

💵 Valor: R$ ${valor.toFixed(2).replace('.', ',')}

⏳ Aguardando pagamento...`
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
        text:
`✅ Pix criado com sucesso.

ID: ${pix.id}

A confirmação será automática após o pagamento.`
      });
    } catch (err) {
      const detalhes =
        err.response?.data?.message ||
        err.response?.data?.cause?.[0]?.description ||
        err.message ||
        'Erro desconhecido';

      console.error(
        'Erro ao gerar Pix Mercado Pago:',
        err.response?.data || err
      );

      await sock.sendMessage(remetente, {
        text:
`âŒ NÃ£o foi possÃ­vel gerar o Pix.

${detalhes}`
      });
    }

    return true;
  }
  /*
   * Liberação manual:
   *
   * Responda à banca original com:
   * /500
   *
   * O operador recebe o valor e fica autorizado
   * a enviar a FOTO 2/2 sem pagamento automático.
   */
  if (isComandoValor(comando)) {
    const quoted = getQuotedInfo(msg.message);

    if (!quoted.stanzaId) {
      await sock.sendMessage(remetente, {
        text:
`⚠️ Responda à mensagem original da banca com o valor.

Exemplo:
/500`
      });

      return true;
    }

    const banca =
      bancasPorMensagemOriginal.get(quoted.stanzaId) ||
      bancasPorMensagemOperador.get(quoted.stanzaId);

    if (!banca) {
      await sock.sendMessage(remetente, {
        text:
`⚠️ Não encontrei uma banca vinculada a essa mensagem.

Primeiro use /next respondendo ao link do cliente.`
      });

      return true;
    }

    const valorTexto = valorDoComando(comando);
    const valorNumero = Number(valorTexto);

    if (!valorNumero || valorNumero <= 0) {
      await sock.sendMessage(remetente, {
        text: '⚠️ Valor inválido.'
      });

      return true;
    }

    banca.valor = valorNumero;
    banca.pagamentoConfirmado = true;
    banca.liberacaoManual = true;

    bancaAtivaPorCliente.set(
      banca.clienteJid,
      banca
    );

    if (banca.operadorJid) {
      bancaAtivaPorOperador.set(
        banca.operadorJid,
        banca
      );

      await sock.sendMessage(banca.operadorJid, {
        text:
`${EMOJI.OK} BANCA LIBERADA MANUALMENTE

💰 Valor para depositar:
R$ ${valorNumero.toFixed(2).replace('.', ',')}

📸 Você já pode enviar a FOTO 2/2.`
      });
    }

    await sock.sendMessage(remetente, {
      text:
`✅ Liberação manual concluída.

Valor enviado ao operador:
R$ ${valorNumero.toFixed(2).replace('.', ',')}

${banca.operadorNome || 'Operador'} já pode enviar a FOTO 2/2.`
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
      text: '⚠️ Esta banca não está vinculada a você.'
    });
    return true;
  }

  const limiteFotos = banca.pagamentoConfirmado ? 2 : 1;

  if (banca.fotosEnviadas >= limiteFotos) {
    await sock.sendMessage(remetente, {
      text: banca.pagamentoConfirmado
        ? '⛔ FOTO 2/2 já enviada. Limite final atingido.'
        : '⛔ Aguarde o pagamento do cliente para enviar a FOTO 2/2.'
    });
    return true;
  }

  const buffer = await baixarImagem(msg.message);

  if (banca.mensagemOriginal?.message) {
    await sock.sendMessage(
      banca.clienteJid,
      {
        image: buffer
      },
      {
        quoted: banca.mensagemOriginal
      }
    );
  } else {
    await sock.sendMessage(banca.clienteJid, {
      image: buffer
    });
  }

  banca.fotosEnviadas++;

  await sock.sendMessage(remetente, {
    text: `✅ Banca enviada ao cliente. (${banca.fotosEnviadas}/2)`
  });

  return true;
}

/* WHATSAPP */
async function conectarWhatsApp() {
  await carregarBlacklistRemota();
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
        const autorJid = autorDaMensagem(msg);
        const autorNome = nomeDaMensagem(msg, autorJid);
        const isAdmin = await mensagemDeAdmin(msg);
        const texto = textoDaMensagem(msg.message);
        const messageId = msg.key.id || '';

        const comandoProcessado = await entrarNaFila(() =>
          processarComandos(msg, texto, remetente, isAdmin, autorJid, autorNome)
        );

        if (comandoProcessado) continue;

        const fotoProcessada = await entrarNaFila(() =>
          processarFotoOperador(msg, remetente)
        );

        if (fotoProcessada) continue;

        if (msg.key.fromMe) continue;
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
      ? `â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”

💰 PIX RECEBIDO

👤 ${nome}
💵 R$ ${valor}

🔴 STATUS: SUSPEITO

Motivo:
• Nome presente na lista de fraude.

Ação recomendada:
âŒ NÃ£o liberar saldo
👤 Encaminhar para análise

â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”`
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
    <h2>WhatsApp â†’ Google Sheets</h2>
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




























