const test = require('node:test');
const assert = require('node:assert/strict');

const {
  jidParaWpp,
  jidParaBaileys,
  normalizarMensagem
} = require('../src/whatsapp/wppconnect-provider');

test('converte JIDs sem alterar grupos', () => {
  assert.equal(jidParaWpp('5511999999999@s.whatsapp.net'), '5511999999999@c.us');
  assert.equal(jidParaBaileys('5511999999999@c.us'), '5511999999999@s.whatsapp.net');
  assert.equal(jidParaWpp('123@g.us'), '123@g.us');
});

test('normaliza texto recebido para o contrato usado pelo bot', () => {
  const msg = normalizarMensagem({
    id: 'false_5511999999999@c.us_ABC',
    from: '5511999999999@c.us',
    fromMe: false,
    notifyName: 'Cliente',
    type: 'chat',
    body: 'test'
  });

  assert.deepEqual(msg.key, {
    remoteJid: '5511999999999@s.whatsapp.net',
    participant: undefined,
    id: 'false_5511999999999@c.us_ABC',
    fromMe: false
  });
  assert.equal(msg.pushName, 'Cliente');
  assert.equal(msg.message.conversation, 'test');
});

test('normaliza mídia e mensagem citada', () => {
  const imagem = normalizarMensagem({
    id: 'IMG',
    from: '123@g.us',
    author: '5511888888888@c.us',
    type: 'image',
    caption: 'comprovante'
  });
  assert.equal(imagem.message.imageMessage.caption, 'comprovante');
  assert.equal(imagem.key.participant, '5511888888888@s.whatsapp.net');

  const citada = normalizarMensagem({
    id: 'TXT',
    from: '5511999999999@c.us',
    type: 'chat',
    body: 'resposta',
    quotedMsgId: 'ORIGINAL',
    quotedMsgObj: {
      body: '👤 CLIENTE TESTE'
    }
  });
  assert.equal(citada.message.extendedTextMessage.text, 'resposta');
  assert.equal(citada.message.extendedTextMessage.contextInfo.stanzaId, 'ORIGINAL');
  assert.equal(
    citada.message.extendedTextMessage.contextInfo.quotedMessage.conversation,
    '👤 CLIENTE TESTE'
  );
});

test('mantém comandos enviados pelo número conectado e responde ao destinatário correto', () => {
  const msg = normalizarMensagem({
    id: 'OUT',
    from: '5511000000000@c.us',
    to: '5511999999999@c.us',
    fromMe: true,
    type: 'chat',
    body: '/addblacklist'
  });

  assert.equal(msg.key.fromMe, true);
  assert.equal(msg.key.remoteJid, '5511999999999@s.whatsapp.net');
  assert.equal(msg.message.conversation, '/addblacklist');
});
