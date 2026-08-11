import pino from 'pino';
import env from '../config/env.js';

/**
 * Structured logging. The redaction list is not optional: passwords, tokens,
 * provider keys and webhook signatures must never reach a log sink, and the
 * cheapest way to guarantee that is to strip them centrally.
 */
export const logger = pino({
  level: env.isTest ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-paystack-signature"]',
      'req.headers["stripe-signature"]',
      'password',
      'passwordConfirmation',
      'currentPassword',
      'newPassword',
      'password_hash',
      'token',
      'accessToken',
      'refreshToken',
      'token_hash',
      '*.password',
      '*.password_hash',
      '*.token',
      '*.secret',
      'body.password',
      'body.token',
    ],
    censor: '[redacted]',
  },
  base: { service: 'carisca-api', env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: env.isProduction || env.isTest ? undefined : {
    target: 'pino/file',
    options: { destination: 1 },
  },
});

export function childLogger(bindings) {
  return logger.child(bindings);
}

export default logger;
