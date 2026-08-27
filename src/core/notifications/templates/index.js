import env from '../../../config/env.js';

/**
 * Email templates.
 *
 * Rendered at dispatch time from the notification's stored payload, so fixing
 * a typo also fixes anything still queued. Plain objects rather than a
 * templating engine: there are eleven of them and they are mostly one
 * paragraph and a link.
 */

const escape = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const BRAND = { blue: '#0F3B8F', navy: '#0A2961', slate: '#677289', mist: '#B3BDD1' };

function layout({ heading, body, cta }) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#F4F7FC;font-family:Arial,Helvetica,sans-serif;color:#111C36">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:560px;background:#fff;border:1px solid ${BRAND.mist};border-radius:4px">
        <tr><td style="background:${BRAND.blue};padding:20px 28px">
          <div style="color:#fff;font-size:18px;font-weight:bold;letter-spacing:.5px">CARISCA</div>
          <div style="color:#C7D6F2;font-size:11px;margin-top:2px">Strong Supply Chains — Strong Communities</div>
        </td></tr>
        <tr><td style="padding:28px">
          <h1 style="margin:0 0 16px;font-size:20px;color:${BRAND.navy}">${heading}</h1>
          <div style="font-size:15px;line-height:1.6;color:#111C36">${body}</div>
          ${cta ? `<div style="margin:28px 0 8px">
            <a href="${escape(cta.url)}" style="background:${BRAND.blue};color:#fff;text-decoration:none;
               padding:12px 22px;border-radius:3px;font-size:15px;display:inline-block">${escape(cta.label)}</a>
          </div>` : ''}
        </td></tr>
        <tr><td style="padding:18px 28px;border-top:1px solid #EBF0F9;font-size:12px;color:${BRAND.slate}">
          Centre for Applied Research and Innovation in Supply Chain-Africa<br>
          KNUST School of Business, Kumasi, Ghana
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

const money = (m) => (m ? `${escape(m.currency)} ${escape(m.formatted)}` : '');

const when = (iso, timezone = 'Africa/Accra') => {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'full', timeStyle: 'short', timeZone: timezone,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString();
  }
};

