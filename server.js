

require('dotenv').config();
const fs = require('fs');
const https = require('https');
const axios = require('axios');
const crypto = require('crypto');
const {
  msgPixRecebido
} = require('./src/ui');

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
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_TASKS_TABLE = process.env.SUPABASE_TASKS_TABLE || 'artauto_tasks';
const ARTAUTO_ENABLED = process.env.ARTAUTO_ENABLED === 'true' && !!SUPABASE_URL && !!SUPABASE_SERVICE_ROLE_KEY;
const ARTAUTO_POLL_MS = Number(process.env.ARTAUTO_POLL_MS) || 5000;

const ARTAUTO_AUTHORIZED_JIDS = [
  '554197319202@s.whatsapp.net',
  '223566721249408@lid'
];



const EMOJI = Object.freeze({
  OK: 'âœ…',
  ERRO: 'â›”',
  ALERTA: 'âš ï¸',
  PIX: 'ðŸ’°',
  PESSOA: 'ðŸ‘¤',
  DINHEIRO: 'ðŸ’µ',
  FOTO: 'ðŸ“¸',
  OPERADOR: 'ðŸ‘¨â€ðŸ’»',
  ESTATISTICAS: 'ðŸ“Š',
  FILA: 'ðŸ“‹',
  FERRAMENTA: 'ðŸ› ï¸',
  ESTRELA: 'â­',
  RECICLAR: 'â™»ï¸',
  LIMPAR: 'ðŸ§¹',
  GRUPO: 'ðŸ‘¥'
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
 * SessÃµes ativas:
 * - clienteJid -> banca daquele cliente
 * - operadorJid -> banca daquele operador
 */
const bancaAtivaPorCliente = new Map();
const bancaAtivaPorOperador = new Map();
const pagamentosPendentes = new Map();
const bancasPagasPendentes = [];

const MSG_DEPOSITO_CONFIRMADO =
`âœ… DEU CERTO! DEPÃ“SITO CONFIRMADO!

âš ï¸ ATENÃ‡ÃƒO - MUITO IMPORTANTE!

Meu nÃºmero de atendimento pode cair a qualquer momento!

Se a mensagem NÃƒO CHEGAR, nÃ£o fique sem resposta!

ðŸ“² CHAMA DIRETO NO NÃšMERO RESERVA:
48 98425-5049

ðŸ• HorÃ¡rio de atendimento:
Todos os dias das 09:00 Ã s 00:30

ðŸ™ Obrigado pela confianÃ§a!

Att: Equipe Meia do LucÃ£o`;

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
    console.warn('Gist nÃ£o configurado. Blacklist usando apenas arquivo local.');
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
      throw new Error('blacklist.json nÃ£o encontrado no Gist.');
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
  const match = String(texto || '').match(/ðŸ‘¤\s*(.+)/i);
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
      'MERCADO_PAGO_ACCESS_TOKEN nÃ£o configurado no Render.'
    );
  }

  const numero = Number(valor);

  if (!numero || numero <= 0) {
    throw new Error('Valor invÃ¡lido.');
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
      'Mercado Pago nÃ£o retornou Pix Copia e Cola:',
      data
    );

    throw new Error(
      'Mercado Pago nÃ£o retornou o Pix Copia e Cola.'
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
      'MERCADO_PAGO_ACCESS_TOKEN nÃ£o configurado no Render.'
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
`ðŸ’° PAGAMENTO CONFIRMADO

Banca liberada.

Agora vocÃª pode enviar a FOTO 2/2.`
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
          text: `âš ï¸ Pagamento nÃ£o aprovado. Status: ${data.status}`
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

  throw new Error('NÃ£o encontrei linha vazia antes do TOTAL.');
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
    spreadsheet…6424 tokens truncated…orMensagemOriginal.get(quoted.stanzaId) ||
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
       * O /pix tambÃ©m funciona sem /next.
       * Nesse caso, cria uma cobranÃ§a avulsa para a conversa atual.
       */
      if (!banca) {
        banca = {
          originalMessageId: '',
          clienteJid: remetente,
          textoBanca: 'CobranÃ§a avulsa',
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
        `Banca Meia do LucÃ£o - R$ ${valor.toFixed(2)}`
      );

      totalPixGerados++;

      banca.paymentId = pix.id;
      banca.valor = valor;
      banca.pagamentoConfirmado = false;

      /*
       * A confirmaÃ§Ã£o automÃ¡tica jÃ¡ utiliza este Map.
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
`ðŸ’° VALOR DEFINIDO

ðŸ’µ Valor: R$ ${valor.toFixed(2).replace('.', ',')}

â³ Aguardando pagamento...`
        });
      }

      if (pix.qr_code) {
        /*
         * Gera o QR do pagamento a partir do cÃ³digo copia e cola.
         * Falhas na imagem nÃ£o invalidam a cobranÃ§a jÃ¡ criada.
         */
        try {
          const qrPixBuffer = await QRCode.toBuffer(
            pix.qr_code,
            {
              type: 'png',
              errorCorrectionLevel: 'M',
              margin: 2,
              width: 512
            }
          );

          await sock.sendMessage(remetente, {
            image: qrPixBuffer,
            caption:
`âœ… PIX GERADO

ðŸ’µ Valor: R$ ${valor.toFixed(2).replace('.', ',')}

Escaneie o QR Code ou use o copia e cola abaixo.`
          });
        } catch (qrErr) {
          console.error(
            'Erro ao gerar/enviar imagem do QR Pix:',
            qrErr
          );

          await sock.sendMessage(remetente, {
            text:
`âš ï¸ O Pix foi criado, mas nÃ£o consegui enviar a imagem do QR Code.

Use o cÃ³digo copia e cola abaixo.`
          });
        }

        await sock.sendMessage(remetente, {
          text: 'ðŸ“‹ PIX COPIA E COLA:'
        });

        await sock.sendMessage(remetente, {
          text: pix.qr_code
        });
      }

      await sock.sendMessage(remetente, {
        text:
`âœ… Pix criado com sucesso.

ID: ${pix.id}

A confirmaÃ§Ã£o serÃ¡ automÃ¡tica apÃ³s o pagamento.`
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
`Ã¢ÂÅ’ NÃƒÂ£o foi possÃƒÂ­vel gerar o Pix.

${detalhes}`
      });
    }

    return true;
  }
  /*
   * LiberaÃ§Ã£o manual:
   *
   * Responda Ã  banca original com:
   * /500
   *
   * O operador recebe o valor e fica autorizado
   * a enviar a FOTO 2/2 sem pagamento automÃ¡tico.
   */
  if (isComandoValor(comando)) {
    const quoted = getQuotedInfo(msg.message);

    if (!quoted.stanzaId) {
      await sock.sendMessage(remetente, {
        text:
`âš ï¸ Responda Ã  mensagem original da banca com o valor.

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
`âš ï¸ NÃ£o encontrei uma banca vinculada a essa mensagem.

Primeiro use /next respondendo ao link do cliente.`
      });

      return true;
    }

    const valorTexto = valorDoComando(comando);
    const valorNumero = Number(valorTexto);

    if (!valorNumero || valorNumero <= 0) {
      await sock.sendMessage(remetente, {
        text: 'âš ï¸ Valor invÃ¡lido.'
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

ðŸ’° Valor para depositar:
R$ ${valorNumero.toFixed(2).replace('.', ',')}

ðŸ“¸ VocÃª jÃ¡ pode enviar a FOTO 2/2.`
      });
    }

    await sock.sendMessage(remetente, {
      text:
`âœ… LiberaÃ§Ã£o manual concluÃ­da.

Valor enviado ao operador:
R$ ${valorNumero.toFixed(2).replace('.', ',')}

${banca.operadorNome || 'Operador'} jÃ¡ pode enviar a FOTO 2/2.`
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
      text: 'âš ï¸ Esta banca nÃ£o estÃ¡ vinculada a vocÃª.'
    });
    return true;
  }

  const limiteFotos = banca.pagamentoConfirmado ? 2 : 1;

  if (banca.fotosEnviadas >= limiteFotos) {
    await sock.sendMessage(remetente, {
      text: banca.pagamentoConfirmado
        ? 'â›” FOTO 2/2 jÃ¡ enviada. Limite final atingido.'
        : 'â›” Aguarde o pagamento do cliente para enviar a FOTO 2/2.'
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
    text: `âœ… Banca enviada ao cliente. (${banca.fotosEnviadas}/2)`
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
      console.log('QR disponÃ­vel em /qr');
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

      console.log('ConexÃ£o fechada. Reconectar:', shouldReconnect);

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

        if (ARTAUTO_ENABLED) {
          entrarNaFila(() => artautoProcessarMensagem(msg, texto, remetente, messageId));
        }

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

ðŸ“… ${dataHoje}

Nenhum PIX registrado atÃ© agora.`;
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

ðŸ“… ${dataHoje}

`;

  for (const [cliente, dados] of Object.entries(porCliente)) {
    totalGeral += dados.total;
    qtdGeral += dados.qtd;

    texto += `ðŸ‘¤ ${cliente}
Qtd: ${dados.qtd}
Total: ${moedaBR(dados.total)}

`;
  }

  texto += `ðŸ’° TOTAL GERAL: ${moedaBR(totalGeral)}
ðŸ”¢ QTD GERAL: ${qtdGeral}`;

  return texto;
}
app.post('/pix/:cliente', async (req, res) => {
  try {
    const cliente = String(req.params.cliente || '').toLowerCase();
    const destino = DESTINOS_PIX[cliente];

    if (!destino) {
      return res.status(404).json({
        sucesso: false,
        erro: 'Cliente nÃ£o cadastrado'
      });
    }

    if (!sock) {
      return res.status(503).json({
        sucesso: false,
        erro: 'WhatsApp nÃ£o conectado'
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

    const mensagemPix = msgPixRecebido(
      nome,
      valor,
      Boolean(registroFraude)
    );

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
    <h2>WhatsApp Ã¢â€ â€™ Google Sheets</h2>
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

/* ARTAUTO - IntegraÃ§Ã£o Supabase */
const artautoLock = { polling: false };

function artautoExtrairATD(texto) {
  const flowMatch = String(texto || '').match(/ATD:\s*flow-([\w-]+)/i);
  if (flowMatch) return { atd_type: 'flow', atd_id: flowMatch[1], atd_raw: flowMatch[0] };

  const cicloMatch = String(texto || '').match(/ATD:\s*ciclo-([\w-]+)/i);
  if (cicloMatch) return { atd_type: 'ciclo', atd_id: cicloMatch[1], atd_raw: cicloMatch[0] };

  return null;
}

function artautoExtrairURL(texto) {
  const match = String(texto || '').match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : '';
}

async function artautoCriarTarefa(messageId, urlLink, atdData, senderJid, replyToJid) {
  const apiUrl = `${SUPABASE_URL}/rest/v1/${SUPABASE_TASKS_TABLE}`;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
  };

  const checkUrl = `${apiUrl}?message_id=eq.${encodeURIComponent(messageId)}&select=message_id`;
  const checkRes = await fetch(checkUrl, { headers: { ...headers, Accept: 'application/json' } });
  if (checkRes.ok) {
    const existing = await checkRes.json();
    if (existing && existing.length > 0) return false;
  }

  const body = {
    message_id: messageId,
    status: 'pending',
    url: urlLink,
    atd_type: atdData.atd_type,
    atd_id: atdData.atd_id,
    atd_raw: atdData.atd_raw,
    sender_jid: senderJid,
    reply_to_jid: replyToJid,
    reply_status: null
  };

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('[ARTAUTO] Erro ao criar tarefa:', res.status, errText.slice(0, 200));
    return false;
  }

  return true;
}

async function artautoProcessarMensagem(msg, texto, remetente, messageId) {
  if (!ARTAUTO_ENABLED) return;
  if (String(remetente || '').endsWith('@g.us')) return;
  if (!ARTAUTO_AUTHORIZED_JIDS.includes(remetente)) return;

  const url = artautoExtrairURL(texto);
  if (!url) return;

  const atdData = artautoExtrairATD(texto);
  if (!atdData) return;

  const replyToJid = autorDaMensagem(msg) || remetente;

  const created = await artautoCriarTarefa(messageId, url, atdData, remetente, replyToJid);

  if (created) {
    await sock.sendMessage(remetente, {
      text: `ðŸ¤– ArtAuto recebeu a banca!\n\nðŸ“Œ ${atdData.atd_raw}\nðŸ”— ${url}\n\nâ³ Processando...`
    });
  }
}

async function artautoAtualizarReplyStatus(messageId, replyStatus) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;

  const apiUrl = `${SUPABASE_URL}/rest/v1/${SUPABASE_TASKS_TABLE}?message_id=eq.${encodeURIComponent(messageId)}`;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
  };

  await fetch(apiUrl, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ reply_status: replyStatus })
  });
}

async function artautoProcessarResultado(task) {
  const { message_id, reply_to_jid, atd_type, atd_id, status, print_url, error } = task;
  if (!reply_to_jid) return;

  if (status === 'completed' || status === 'timeout') {
    if (print_url) {
      try {
        const response = await axios.get(print_url, {
          responseType: 'arraybuffer',
          timeout: 30000,
          maxContentLength: 10 * 1024 * 1024
        });

        await sock.sendMessage(reply_to_jid, {
          image: Buffer.from(response.data),
          caption: `ðŸ¤– ArtAuto\n\nðŸ“Œ ${String(atd_type || '').toUpperCase()}: ${atd_id}\nâœ… Status: ${status}`
        });

        await artautoAtualizarReplyStatus(message_id, 'sent');
      } catch (err) {
        console.error('[ARTAUTO] Erro ao baixar/enviar print:', err.message);
      }
    } else {
      await sock.sendMessage(reply_to_jid, {
        text: `ðŸ¤– ArtAuto\n\nðŸ“Œ ${String(atd_type || '').toUpperCase()}: ${atd_id}\nâš ï¸ Status: ${status}, mas o print nÃ£o foi disponibilizado.`
      });
      await artautoAtualizarReplyStatus(message_id, 'sent');
    }
  } else if (status === 'failed') {
    const msg = error ? `Erro: ${String(error).slice(0, 500)}` : 'Status: failed';
    await sock.sendMessage(reply_to_jid, {
      text: `ðŸ¤– ArtAuto\n\nðŸ“Œ ${String(atd_type || '').toUpperCase()}: ${atd_id}\nâŒ ${msg}`
    });
    await artautoAtualizarReplyStatus(message_id, 'sent');
  }
}

async function artautoPolling() {
  if (!ARTAUTO_ENABLED || !sock) return;
  if (artautoLock.polling) return;

  artautoLock.polling = true;

  try {
    const apiUrl = `${SUPABASE_URL}/rest/v1/${SUPABASE_TASKS_TABLE}?reply_status=eq.pending&status=in.(completed,timeout,failed)&order=created_at.asc&limit=5`;
    const headers = {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json'
    };

    const res = await fetch(apiUrl, { headers });

    if (!res.ok) {
      console.error('[ARTAUTO] Erro no polling:', res.status);
      return;
    }

    const tasks = await res.json();
    if (!Array.isArray(tasks) || tasks.length === 0) return;

    for (const task of tasks) {
      try {
        await artautoProcessarResultado(task);
      } catch (err) {
        console.error('[ARTAUTO] Erro ao processar resultado:', err);
      }
    }
  } catch (err) {
    console.error('[ARTAUTO] Erro no polling:', err);
  } finally {
    artautoLock.polling = false;
  }
}

if (ARTAUTO_ENABLED) {
  setInterval(() => artautoPolling(), ARTAUTO_POLL_MS);
  console.log('[ARTAUTO] Polling iniciado a cada', ARTAUTO_POLL_MS, 'ms');
}




























