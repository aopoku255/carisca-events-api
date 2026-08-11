import { ZodError } from 'zod';
import { ValidationError } from '../lib/errors.js';

/**
 * Schema validation at the edge. The parsed result replaces the raw input, so
 * handlers receive coerced, stripped data and never see an unexpected field.
 */
export function validate({ body, query, params }) {
  return (req, res, next) => {
    try {
      if (body) req.body = body.parse(req.body ?? {});
      if (params) req.params = params.parse(req.params ?? {});
      if (query) {
        // req.query is a getter in Express 5; assign to a parallel property
        // rather than fighting it.
        req.validatedQuery = query.parse(req.query ?? {});
      }
      return next();
    } catch (err) {
      if (err instanceof ZodError) {
        return next(new ValidationError(
          err.issues.map((i) => ({
            field: i.path.join('.') || '(root)',
            message: i.message,
            code: i.code,
          })),
        ));
      }
      return next(err);
    }
  };
}

export default validate;
