const fs = require('fs');
const path = require('path');

const CLIENT_ID_PADRAO = 'bot-render';
const DISCO_PERSISTENTE_RENDER = '/var/data';

function diretorioExiste(diretorio) {
  try {
    return fs.statSync(diretorio).isDirectory();
  } catch (_) {
    return false;
  }
}

function resolverDataPath({
  authPath = process.env.WWEBJS_AUTH_PATH,
  cwd = process.cwd(),
  renderDiskPath = DISCO_PERSISTENTE_RENDER
} = {}) {
  if (String(authPath || '').trim()) {
    return {
      dataPath: path.resolve(String(authPath).trim()),
      origem: 'WWEBJS_AUTH_PATH'
    };
  }

  if (diretorioExiste(renderDiskPath)) {
    return {
      dataPath: path.join(renderDiskPath, '.wwebjs_auth'),
      origem: 'disco persistente do Render'
    };
  }

  return {
    dataPath: path.resolve(cwd, '.wwebjs_auth'),
    origem: 'diretório de trabalho local'
  };
}

function nomeDiretorioSessao(clientId = CLIENT_ID_PADRAO) {
  const id = String(clientId || '').trim();
  return id ? `session-${id}` : 'session';
}

function resolverQrMaxRetries(valor = process.env.WWEBJS_QR_MAX_RETRIES) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return 0;
  const numero = Number(valor);
  return Number.isFinite(numero) ? Math.max(0, Math.trunc(numero)) : 0;
}

function analisarSessao({ dataPath, clientId = CLIENT_ID_PADRAO }) {
  const nomeSessao = nomeDiretorioSessao(clientId);
  const sessionPath = path.join(dataPath, nomeSessao);
  const defaultPath = path.join(sessionPath, 'Default');
  const localStoragePath = path.join(defaultPath, 'Local Storage', 'leveldb');
  const indexedDbPath = path.join(defaultPath, 'IndexedDB');

  let entradas = [];
  try {
    entradas = fs.readdirSync(dataPath, { withFileTypes: true });
  } catch (_) {}

  const outrasSessoes = entradas
    .filter(entrada => entrada.isDirectory() && entrada.name.startsWith('session') && entrada.name !== nomeSessao)
    .map(entrada => entrada.name)
    .sort();

  return {
    dataPath,
    clientId,
    nomeSessao,
    sessionPath,
    baseExiste: diretorioExiste(dataPath),
    perfilExiste: diretorioExiste(sessionPath),
    defaultExiste: diretorioExiste(defaultPath),
    localStorageExiste: diretorioExiste(localStoragePath),
    indexedDbExiste: diretorioExiste(indexedDbPath),
    pareceBaileys: fs.existsSync(path.join(dataPath, 'creds.json')),
    outrasSessoes
  };
}

function registrarDiagnosticoSessao(diagnostico, origem) {
  console.log('[WWEBJS][AUTH] Data path:', diagnostico.dataPath);
  console.log('[WWEBJS][AUTH] Origem do caminho:', origem);
  console.log('[WWEBJS][AUTH] Client ID:', diagnostico.clientId);
  console.log('[WWEBJS][AUTH] Perfil esperado:', diagnostico.sessionPath);

  if (diagnostico.defaultExiste && (diagnostico.localStorageExiste || diagnostico.indexedDbExiste)) {
    console.log('[WWEBJS][AUTH] Perfil Chromium encontrado; somente os eventos authenticated/ready confirmam uma sessão válida.');
    return;
  }

  if (diagnostico.pareceBaileys) {
    console.warn('[WWEBJS][AUTH] Foi encontrada uma sessão Baileys (creds.json). Ela não é compatível com LocalAuth.');
  }

  if (diagnostico.outrasSessoes.length) {
    console.warn(
      '[WWEBJS][AUTH] Há perfis LocalAuth com outro clientId:',
      diagnostico.outrasSessoes.join(', ')
    );
  }

  if (!diagnostico.perfilExiste) {
    console.warn('[WWEBJS][AUTH] O perfil esperado não existe. A existência apenas da pasta-pai não representa uma sessão autenticada.');
  } else if (!diagnostico.defaultExiste) {
    console.warn('[WWEBJS][AUTH] O perfil esperado está incompleto: diretório Default ausente.');
  } else {
    console.warn('[WWEBJS][AUTH] O perfil Chromium existe, mas não contém os armazenamentos esperados de autenticação.');
  }
}

module.exports = {
  CLIENT_ID_PADRAO,
  DISCO_PERSISTENTE_RENDER,
  analisarSessao,
  nomeDiretorioSessao,
  registrarDiagnosticoSessao,
  resolverDataPath,
  resolverQrMaxRetries
};
