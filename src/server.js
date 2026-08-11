import { createApp } from './app.js';
import env from './config/env.js';
import { connect, disconnect, sequelize } from './database/models/index.js';
import { closeRedis } from './config/redis.js';
import { syncPermissions } from './core/rbac/rbac.service.js';
import { loadCurrencyExponents } from './lib/money.js';
import { logger } from './lib/logger.js';

async function start() {
  await connect();

  // Reconcile permissions.json into the database, so a permission referenced
  // in code always exists as a row.
  await syncPermissions();

  // Currency exponents are read once and cached; nothing may assume 2 decimals.
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
      process.exit(0);
    });
    // Do not wait forever for in-flight requests to drain.
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
