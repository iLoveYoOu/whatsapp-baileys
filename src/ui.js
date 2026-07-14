'use strict';

const E = Object.freeze({
  OK: '\u2705',
  ERRO: '\u26D4',
  ALERTA: '\u26A0\uFE0F',
  PIX: '\uD83D\uDCB0',
  PESSOA: '\uD83D\uDC64',
  DINHEIRO: '\uD83D\uDCB5',
  FOTO: '\uD83D\uDCF8',
  OPERADOR: '\uD83D\uDC68\u200D\uD83D\uDCBB',
  ESTATISTICAS: '\uD83D\uDCCA',
  FILA: '\uD83D\uDCCB',
  FERRAMENTA: '\uD83D\uDEE0\uFE0F',
  ESTRELA: '\u2B50',
  RECICLAR: '\u267B\uFE0F',
  LIMPAR: '\uD83E\uDDF9',
  GRUPO: '\uD83D\uDC65',
  CARTAO: '\uD83D\uDCB3',
  PACOTE: '\uD83D\uDCE6',
  CALENDARIO: '\uD83D\uDCC5',
  RELOGIO: '\uD83D\uDD50',
  CELULAR: '\uD83D\uDCF2',
  AGUARDANDO: '\u23F3',
  SETA: '\u27A1\uFE0F',
  INFO: '\u2139\uFE0F',
  BLOQUEADO: '\uD83D\uDEAB',
  VERMELHO: '\uD83D\uDD34'
});

function moeda(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function msgValorDefinido(valor) {
  return `${E.PIX} VALOR DEFINIDO

${E.DINHEIRO} Valor: R$ ${moeda(valor)}

${E.AGUARDANDO} Aguardando pagamento...

${E.FOTO} Após a confirmação, envie a FOTO 2/2.`;
}

function msgPixGerado(valor) {
  return `${E.PIX} PIX GERADO

${E.DINHEIRO} Valor: R$ ${moeda(valor)}

${E.AGUARDANDO} Aguardando pagamento...`;
}

function msgBancaLiberadaManual(valor) {
  return `${E.OK} BANCA LIBERADA MANUALMENTE

${E.PIX} Valor para depositar:
R$ ${moeda(valor)}

${E.FOTO} Você já pode enviar a FOTO 2/2.`;
}

function msgPixRecebido(nome, valor, suspeito = false) {
  if (suspeito) {
    return `━━━━━━━━━━━━━━━━━━━━━━

${E.PIX} PIX RECEBIDO

${E.PESSOA} ${nome}
${E.DINHEIRO} R$ ${valor}

${E.VERMELHO} STATUS: SUSPEITO

Motivo:
• Nome presente na lista de fraude.

Ação recomendada:
${E.ERRO} Não liberar saldo
${E.PESSOA} Encaminhar para análise

━━━━━━━━━━━━━━━━━━━━━━`;
  }

  return `${E.PIX} PIX RECEBIDO

${E.PESSOA} ${nome}
${E.DINHEIRO} R$ ${valor}`;
}

function msgStats(dados) {
  return `${E.ESTATISTICAS} ESTATÍSTICAS

${E.PIX} Pix gerados: ${dados.pixGerados}
${E.OK} Pix pagos: ${dados.pixPagos}
${E.PACOTE} Bancas liberadas: ${dados.bancasLiberadas}
${E.CARTAO} Pagamentos pendentes: ${dados.pagamentosPendentes}

${E.GRUPO} Operadores online: ${dados.operadoresOnline}
${E.ESTRELA} Próximo da fila: ${dados.proximo}
${E.BLOQUEADO} Blacklist: ${dados.blacklist}`;
}

module.exports = {
  E,
  moeda,
  msgValorDefinido,
  msgPixGerado,
  msgBancaLiberadaManual,
  msgPixRecebido,
  msgStats
};
