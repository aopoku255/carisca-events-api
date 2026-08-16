/**
 * Proves the mail configuration end to end: connects, authenticates, renders a
 * real template and delivers it. Run this after setting SMTP credentials,
 * before finding out from a participant that nothing arrived.
 *
 *   node scripts/send-test-email.js you@example.com
 *   node scripts/send-test-email.js you@example.com registration_confirmed
 */
import env from '../src/config/env.js';
import { render, templates } from '../src/core/notifications/templates/index.js';
import { sendMail, mailer, closeMailer } from '../src/core/notifications/channels/mail.js';

const out = (s) => process.stdout.write(`${s}\n`);

/** Plausible values for whichever template is being previewed. */
const SAMPLE = {
  firstName: 'Ama',
  expiresInHours: env.EMAIL_VERIFICATION_TTL_HOURS,
  expiresInMinutes: env.PASSWORD_RESET_TTL_MINUTES,
  verifyUrl: `${env.WEB_URL}/verify-email?token=sample-token`,
  resetUrl: `${env.WEB_URL}/reset-password?token=sample-token`,
  paymentUrl: `${env.WEB_URL}/checkout/sample`,
  eventTitle: 'CARISCA Supply Chain Summit 2026',
  reference: 'CAR-2026-000123',
  attendanceMode: 'IN_PERSON',
  holdExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  amount: { currency: 'GHS', formatted: '1,200.00' },
  changed: ['venue', 'start time'],
  reason: 'Sample reason — this is a test message.',
};

async function main() {
  const [to, template = 'email_verification'] = process.argv.slice(2);

  if (!to) {
    out('Usage: node scripts/send-test-email.js <recipient> [template]');
    out(`Templates: ${Object.keys(templates).join(', ')}`);
    process.exit(1);
  }

  if (!templates[template]) {
    out(`No such template "${template}".`);
    out(`Templates: ${Object.keys(templates).join(', ')}`);
    process.exit(1);
  }

  out(`driver:    ${env.MAIL_DRIVER}`);
  if (env.MAIL_DRIVER === 'smtp') {
    out(`host:      ${env.SMTP_HOST}:${env.SMTP_PORT} (secure: ${env.SMTP_SECURE})`);
    out(`auth:      ${env.SMTP_USER || '(none — relaying by IP)'}`);
  }
  out(`from:      ${env.MAIL_FROM}`);
  out(`to:        ${to}`);
  out(`template:  ${template}\n`);

  out('Verifying the connection…');
  await mailer().verify();
  out('  connection ok\n');

  const { subject, html, text } = render(template, SAMPLE);

  out('Sending…');
  const result = await sendMail({ to, subject, html, text });
  out(`  sent — message id ${result.id}`);

  if (env.MAIL_DRIVER === 'log') {
    out('\nMAIL_DRIVER is "log", so nothing left this machine.');
    out('Set MAIL_DRIVER=smtp with SMTP_HOST to deliver for real.');
  }
}

main()
  .then(async () => { await closeMailer(); process.exit(0); })
  .catch(async (err) => {
    out(`\nFAILED: ${err.message}`);
    if (err.permanent) out('This is a permanent failure — the outbox would not retry it.');
    await closeMailer().catch(() => {});
    process.exit(1);
  });
