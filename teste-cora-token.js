require('dotenv').config();

const fs = require('fs');
const https = require('https');
const axios = require('axios');

const CORA_CLIENT_ID = process.env.CORA_CLIENT_ID;

const cert = fs.readFileSync('./certs/certificate.pem');
const key = fs.readFileSync('./certs/private-key.key');

async function main() {
  if (!CORA_CLIENT_ID) {
    throw new Error('Configure CORA_CLIENT_ID no .env');
  }

  const agent = new https.Agent({
    cert,
    key,
    rejectUnauthorized: true
  });

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CORA_CLIENT_ID
  });

  const resp = await axios.post(
    'https://matls-clients.api.cora.com.br/token',
    body.toString(),
    {
      httpsAgent: agent,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      timeout: 30000
    }
  );

  console.log('STATUS:', resp.status);
  console.log('TOKEN OK:', Boolean(resp.data.access_token));
  console.log('EXPIRES:', resp.data.expires_in);
}

main().catch(err => {
  console.error('ERRO:', err.response?.status || err.message);
  console.error(err.response?.data || '');
});