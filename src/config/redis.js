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
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    retryStrategy: (times) => Math.min(times * 200, 5000),
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
