import env from './src/config/env.js';
import { connect, disconnect, sequelize } from './src/database/models/index.js';
import { closeRedis } from './src/config/redis.js';
import { loadCurrencyExponents } from './src/lib/money.js';
import { dispatchOnce } from './src/jobs/workers/notification-dispatcher.js';
import { verifyMailer, closeMailer } from './src/core/notifications/channels/mail.js';
import { sweepExpiredHolds } from './src/core/registrations/registration.service.js';
import { logger } from './src/lib/logger.js';

/**
 * Background worker. A separate process from the API so a slow email provider
 * or a large sweep can never make an HTTP request wait.
 *
 * Deliberately a polling loop rather than BullMQ for now: the two jobs that
 * exist are both "scan a table for due rows", which a queue would not make
 * faster or more reliable. BullMQ arrives in Week 2 with certificate
 * generation and payment reconciliation, which genuinely need retries,
 * concurrency limits and scheduling.
 */

const JOBS = [
  { name: 'notifications', everyMs: 10_000, run: () => dispatchOnce() },
  { name: 'hold-sweeper', everyMs: 60_000, run: () => sweepExpiredHolds() },
];

let running = true;

async function loop(job) {
  while (running) {
    const startedAt = Date.now();
    try {
      const result = await job.run();
      // Only log when something happened; an idle worker should be quiet.
      if (result && Object.values(result).some((v) => typeof v === 'number' && v > 0)) {
        logger.info({ job: job.name, ...result }, 'job completed');
      }
    } catch (err) {
      logger.error({ job: job.name, err: err.message }, 'job failed');
    }

    const elapsed = Date.now() - startedAt;
    const wait = Math.max(1000, job.everyMs - elapsed);
    await new Promise((resolve) => { setTimeout(resolve, wait).unref(); });
  }
}

async function start() {
  await connect();
  await loadCurrencyExponents(sequelize);

  // Not fatal: the outbox holds mail safely while a relay is down, and a worker
  // that refuses to start would also stop the hold sweeper from running.
  await verifyMailer();

  logger.info({
    jobs: JOBS.map((j) => j.name), env: env.NODE_ENV, mailDriver: env.MAIL_DRIVER,
  }, 'carisca worker started');

  const shutdown = async (signal) => {
    logger.info({ signal }, 'worker shutting down');
    running = false;
    // Let the current iteration finish rather than killing it mid-transaction.
    setTimeout(async () => {
      await closeMailer().catch(() => {});
      await disconnect().catch(() => {});
      await closeRedis().catch(() => {});
      process.exit(0);
    }, 2000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await Promise.all(JOBS.map(loop));
}

start().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
