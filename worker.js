import env from './src/config/env.js';
import { connect, disconnect, sequelize } from './src/database/models/index.js';
import { closeRedis } from './src/config/redis.js';
import { loadCurrencyExponents } from './src/lib/money.js';
import { startBackgroundJobs, JOBS } from './src/jobs/background-jobs.js';
import { verifyMailer, closeMailer } from './src/core/notifications/channels/mail.js';
import { logger } from './src/lib/logger.js';

/**
 * Background worker. A separate process from the API so a slow email provider
 * or a large sweep can never make an HTTP request wait.
 *
 * The jobs themselves live in src/jobs/background-jobs.js, which the API can
 * also run in-process (RUN_JOBS_IN_API) where a second process isn't possible.
 */

async function start() {
  await connect();
  await loadCurrencyExponents(sequelize);

  // Not fatal: the outbox holds mail safely while a relay is down, and a worker
  // that refuses to start would also stop the hold sweeper from running.
  await verifyMailer();

  logger.info({
    jobs: JOBS.map((j) => j.name), env: env.NODE_ENV, mailDriver: env.MAIL_DRIVER,
  }, 'carisca worker started');

  const stopJobs = startBackgroundJobs();

  const shutdown = async (signal) => {
    logger.info({ signal }, 'worker shutting down');
    // Let the current iteration finish rather than killing it mid-transaction.
    stopJobs().finally(async () => {
      await closeMailer().catch(() => {});
      await disconnect().catch(() => {});
      await closeRedis().catch(() => {});
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
