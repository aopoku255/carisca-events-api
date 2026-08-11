import { newUlid } from '../lib/ids.js';
import { logger } from '../lib/logger.js';
import env from '../config/env.js';

/**
 * Stamps every request with an id, echoes it in the response header, and puts
 * it on the request logger. The same id appears in error responses and audit
 * rows, so a user quoting it leads straight to the relevant log lines.
 */
export function requestContext(req, res, next) {
  req.id = req.get('x-request-id') || newUlid();
  res.set('x-request-id', req.id);
  req.log = logger.child({ requestId: req.id });
  req.startedAt = process.hrtime.bigint();
  next();
}

export function requestLogging(req, res, next) {
  if (env.isTest) return next();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - req.startedAt) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    req.log[level]({
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      userId: req.user?.id,
      ip: req.ip,
    }, 'request');
  });

  return next();
}

export default { requestContext, requestLogging };
