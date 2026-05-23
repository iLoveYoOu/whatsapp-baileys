# WhatsApp grátis para Google Sheets

Integração gratuita usando Baileys + Google Sheets. Não usa Z-API.

## O que faz

- Lê mensagens novas do WhatsApp.
- Extrai `ret`, `dep`, `plat`.
- Preenche a aba do dia, exemplo `22/05`.
- Começa na coluna B, linha 2.
- Preenche B até G.
- Usa a coluna H escondida para ID da mensagem.
- Atualiza linha se o mesmo ID chegar de novo.
- Tenta apagar linha quando a mensagem for apagada.
- Aceita várias entradas na mesma mensagem.

## Colunas usadas

- B: DEPOSITO
- C: SACADO
- D: CASA
- E: BANCA
- F: LUCRO
- G: DIA
- H: ID oculto

## Configuração Google Sheets

1. Abra sua planilha.
2. Compartilhe a planilha com o e-mail da Service Account do Google Cloud.
3. Permissão: Editor.
4. Use o ID da planilha no Render:

```txt
SPREADSHEET_ID=1UpjDdiu43qrkVEqnvtXvCg7_u0P13Dhwua1aqWzeMog
```

## Criar Service Account Google

1. Acesse Google Cloud Console.
2. Crie um projeto.
3. Ative Google Sheets API.
4. Crie uma Service Account.
5. Crie uma chave JSON.
6. No Render, configure:

```txt
GOOGLE_SERVICE_ACCOUNT_EMAIL=email-da-service-account
GOOGLE_PRIVATE_KEY=chave-private-key-do-json
```

A private key precisa ficar com `\n`, exemplo:

```txt
-----BEGIN PRIVATE KEY-----\nABC...\n-----END PRIVATE KEY-----\n
```

## Deploy no Render

1. Crie conta no Render.
2. New → Web Service.
3. Envie este projeto para GitHub ou use upload via repositório.
4. Build command:

```bash
npm install
```

5. Start command:

```bash
npm start
```

6. Environment Variables:

```txt
SPREADSHEET_ID=1UpjDdiu43qrkVEqnvtXvCg7_u0P13Dhwua1aqWzeMog
GOOGLE_SERVICE_ACCOUNT_EMAIL=...
GOOGLE_PRIVATE_KEY=...
```

7. Abra a URL do Render.
8. Vá em `/qr`.
9. Escaneie o QR no WhatsApp.

## Mensagem de teste

```txt
ret: 561
dep: 500
plat: teclado777
```

Resultado esperado:

```txt
500 | 561 | teclado777 | 440 | 60 | 22/05
```

## Observação importante

Render grátis pode dormir após inatividade. Se dormir, abra a URL do projeto para acordar.

