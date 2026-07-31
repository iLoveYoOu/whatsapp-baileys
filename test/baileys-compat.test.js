const assert = require('node:assert/strict');
const test = require('node:test');
const compat = require('../src/whatsapp/baileys-compat');

test('identifica o tipo das mensagens normalizadas sem carregar Baileys', () => {
  assert.equal(compat.getContentType({ conversation: 'teste' }), 'conversation');
  assert.equal(
    compat.getContentType({ extendedTextMessage: { text: 'teste' } }),
    'extendedTextMessage'
  );
  assert.equal(compat.getContentType(null), undefined);
});

test('impede uso acidental das APIs pesadas com provider wwebjs', () => {
  assert.throws(
    () => compat.downloadContentFromMessage(),
    /API Baileys chamada enquanto WHATSAPP_PROVIDER=wwebjs/
  );
});
