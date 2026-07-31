/*
 * Compatibilidade mínima usada quando o provider ativo é whatsapp-web.js.
 * Evita carregar Baileys e toda a árvore de dependências na mesma instância.
 */
function getContentType(message) {
  if (!message || typeof message !== 'object') return undefined;
  return Object.keys(message).find(chave => message[chave] != null);
}

function providerInativo() {
  throw new Error('API Baileys chamada enquanto WHATSAPP_PROVIDER=wwebjs.');
}

module.exports = {
  default: providerInativo,
  useMultiFileAuthState: providerInativo,
  DisconnectReason: { loggedOut: 401 },
  fetchLatestBaileysVersion: providerInativo,
  getContentType,
  downloadContentFromMessage: providerInativo
};
