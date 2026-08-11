/**
 * Typed application errors. Anything thrown that is not an AppError is treated
 * as an unexpected fault: logged with a stack and reported to the caller as a
 * generic 500, so internal details never leak through the API.
 */
export class AppError extends Error {
  constructor(message, { status = 500, code = 'INTERNAL_ERROR', details = null, expose = true } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = expose;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(details, message = 'The submitted data is invalid.') {
    super(message, { status: 422, code: 'VALIDATION_ERROR', details });
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication is required.', code = 'UNAUTHENTICATED') {
    super(message, { status: 401, code });
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'You do not have permission to perform this action.', details = null) {
    super(message, { status: 403, code: 'FORBIDDEN', details });
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} was not found.`, { status: 404, code: 'NOT_FOUND' });
  }
}

export class ConflictError extends AppError {
  constructor(message, code = 'CONFLICT', details = null) {
    super(message, { status: 409, code, details });
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests. Please try again shortly.') {
    super(message, { status: 429, code: 'RATE_LIMITED' });
  }
}

/** A dependency we do not control is unavailable — provider, mail, storage. */
export class ServiceUnavailableError extends AppError {
  constructor(service, message = null) {
    super(message || `${service} is temporarily unavailable. Please try again shortly.`, {
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { service },
    });
  }
}
