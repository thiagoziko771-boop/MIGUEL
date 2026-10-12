/**
 * Servidor de desenvolvimento/produção com processo próprio.
 * Na Vercel o ponto de entrada é api/index.ts, que reaproveita o mesmo app.
 */
import { createApp } from './app.js';
import { config, getConfigIssues } from './config.js';
import { logger } from './logger.js';
import { initStore, storeKind, warnIfNotProductionReady } from './store/index.js';

const { fatalErrors, warnings } = getConfigIssues();

if (fatalErrors.length > 0) {
  logger.error('Configuração inválida — o servidor não pode iniciar:');
  for (const message of fatalErrors) logger.error(`  • ${message}`);
  logger.error('Copie .env.example para .env.local e preencha as variáveis.');
  process.exit(1);
}
for (const message of warnings) logger.warn(message);

if (config.mode === 'mock') {
  logger.warn('='.repeat(78));
  logger.warn('PIX_MODE=mock — NENHUM PIX REAL SERÁ GERADO OU COBRADO.');
  logger.warn('As cobranças se confirmam sozinhas após alguns segundos, apenas para testes.');
  logger.warn('NUNCA use este modo em produção. Defina PIX_MODE=live antes de publicar.');
  logger.warn('='.repeat(78));
}

warnIfNotProductionReady();

const app = createApp();

async function main(): Promise<void> {
  await initStore();

  const server = app.listen(config.port, config.host, () => {
    logger.info(`Backend no ar em http://${config.host}:${config.port} (modo ${config.mode}, dados em ${storeKind()})`);
    if (config.publicBaseUrl) {
      logger.info(`Callback do gateway: ${config.publicBaseUrl}/api/webhooks/pix`);
    }
  });

  function shutdown(signal: string): void {
    logger.info(`${signal} recebido, encerrando o servidor...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  logger.error('Falha ao iniciar o servidor', { error: (error as Error).message });
  process.exit(1);
});
