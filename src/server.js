import { createApp } from './app.js';
import env from './config/env.js';
import { connect, disconnect, sequelize } from './database/models/index.js';
import { closeRedis } from './config/redis.js';
import { closeBrowser } from './core/certificates/browser.js';
import { syncPermissions } from './core/rbac/rbac.service.js';
import { loadCurrencyExponents } from './lib/money.js';
import { logger } from './lib/logger.js';

async function start() {
  await connect();

  
  await syncPermissions();

  
  await loadCurrencyExponents(sequelize);

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'carisca-api listening');
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await disconnect().catch(() => {});
      await closeRedis().catch(() => {});
      await closeBrowser().catch(() => {});
      process.exit(0);
    });
    
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception — exiting');
    process.exit(1);
  });
}

start().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