export const templates = {
  email_verification: (p) => ({
    subject: 'Confirm your CARISCA account',
    heading: `Welcome, ${escape(p.firstName)}`,
    body: `<p>Confirm your email address to finish setting up your CARISCA account.</p>
           <p style="color:${BRAND.slate};font-size:13px">This link expires in ${escape(p.expiresInHours)} hours.</p>`,
    cta: { label: 'Confirm my email', url: p.verifyUrl },
  }),

  /**
   * Sent once, at creation, for an account an administrator set up directly —
   * never queued through the ordinary outbox (see createUser() for why): the
   * password only ever exists in this one outbound message, not in a table a
   * later backup or breach could read back.
   */
  account_created: (p) => ({
    subject: p.isStaff ? 'Your CARISCA staff account is ready' : 'Your CARISCA account is ready',
    heading: `Welcome, ${escape(p.firstName)}`,
    body: `<p>An administrator has set up ${p.isStaff ? 'a staff account for you on' : 'your account with'} CARISCA.</p>
           <p><strong>Email:</strong> ${escape(p.email)}<br>
              <strong>Password:</strong> ${escape(p.password)}</p>
           <p style="color:${BRAND.slate};font-size:13px">Change this password from your profile once you have
              signed in — nobody else should know it once you do.</p>`,
    cta: {
      label: p.isStaff ? 'Sign in to the console' : 'Sign in',
      url: p.isStaff ? `${env.ADMIN_URL}/login` : `${env.WEB_URL}/login`,
    },
  }),

  password_reset: (p) => ({
    subject: 'Reset your CARISCA password',
    heading: 'Reset your password',
    body: `<p>Hello ${escape(p.firstName)}, we received a request to reset your password.</p>
           <p style="color:${BRAND.slate};font-size:13px">This link expires in ${escape(p.expiresInMinutes)} minutes.
           If you did not ask for this, you can ignore this email — your password will not change.</p>`,
    cta: { label: 'Reset my password', url: p.resetUrl },
  }),

  registration_confirmed: (p) => ({
    subject: `You're registered: ${p.eventTitle}`,
    heading: 'Your place is confirmed',
    body: `<p>Hello ${escape(p.firstName)}, you are registered for <strong>${escape(p.eventTitle)}</strong>.</p>
           <p><strong>Reference:</strong> ${escape(p.reference)}<br>
              <strong>Attending:</strong> ${p.attendanceMode === 'VIRTUAL' ? 'Online' : 'In person'}</p>
           <p>Bring your QR code with you — it is in your dashboard and is how we check you in.</p>`,
    cta: { label: 'View my registration', url: `${env.WEB_URL}/dashboard/registrations` },
  }),

  abstract_decided: (p) => ({
    subject: p.accepted
      ? `Accepted: your abstract for ${p.eventTitle}`
      : `About your submission to ${p.eventTitle}`,
    heading: p.accepted ? 'Your abstract has been accepted' : 'Update on your submission',
    body: `<p>Hello ${escape(p.firstName)}, a decision has been made on your submission
           <strong>${escape(p.title)}</strong> for <strong>${escape(p.eventTitle)}</strong>.</p>
           <p><strong>Decision:</strong> ${p.accepted ? 'Accepted' : 'Not accepted'}</p>
           ${p.notes ? `<p>${escape(p.notes)}</p>` : ''}`,
    cta: { label: 'View my submission', url: `${env.WEB_URL}/dashboard/abstracts` },
  }),

  registration_pending_payment: (p) => ({
    subject: `Complete your registration: ${p.eventTitle}`,
    heading: 'One step left',
    body: `<p>Hello ${escape(p.firstName)}, we have your details for
             <strong>${escape(p.eventTitle)}</strong>.</p>
           <p><strong>Your registration is not complete until payment is made.</strong>
              We are holding your place until <strong>${when(p.holdExpiresAt)}</strong>.</p>
           <p><strong>Amount:</strong> ${money(p.amount)}<br>
              <strong>Reference:</strong> ${escape(p.reference)}</p>`,
    cta: { label: 'Pay now', url: p.paymentUrl },
  }),

  payment_failed: (p) => ({
    subject: 'Your payment did not go through',
    heading: 'Payment did not complete',
    body: `<p>Hello ${escape(p.firstName)}, your payment for registration
             <strong>${escape(p.reference)}</strong> did not go through.</p>
           ${p.reason ? `<p style="color:${BRAND.slate}">${escape(p.reason)}</p>` : ''}
           <p>Your place is still being held — you can try again.</p>`,
    cta: { label: 'Try again', url: p.payUrl },
  }),

  registration_waitlisted: (p) => ({
    subject: `Waitlisted: ${p.eventTitle}`,
    heading: "You're on the waitlist",
    body: `<p>Hello ${escape(p.firstName)}, <strong>${escape(p.eventTitle)}</strong> is currently full.</p>
           <p>You are on the waitlist and we will email you as soon as a place opens up.
              No payment is needed yet.</p>
           <p><strong>Reference:</strong> ${escape(p.reference)}</p>`,
    cta: null,
  }),

  waitlist_promoted: (p) => ({
    subject: `A place has opened up: ${p.eventTitle}`,
    heading: 'A place is yours',
    body: `<p>Hello ${escape(p.firstName)}, a place has opened up for
             <strong>${escape(p.eventTitle)}</strong>.</p>
           ${p.paymentUrl
    ? `<p>Complete payment by <strong>${when(p.holdExpiresAt)}</strong> to secure it.</p>`
    : '<p>Your place is confirmed — nothing further is needed.</p>'}`,
    cta: p.paymentUrl ? { label: 'Pay now', url: p.paymentUrl } : null,
  }),

  registration_expired: (p) => ({
    subject: 'Your registration has expired',
    heading: 'Your place has been released',
    body: `<p>Hello ${escape(p.firstName)}, we did not receive payment for registration
             <strong>${escape(p.reference)}</strong>, so the place has been released.</p>
           <p>You are welcome to register again if places remain.</p>`,
    cta: { label: 'Browse events', url: `${env.WEB_URL}/events` },
  }),

  event_updated: (p) => ({
    subject: `Update: ${p.eventTitle}`,
    heading: 'Event details have changed',
    body: `<p>Hello ${escape(p.firstName)}, some details of
             <strong>${escape(p.eventTitle)}</strong> have changed
             (${escape((p.changed || []).join(', '))}).</p>
           <p>Please check the latest details before you travel.</p>`,
    cta: { label: 'View the event', url: `${env.WEB_URL}/dashboard/registrations` },
  }),

  event_cancelled: (p) => ({
    subject: `Cancelled: ${p.eventTitle}`,
    heading: 'This event has been cancelled',
    body: `<p>Hello ${escape(p.firstName)}, we are sorry to say that
             <strong>${escape(p.eventTitle)}</strong> has been cancelled.</p>
           ${p.reason ? `<p><strong>Reason:</strong> ${escape(p.reason)}</p>` : ''}
           <p>If you paid, a refund will be processed to your original payment method.
              We will email you when it is on its way.</p>`,
    cta: null,
  }),
};

/** Falls back to a readable generic message rather than failing to send. */
export function render(template, payload = {}) {
  const build = templates[template];
  if (!build) {
    return {
      subject: 'A message from CARISCA',
      html: layout({ heading: 'A message from CARISCA', body: '<p>Please sign in to view the details.</p>' }),
      text: 'Please sign in to view the details.',
    };
  }

  const { subject, heading, body, cta } = build(payload);
  const html = layout({ heading, body, cta });
  const text = `${heading}\n\n${body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`
    + (cta ? `\n\n${cta.label}: ${cta.url}` : '');

  return { subject, html, text };
}

export default { render, templates };
