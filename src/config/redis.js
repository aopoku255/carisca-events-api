import Redis from 'ioredis';
import env from './env.js';
import { logger } from '../lib/logger.js';

/**
 * One shared connection for caching and rate limiting. BullMQ creates its own
 * connections because it requires `maxRetriesPerRequest: null`.
 */
let client = null;

export function getRedis() {
  if (client) return client;

  client = new Redis(env.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    /**
     * Fail commands immediately while disconnected rather than queueing them.
     *
     * With the queue on, a command issued during an outage waits for the
     * reconnect cycle to give up before it rejects — and because the backoff
     * grows, that wait reached 28 seconds per request in testing. Every caller
     * here (the rate limiter, the permission cache) has a fallback that is
     * better than waiting, so the useful answer is "no" now, not "no" later.
     */
    enableOfflineQueue: false,
    // Capped lower than the old 5s for the same reason: the gap between
    // attempts is also the window in which a recovered Redis goes unnoticed.
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });

  client.on('error', (err) => {
    // Logged, not thrown. Redis being down degrades caching and rate limiting;
    // it must not take the API offline. Callers fall back to the database.
    logger.warn({ err: err.message }, 'redis error');
  });

  client.on('connect', () => logger.info('redis connected'));

  return client;
}

export async function closeRedis() {
  if (client) {
    await client.quit().catch(() => client.disconnect());
    client = null;
  }
}

export default { getRedis, closeRedis };
