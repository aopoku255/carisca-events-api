import { ValidationError as SequelizeValidationError, UniqueConstraintError, ForeignKeyConstraintError, DatabaseError } from 'sequelize';
import { AppError } from '../lib/errors.js';
import { fail } from '../lib/response.js';
import { logger } from '../lib/logger.js';
import env from '../config/env.js';

/**
 * The single place an error becomes a response. Two rules:
 *   - Anything not deliberately thrown as an AppError is a 500 with a generic
 *     message; internal detail goes to the log, never to the caller.
 *   - Every error response carries the request id so a user can quote it and
 *     support can find the exact log line.
 */
export function errorHandler(err, req, res, _next) {
  const requestId = req.id;

  if (err instanceof AppError) {
    if (err.status >= 500) {
      logger.error({ err, requestId, path: req.path }, err.message);
    } else {
      logger.debug({ code: err.code, requestId, path: req.path }, err.message);
    }
    return fail(res, {
      status: err.status,
      code: err.code,
      message: err.message,
      details: err.details,
      requestId,
    });
  }

  if (err instanceof UniqueConstraintError) {
    const fields = Object.keys(err.fields || {});
    logger.debug({ fields, requestId }, 'unique constraint violation');
    return fail(res, {
      status: 409,
      code: 'DUPLICATE',
      message: 'That record already exists.',
      details: fields.length ? { fields } : null,
      requestId,
    });
  }

  if (err instanceof ForeignKeyConstraintError) {
    logger.debug({ requestId, table: err.table }, 'foreign key violation');
    return fail(res, {
      status: 409,
      code: 'REFERENCE_ERROR',
      message: 'This record is referenced by other data and cannot be changed.',
      requestId,
    });
  }

  if (err instanceof SequelizeValidationError) {
    return fail(res, {
      status: 422,
      code: 'VALIDATION_ERROR',
      message: 'The submitted data is invalid.',
      details: err.errors.map((e) => ({ field: e.path, message: e.message })),
      requestId,
    });
  }

  // Express's own body-parser errors.
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError && 'body' in err) {
    return fail(res, {
      status: 400,
      code: 'MALFORMED_JSON',
      message: 'The request body is not valid JSON.',
      requestId,
    });
  }
  if (err.type === 'entity.too.large') {
    return fail(res, {
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'The request body is too large.',
      requestId,
    });
  }

  if (err instanceof DatabaseError) {
    logger.error({ err, requestId, sql: err.sql }, 'database error');
    return fail(res, {
      status: 500,
      code: 'DATABASE_ERROR',
      message: 'Something went wrong. Please try again.',
      requestId,
    });
  }

  logger.error({ err, requestId, path: req.path, method: req.method }, 'unhandled error');

  return fail(res, {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'Something went wrong. Please try again.',
    details: env.isProduction ? null : { message: err.message, stack: err.stack?.split('\n').slice(0, 5) },
    requestId,
  });
}

export function notFoundHandler(req, res) {
  return fail(res, {
    status: 404,
    code: 'ROUTE_NOT_FOUND',
    message: `No route matches ${req.method} ${req.path}.`,
    requestId: req.id,
  });
}

export default { errorHandler, notFoundHandler };
