import nodemailer from 'nodemailer';
import env from '../../../config/env.js';
import { logger } from '../../../lib/logger.js';

/**
 * Email provider abstraction.
 *
 * Callers only ever see `send({ to, subject, html, text })`. Swapping the
 * provider is adding a driver here — nothing in the application knows or cares
 * which one is configured.
 */

/**
 * SMTP rejections split into two kinds and the difference matters to the
 * dispatcher: a refused mailbox will be refused identically on all five
 * retries, while a dropped connection usually will not. Errors carry
 * `permanent` so the outbox can fail the first kind immediately instead of
 * spending four hours of backoff on a typo in an address.
 */
export class MailDeliveryError extends Error {
  constructor(message, { permanent = false, cause = null } = {}) {
    super(message);
    this.name = 'MailDeliveryError';
    this.permanent = permanent;
    if (cause) this.cause = cause;
  }
}

/**
 * 5xx is a permanent refusal in SMTP; 4xx is "try later". Nodemailer surfaces
 * the code on `responseCode` for server replies, and a bare `code` (ECONNRESET,
 * ETIMEDOUT, EDNS…) for anything that failed below the protocol — all of which
 * are transient by nature.
 */
function isPermanent(err) {
  const code = err?.responseCode;
  if (typeof code === 'number') return code >= 500 && code < 600;
  // A rejected envelope recipient with no 4xx reply is a bad address.
  if (err?.code === 'EENVELOPE' && !err?.response?.startsWith?.('4')) return true;
  return false;
}

const drivers = {
  /**
   * Development and test. Writes the message to the log instead of sending,
   * so the whole registration flow can be exercised with no mail account.
   */
  log: {
    async send({ to, subject, text }) {
      logger.info({ to, subject, preview: text?.slice(0, 400) }, 'email (log driver — not sent)');
      return { id: `log-${Date.now()}`, provider: 'log' };
    },
    async verify() { return true; },
  },

  smtp: createSmtpDriver(),
};

/**
 * The transport is built on first use rather than at import time: the API
 * process imports this module through the notification service but never
 * sends anything itself, and it should not hold a pool of SMTP sockets open
 * for mail only the worker delivers.
 */
export function createSmtpDriver() {
  let transport = null;

  function getTransport() {
    if (transport) return transport;

    transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER
        ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }
        : undefined,
      /**
       * Pooled because the dispatcher sends in batches of 25 — a fresh TCP
       * handshake and TLS negotiation per message would dominate the run.
       * The rate limit keeps a large batch (an event-wide cancellation, say)
       * from tripping the relay's flood protection.
       */
      pool: true,
      maxConnections: env.SMTP_POOL_MAX_CONNECTIONS,
      maxMessages: 100,
      rateDelta: 1000,
      rateLimit: 10,
      // Bounded so a hung relay cannot stall the worker loop indefinitely;
      // the outbox will retry on the next pass.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      tls: env.SMTP_ALLOW_SELF_SIGNED ? { rejectUnauthorized: false } : undefined,
      logger: false,
    });

    return transport;
  }

  return {
    async send({ from, to, subject, html, text }) {
      try {
        const info = await getTransport().sendMail({
          from,
          to,
          subject,
          html,
          text,
          replyTo: env.MAIL_REPLY_TO || undefined,
        });

        /**
         * A 250 for the envelope does not mean every recipient was accepted;
         * a relay can accept the message and reject one address. Surfacing it
         * as a failure keeps the outbox row honest about what happened.
         */
        if (info.rejected?.length) {
          throw new MailDeliveryError(
            `Recipient rejected by SMTP server: ${info.rejected.join(', ')}`,
            { permanent: true },
          );
        }

        return { id: info.messageId, provider: 'smtp', accepted: info.accepted };
      } catch (err) {
        if (err instanceof MailDeliveryError) throw err;
        throw new MailDeliveryError(
          `SMTP delivery failed: ${err.message}`,
          { permanent: isPermanent(err), cause: err },
        );
      }
    },

    /** Proves the credentials and the route before anything is queued. */
    async verify() {
      await getTransport().verify();
      return true;
    },

    async close() {
      if (transport) {
        transport.close();
        transport = null;
      }
    },
  };
}

export function mailer() {
  const driver = drivers[env.MAIL_DRIVER];
  if (!driver) throw new Error(`Unknown MAIL_DRIVER "${env.MAIL_DRIVER}"`);
  return driver;
}

export async function sendMail({ to, subject, html, text }) {
  if (!to) throw new Error('sendMail requires a recipient');
  return mailer().send({ from: env.MAIL_FROM, to, subject, html, text });
}

/**
 * Called once at worker boot. A bad password is reported at start-up, where
 * someone is watching, instead of as five silent retries per notification.
 */
export async function verifyMailer() {
  try {
    await mailer().verify();
    logger.info({ driver: env.MAIL_DRIVER }, 'mail transport ready');
    return true;
  } catch (err) {
    logger.error(
      { driver: env.MAIL_DRIVER, host: env.SMTP_HOST, err: err.message },
      'mail transport unavailable — queued email will not be delivered until this is fixed',
    );
    return false;
  }
}

export async function closeMailer() {
  await mailer().close?.();
}

export default { sendMail, mailer, verifyMailer, closeMailer };
