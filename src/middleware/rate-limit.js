import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { getRedis } from '../config/redis.js';
import env from '../config/env.js';
import { fail } from '../lib/response.js';
import { logger } from '../lib/logger.js';

/**
 * Redis-backed so limits hold across processes. Tiered rather than uniform:
 * credential endpoints are the ones worth defending hard, and a generous
 * global limit should never be the thing that blocks a legitimate admin
 * working through a participant list.
 */
function store(prefix) {
  try {
    return new RedisStore({
      prefix: `rl:${prefix}:`,
      sendCommand: (...args) => getRedis().call(...args),
    });
  } catch (err) {
    // In-memory fallback keeps the API up if Redis is unreachable at boot.
    logger.warn({ err: err.message }, 'rate limiter falling back to memory store');
    return undefined;
  }
}

function handler(req, res) {
  return fail(res, {
    status: 429,
    code: 'RATE_LIMITED',
    message: 'Too many requests. Please wait a moment and try again.',
    requestId: req.id,
  });
}

const base = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler,
  // Tests exercise the limiter explicitly rather than tripping over it.
  skip: () => env.isTest,
};

export const globalLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 300,
  store: store('global'),
});

/** Sign-in, refresh: attacker-facing, keyed by IP. */
export const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60_000,
  limit: 10,
  skipSuccessfulRequests: true,
  store: store('auth'),
});

/** Registration and anything that sends an email on demand. */
export const registrationLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60_000,
  limit: 5,
  store: store('register'),
});

/** Password reset and verification resends. */
export const emailLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60_000,
  limit: 5,
  store: store('email'),
});

/** Public certificate verification — stops the code space being walked. */
export const verificationLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 20,
  store: store('verify'),
});

export default {
  globalLimiter,
  authLimiter,
  registrationLimiter,
  emailLimiter,
  verificationLimiter,
};
