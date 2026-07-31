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

/*
 * O server.js pode ter sido ajustado pelo patch-baileys-reconnect.js e,
 * por isso, a lista de imports do Baileys não é necessariamente idêntica
 * à versão original. Localizamos o require completo por expressão regular,
 * preservamos seu conteúdo e apenas acrescentamos o provider wwebjs abaixo.
 */
const regexImportBaileys = /const\s*\{[\s\S]*?\}\s*=\s*require\(['"]@whiskeysockets\/baileys['"]\);/m;
const importBaileysEncontrado = codigo.match(regexImportBaileys)?.[0];

if (!importBaileysEncontrado) {
  throw new Error('Importação do Baileys não encontrada; nenhuma alteração foi gravada.');
}

codigo = codigo.replace(
  importBaileysEncontrado,
  `const WHATSAPP_PROVIDER = String(process.env.WHATSAPP_PROVIDER || 'baileys').toLowerCase();
${importBaileysEncontrado.replace(
    /require\(['"]@whiskeysockets\/baileys['"]\)/,
    "(WHATSAPP_PROVIDER === 'baileys' ? require('@whiskeysockets/baileys') : require('./src/whatsapp/baileys-compat'))"
  )}

const { criarProvider: criarWwebjsProvider } = require('./src/whatsapp/wwebjs-provider');
let wwebjsProvider = null;`
);

const assinaturaRegex = /async\s+function\s+conectarWhatsApp\s*\(\s*\)\s*\{/;
if (!assinaturaRegex.test(codigo)) {
  throw new Error('Função conectarWhatsApp não encontrada; nenhuma alteração foi gravada.');
}
codigo = codigo.replace(assinaturaRegex, 'async function conectarWhatsAppBaileys() {');

const ancoraRegex = /\nfunction\s+numeroPixBR\s*\(valor\)\s*\{/;
const ancoraMatch = codigo.match(ancoraRegex)?.[0];
if (!ancoraMatch) {
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
  let recuperacaoLogoutTimer = null;

  const cancelarRecuperacaoLogout = () => {
    if (!recuperacaoLogoutTimer) return;
    clearTimeout(recuperacaoLogoutTimer);
    recuperacaoLogoutTimer = null;
  };

  wwebjsProvider = criarWwebjsProvider({
    headless: String(process.env.WWEBJS_HEADLESS || (process.env.RENDER ? 'true' : 'false')).toLowerCase() === 'true'
  });
  sock = wwebjsProvider;

  wwebjsProvider.on('qr', qr => {
    cancelarRecuperacaoLogout();
    qrAtual = qr;
    status = 'aguardando_qr';
    console.log('[WWEBJS] QR disponível em /qr. A sessão existente não foi apagada.');
  });
  wwebjsProvider.on('authenticated', () => {
    cancelarRecuperacaoLogout();
    qrAtual = '';
    status = 'autenticado';
    console.log('[WWEBJS] Sessão autenticada.');
  });
  wwebjsProvider.on('loading_screen', (percentual, mensagem) => {
    const memoriaMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (Number(percentual) >= 99) qrAtual = '';
    status = 'sincronizando';
    console.log(\`[WWEBJS] Sincronizando: \${percentual}% \${mensagem || ''} (RSS: \${memoriaMb} MB)\`);
  });
  wwebjsProvider.on('change_state', estado => {
    console.log('[WWEBJS] Estado interno:', estado);
  });
  wwebjsProvider.on('ready', () => {
    cancelarRecuperacaoLogout();
    qrAtual = '';
    status = 'conectado';
    console.log('[WWEBJS] WhatsApp conectado e pronto.');
  });
  wwebjsProvider.on('disconnected', motivo => {
    console.error('[WWEBJS] Desconectado:', motivo);

    if (String(motivo).toUpperCase() === 'LOGOUT') {
      qrAtual = '';
      status = 'preparando_novo_qr';
      console.warn('[WWEBJS] Logout confirmado. O LocalAuth invalidou a sessão; aguardando novo QR em /qr.');

      cancelarRecuperacaoLogout();
      recuperacaoLogoutTimer = setTimeout(async () => {
        if (status !== 'preparando_novo_qr') return;

        console.error('[WWEBJS] Novo QR não apareceu após logout. Reiniciando o processo sem apagar a sessão.');
        try {
          await wwebjsProvider.destroy();
        } catch (erro) {
          console.warn('[WWEBJS] Falha ao encerrar cliente antes do reinício:', erro.message);
        }
        process.exit(1);
      }, Number(process.env.WWEBJS_LOGOUT_QR_TIMEOUT_MS) || 45000);
      return;
    }

    status = 'desconectado';
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

codigo = codigo.replace(ancoraMatch, `${novoTransporte}${ancoraMatch}`);

codigo = codigo.replace(
  "app.get('/qr', async (req, res) => {\n",
  "app.get('/qr', async (req, res) => {\n  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');\n"
);
codigo = codigo.replace(
  '    <h2>Escaneie o QR</h2>',
  '    <meta http-equiv="refresh" content="10">\\n    <h2>Escaneie o QR</h2>'
);

const listenSeguro = `app.listen(PORT, () => {
  console.log(\`Servidor rodando na porta \${PORT}\`);
  conectarWhatsApp().catch(erro => {
    status = 'erro_wwebjs';
    console.error('[WHATSAPP] Falha fatal ao inicializar:', erro);
    setTimeout(() => process.exit(1), 1000);
  });
});

let encerrandoWhatsApp = false;
async function encerrarWhatsApp(sinal) {
  if (encerrandoWhatsApp) return;
  encerrandoWhatsApp = true;
  console.log(\`[WHATSAPP] Encerramento gracioso (\${sinal}); persistindo sessão...\`);
  try {
    if (wwebjsProvider) await wwebjsProvider.destroy();
  } catch (erro) {
    console.warn('[WHATSAPP] Falha ao encerrar provider:', erro.message);
  } finally {
    process.exit(0);
  }
}
process.once('SIGTERM', () => encerrarWhatsApp('SIGTERM'));
process.once('SIGINT', () => encerrarWhatsApp('SIGINT'));`;
const listenRegex = /app\.listen\(\s*PORT\s*,\s*\(\)\s*=>\s*\{\s*console\.log\(\s*`Servidor rodando na porta \$\{PORT\}`\s*\);\s*conectarWhatsApp\(\s*\);\s*\}\s*\);/m;
if (!listenRegex.test(codigo)) {
  throw new Error('Inicialização HTTP esperada não encontrada; nenhuma alteração foi gravada.');
}
codigo = codigo.replace(listenRegex, listenSeguro);

const downloadRegex = /const\s+buffer\s*=\s*await\s+baixarImagem\s*\(\s*msg\.message\s*\)\s*;/;
if (!downloadRegex.test(codigo)) {
  throw new Error('Ponto de download de imagem não encontrado; nenhuma alteração foi gravada.');
}
codigo = codigo.replace(
  downloadRegex,
  `const buffer = msg._wwebjsRaw && wwebjsProvider
    ? await wwebjsProvider.downloadMedia(msg._wwebjsRaw)
    : await baixarImagem(msg.message);`
);

fs.writeFileSync(arquivo, codigo, 'utf8');
console.log('[MIGRAÇÃO] server.js atualizado para provider selecionável.');
