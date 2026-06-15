require('dotenv').config();

const fs = require('fs');
const https = require('https');
const axios = require('axios');
const crypto = require('crypto');

const CORA_CLIENT_ID = String(process.env.CORA_CLIENT_ID || '').trim();

const cert = fs.readFileSync('./certs/certificate.pem');
const key = fs.readFileSync('./certs/private-key.key');

const agent = new https.Agent({
    cert,
    key,
    rejectUnauthorized: true
});

async function obterToken() {
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
            }
        }
    );

    return resp.data.access_token;
}

async function gerarPix() {
    try {
        const token = await obterToken();

        console.log('Token obtido com sucesso.');

        const hoje = new Date();
        hoje.setDate(hoje.getDate() + 1);

        const dueDate = hoje.toISOString().split('T')[0];

        const payload = {
            code: `teste-${Date.now()}`,
            customer: {
                name: 'Teste Cora',
                email: 'teste@teste.com',
                document: {
                    identity: '12345678909',
                    type: 'CPF'
                },
                address: {
                    street: 'Rua Teste',
                    number: '123',
                    district: 'Centro',
                    city: 'Praia Grande',
                    state: 'SP',
                    complement: '',
                    zip_code: '11700000'
                }
            },
            services: [
                {
                    name: 'Teste Pix',
                    amount: 500
                }
            ],
            payment_terms: {
                due_date: dueDate
            },
            payment_forms: ['PIX']
        };

        const resp = await axios.post(
            'https://matls-clients.api.cora.com.br/v2/invoices',
            payload,
            {
                httpsAgent: agent,
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'Idempotency-Key': crypto.randomUUID()
                }
            }
        );

        console.log('PIX GERADO!');
        console.log(JSON.stringify(resp.data, null, 2));

    } catch (err) {
        console.error('ERRO:');
        console.error(err.response?.status);
        console.error(JSON.stringify(err.response?.data, null, 2));
    }
}

gerarPix();