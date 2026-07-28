# Tarefa: migrar o bot principal para whatsapp-web.js

## Contexto

O Baileys falha com `405 Connection Failure` antes do QR. O teste em `scripts/testar-whatsapp-web.js` autenticou corretamente e criou uma sessão local persistente em `.wwebjs_auth`.

## Regras de segurança

- Trabalhar somente na branch `codex/paliativo-whatsapp-webjs`.
- Executar `PREPARAR-MIGRACAO-WWEBJS.ps1` antes de alterar o código.
- Nunca apagar, mover, versionar ou enviar `.wwebjs_auth`.
- Não executar `npm audit fix`.
- Não alterar Render nesta fase.
- Não remover o Baileys até a validação completa.

## Objetivo da fase 2

Criar uma camada adaptadora de transporte para que a lógica atual do `server.js` continue usando uma interface semelhante a `sock.sendMessage`, mas por baixo use `whatsapp-web.js`.

## Implementação obrigatória

1. Criar `src/whatsapp/wwebjs-provider.js`.
2. Usar `Client`, `LocalAuth` e `MessageMedia` do `whatsapp-web.js`.
3. Reutilizar `clientId: bot-paliativo` e `dataPath: .wwebjs_auth`.
4. Detectar Chrome ou Edge nos caminhos padrão do Windows.
5. Expor uma função `sendMessage(jid, payload, options)` compatível com os usos atuais mais comuns:
   - `{ text }`;
   - `{ image: Buffer, caption }`;
   - `{ document: Buffer, fileName, mimetype, caption }`;
   - `{ video: Buffer, caption }` quando suportado;
   - texto citado/resposta quando houver contexto disponível.
6. Converter JIDs:
   - `@s.whatsapp.net` para `@c.us`;
   - manter `@g.us`;
   - tratar `@lid` com log explícito quando não for possível mapear.
7. Criar um normalizador de mensagem que produza o formato mínimo esperado pela lógica atual:
   - `key.remoteJid`;
   - `key.participant`;
   - `key.id`;
   - `key.fromMe`;
   - `pushName`;
   - `message.conversation` ou `extendedTextMessage.text`;
   - dados de mensagem citada (`stanzaId`, participante e texto citado).
8. Substituir somente a inicialização/conexão/evento de entrada do WhatsApp no `server.js`; preservar PIX, Google Sheets, fila, operadores, relatórios e rotas HTTP.
9. Manter uma variável de ambiente `WHATSAPP_PROVIDER`, com padrão `baileys`. Quando `WHATSAPP_PROVIDER=wwebjs`, usar o novo provider.
10. Criar `INICIAR-BOT-LOCAL.ps1` definindo `WHATSAPP_PROVIDER=wwebjs` e iniciando o bot.
11. Evitar duas instâncias usando a mesma `.wwebjs_auth`.
12. Registrar claramente: inicializando, QR, autenticado, pronto, desconectado e erro.

## Validação

- Rodar `node --check server.js`.
- Rodar `node --check src/whatsapp/wwebjs-provider.js`.
- Iniciar com `INICIAR-BOT-LOCAL.ps1` usando a sessão existente.
- Confirmar que não pede novo QR.
- Testar primeiro `/stats` ou `/fila`.
- Testar envio de uma mensagem de texto simples.
- Não testar pagamento real até os comandos básicos funcionarem.

## Relatório final

Informar arquivos alterados, incompatibilidades encontradas, comandos executados e testes concluídos.
