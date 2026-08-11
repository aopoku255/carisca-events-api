import env from '../../../config/env.js';
import { logger } from '../../../lib/logger.js';
import { ServiceUnavailableError } from '../../../lib/errors.js';

/**
 * Email provider abstraction.
 *
 * Callers only ever see `send({ to, subject, html, text })`. Swapping the
 * provider is adding a driver here — nothing in the application knows or cares
 * which one is configured.
 */

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

  /**
   * SMTP. Deliberately left unimplemented rather than half-built: wiring it up
   * is one nodemailer call, and doing it before CARISCA's mail credentials
   * exist would only produce untested code.
   */
  smtp: {
    async send() {
      throw new ServiceUnavailableError(
        'Email',
        'The SMTP driver is not configured. Set MAIL_DRIVER=log for development.',
      );
    },
    async verify() { return false; },
  },
};

export function mailer() {
  const driver = drivers[env.MAIL_DRIVER];
  if (!driver) throw new Error(`Unknown MAIL_DRIVER "${env.MAIL_DRIVER}"`);
  return driver;
}

export async function sendMail({ to, subject, html, text }) {
  if (!to) throw new Error('sendMail requires a recipient');
  return mailer().send({ from: env.MAIL_FROM, to, subject, html, text });
}

export default { sendMail, mailer };
