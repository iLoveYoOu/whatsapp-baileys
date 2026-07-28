const fs = require('fs');

const arquivo = './server.js';
let codigo = fs.readFileSync(arquivo, 'utf8');

if (codigo.includes('BAILEYS_RECONNECT_FIX_V2')) {
  console.log('[PATCH] Trava de reconexão já aplicada.');
  process.exit(0);
}

const estadoAntigo = "let status = 'iniciando';";
const estadoNovo = `let status = 'iniciando';
// BAILEYS_RECONNECT_FIX_V2
let conectandoWhatsApp = false;
let timerReconexao = null;
let tentativaReconexao = 0;
const MAX_TENTATIVAS_RECONEXAO = 8;
const PAUSA_SEGURANCA_MS = 15 * 60 * 1000;`;

if (!codigo.includes(estadoAntigo)) throw new Error('Estado do WhatsApp não encontrado.');
codigo = codigo.replace(estadoAntigo, estadoNovo);

const inicioAntigo = `async function conectarWhatsApp() {
  await carregarBlacklistRemota();`;
const inicioNovo = `async function conectarWhatsApp() {
  if (conectandoWhatsApp) {
    console.log('[WA] Trava ativa: conexão já em andamento.');
    return;
  }

  conectandoWhatsApp = true;
  status = 'conectando';

  try {
    await carregarBlacklistRemota();`;

if (!codigo.includes(inicioAntigo)) throw new Error('Início de conectarWhatsApp não encontrado.');
codigo = codigo.replace(inicioAntigo, inicioNovo);

const blocoAntigo = `    if (connection === 'open') {
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
    }`;

const blocoNovo = `    if (connection === 'open') {
      status = 'conectado';
      qrAtual = '';
      tentativaReconexao = 0;
      conectandoWhatsApp = false;
      if (timerReconexao) {
        clearTimeout(timerReconexao);
        timerReconexao = null;
      }
      console.log('[WA] WhatsApp conectado');
    }

    if (connection === 'close') {
      conectandoWhatsApp = false;

      const erro = lastDisconnect?.error;
      const statusCode = erro?.output?.statusCode || erro?.statusCode || erro?.data?.statusCode || null;
      const motivo = erro?.output?.payload?.message || erro?.message || erro?.data?.message || 'motivo não informado';
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      console.error('[WA] Conexão fechada', {
        statusCode,
        motivo,
        tentativa: tentativaReconexao + 1,
        loggedOut,
        erro: erro?.stack || String(erro || '')
      });

      if (loggedOut) {
        status = 'deslogado';
        qrAtual = '';
        tentativaReconexao = 0;
        console.error('[WA] Sessão deslogada. Reconexão automática bloqueada para evitar loop.');
        return;
      }

      tentativaReconexao += 1;

      if (tentativaReconexao >= MAX_TENTATIVAS_RECONEXAO) {
        status = 'pausa_seguranca';
        console.error('[WA] Trava de segurança ativada após', tentativaReconexao, 'falhas. Pausa de 15 minutos.');
        tentativaReconexao = 0;
        if (timerReconexao) clearTimeout(timerReconexao);
        timerReconexao = setTimeout(() => {
          timerReconexao = null;
          conectarWhatsApp().catch(console.error);
        }, PAUSA_SEGURANCA_MS);
        return;
      }

      status = 'reconectando';
      const atraso = Math.min(5000 * tentativaReconexao, 60000);
      if (timerReconexao) clearTimeout(timerReconexao);
      timerReconexao = setTimeout(() => {
        timerReconexao = null;
        conectarWhatsApp().catch(err => {
          conectandoWhatsApp = false;
          console.error('[WA] Falha ao reconectar:', err);
        });
      }, atraso);

      console.log('[WA] Nova tentativa em', atraso, 'ms');
    }`;

if (!codigo.includes(blocoAntigo)) throw new Error('Bloco connection.update não encontrado.');
codigo = codigo.replace(blocoAntigo, blocoNovo);

const finalAntigo = `  sock.ev.on('messages.update', async (updates) => {`;
const finalNovo = `  } catch (err) {
    conectandoWhatsApp = false;
    status = 'erro_conexao';
    console.error('[WA] Erro ao iniciar conexão:', err?.stack || err);
    if (timerReconexao) clearTimeout(timerReconexao);
    timerReconexao = setTimeout(() => {
      timerReconexao = null;
      conectarWhatsApp().catch(console.error);
    }, 60000);
    return;
  }

  sock.ev.on('messages.update', async (updates) => {`;

if (!codigo.includes(finalAntigo)) throw new Error('Listener messages.update não encontrado.');
codigo = codigo.replace(finalAntigo, finalNovo);

fs.writeFileSync(arquivo, codigo, 'utf8');
console.log('[PATCH] Diagnóstico e trava de segurança do Baileys aplicados.');
