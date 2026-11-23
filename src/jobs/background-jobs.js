import { dispatchOnce } from './workers/notification-dispatcher.js';
import { sweepExpiredHolds } from '../core/registrations/registration.service.js';
import { reconcilePendingPayments } from '../core/payments/payment.service.js';
import { logger } from '../lib/logger.js';

/**
 * The polling jobs: send queued emails, release expired payment holds, and
 * reconcile payments whose webhook never arrived. Shared by the standalone
 * worker (worker.js) and by the API process itself (RUN_JOBS_IN_API), for
 * hosting like cPanel where only one Node process can be run.
 *
 * Deliberately polling loops rather than BullMQ: each job is "scan a table for
 * due rows", which a queue would not make faster or more reliable. Every job is
 * safe to run in more than one process at once (the email outbox claims rows
 * with SKIP LOCKED), so running both the worker and the API loops is harmless.
 */
export const JOBS = [
  { name: 'notifications', everyMs: 10_000, run: () => dispatchOnce() },
  { name: 'hold-sweeper', everyMs: 60_000, run: () => sweepExpiredHolds() },
  { name: 'payment-reconciler', everyMs: 120_000, run: () => reconcilePendingPayments() },
];

/** Starts every job's loop. Returns a function that stops them after their current iteration. */
export function startBackgroundJobs() {
  let running = true;
  const timers = new Set();

  const sleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(() => { timers.delete(t); resolve(); }, ms);
    t.unref();
    timers.add(t);
  });

  async function loop(job) {
    while (running) {
      const startedAt = Date.now();
      try {
        const result = await job.run();
        // Only log when something happened; an idle loop should be quiet.
        if (result && Object.values(result).some((v) => typeof v === 'number' && v > 0)) {
          logger.info({ job: job.name, ...result }, 'job completed');
        }
      } catch (err) {
        logger.error({ job: job.name, err: err.message }, 'job failed');
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(Math.max(1000, job.everyMs - (Date.now() - startedAt)));
    }
  }

  const loops = Promise.all(JOBS.map(loop));

  return async function stop() {
    running = false;
    timers.forEach(clearTimeout);
    await loops;
  };
}
