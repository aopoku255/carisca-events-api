import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { renderCertificateHtml, WIDTH, HEIGHT } from './certificate.template.js';
import { getPage } from './browser.js';

function formatDateLabel(startAt, endAt, timezone = 'Africa/Accra') {
  const start = new Date(startAt);
  const end = new Date(endAt);
  const opts = { dateStyle: 'long', timeZone: timezone };
  const fmt = new Intl.DateTimeFormat('en-GB', opts);
  const sameDay = start.toDateString() === end.toDateString();
  return sameDay ? fmt.format(start) : `${fmt.format(start)} – ${fmt.format(end)}`;
}

/**
 * Whether `registration` currently earns a certificate — the conditions an
 * event publishes on its page (see `serialisePublicEvent`'s `attendance`
 * block) reduced to what is actually enforceable today.
 *
 * `certificate_requires_evaluation` is deliberately not checked: there is no
 * evaluation feature yet to have been completed, so a gate on it could never
 * be satisfied. It is enforced once that feature exists, not before.
 */
export function certificateEligibility(registration) {
  const event = registration.event;
  if (!event) return { eligible: false, reason: 'This registration has no event.' };
  if (!event.issues_certificate) {
    return { eligible: false, code: 'CERTIFICATE_NOT_OFFERED', reason: 'Certificates are not offered for this event.' };
  }
  if (registration.status !== 'CONFIRMED') {
    return {
      eligible: false,
      code: 'REGISTRATION_NOT_CONFIRMED',
      reason: 'Your registration must be confirmed before a certificate is available.',
    };
  }
  if (registration.wants_certificate === false) {
    return { eligible: false, code: 'CERTIFICATE_OPTED_OUT', reason: 'A certificate was not requested for this registration.' };
  }
  return { eligible: true };
}

export async function generateCertificate(registration, { format = 'pdf' } = {}) {
  const { eligible, code, reason } = certificateEligibility(registration);
  if (!eligible) throw new ConflictError(reason, code);

  const event = registration.event;
  const user = registration.user;
  if (!user) throw new NotFoundError('Participant');

  const html = renderCertificateHtml({
    participantName: `${user.first_name} ${user.last_name}`.trim(),
    eventTitle: event.title,
    dateLabel: formatDateLabel(event.start_at, event.end_at, event.timezone),
    credits: event.cpd?.cpd_credits ? Number(event.cpd.cpd_credits) : null,
    accreditingBody: event.cpd?.accrediting_body ?? null,
    code: registration.reference,
  });

  const page = await getPage();
  try {
    await page.setViewport({ width: WIDTH, height: HEIGHT });
    await page.setContent(html, { waitUntil: 'load' });

    if (format === 'png') {
      const buffer = await page.screenshot({ type: 'png' });
      return { buffer, contentType: 'image/png', filename: `certificate-${registration.reference}.png` };
    }

    const buffer = await page.pdf({
      width: `${WIDTH}px`,
      height: `${HEIGHT}px`,
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    return { buffer, contentType: 'application/pdf', filename: `certificate-${registration.reference}.pdf` };
  } finally {
    await page.close();
  }
}

export default { generateCertificate, certificateEligibility };
