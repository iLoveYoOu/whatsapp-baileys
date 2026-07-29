const fs = require('fs');
const path = require('path');

const dataPath = path.resolve(
  process.env.WWEBJS_AUTH_PATH ||
  (fs.existsSync('/var/data') ? '/var/data/.wwebjs_auth' : path.join(process.cwd(), '.wwebjs_auth'))
);
const lockObsoleto = path.join(dataPath, '.bot-local.lock');

/*
 * Versões anteriores criavam um lock persistente baseado em PID. Em reinícios
 * do mesmo container, o PID pode continuar existindo ou ser reutilizado, o que
 * produz falso positivo e mantém o serviço em crash loop.
 *
 * O LocalAuth já inicia o Chrome com um userDataDir exclusivo. O próprio Chrome
 * controla a concorrência do perfil; este arquivo adicional não é necessário.
 */
if (fs.existsSync(lockObsoleto)) {
  fs.rmSync(lockObsoleto, { force: true });
  console.log('[LOCK-WWEBJS] Lock obsoleto removido; a sessão LocalAuth foi preservada.');
} else {
  console.log('[LOCK-WWEBJS] Nenhum lock obsoleto encontrado.');
}
