import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';

import env from './config/env.js';
import routes from './routes.js';
import { requestContext, requestLogging } from './middleware/request-context.js';
import { globalLimiter } from './middleware/rate-limit.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { sequelize } from './database/models/index.js';
import { logger } from './lib/logger.js';

export function createApp() {
  const app = express();

  // Behind a load balancer or reverse proxy, req.ip must reflect the client
  // rather than the proxy — rate limiting and audit logs both depend on it.
  app.set('trust proxy', env.isProduction ? 1 : false);
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: env.isProduction ? undefined : false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  }));

  app.use(cors({
    origin(origin, callback) {
      // Server-to-server callers and same-origin requests send no Origin.
      if (!origin || env.corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} is not allowed by CORS.`));
    },
    credentials: true,
    exposedHeaders: ['x-request-id'],
  }));

  app.use(compression());
  app.use(requestContext);

  /**
   * Webhooks are mounted BEFORE the JSON parser and keep their raw body.
   * Signature verification hashes the exact bytes the provider sent, and a
   * parsed-then-restringified payload will not match. This ordering is not
   * cosmetic — moving it below express.json() silently breaks every webhook.
   *
   * The payments module registers its handlers here in Week 2.
   */
  app.use('/api/v1/webhooks', express.raw({ type: 'application/json', limit: '1mb' }));

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.use(requestLogging);
  app.use(globalLimiter);

  app.get('/health', async (req, res) => {
    const checks = { api: 'ok', database: 'unknown' };
    let status = 200;

    try {
      await sequelize.authenticate();
      checks.database = 'ok';
    } catch (err) {
      checks.database = 'unreachable';
      status = 503;
      logger.error({ err: err.message }, 'health check: database unreachable');
    }

    return res.status(status).json({
      success: status === 200,
      message: status === 200 ? 'Healthy' : 'Degraded',
      data: { ...checks, environment: env.NODE_ENV, uptimeSeconds: Math.round(process.uptime()) },
    });
  });

  app.use('/api/v1', routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
