import QRCode from 'qrcode';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { renderCertificateHtml, WIDTH, HEIGHT } from './certificate.template.js';
import { getPage } from './browser.js';
import { models } from '../../database/models/index.js';
import { verificationCode } from '../../lib/ids.js';
import * as storage from '../files/storage.service.js';
import { hasCompletedRequiredSurvey } from '../evaluations/evaluation.service.js';
import env from '../../config/env.js';

const {
  Certificate, EventType, CertificateTemplate, File,
} = models;

function ordinal(n) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] ?? suffixes[v] ?? suffixes[0]}`;
}

/**
 * "28th October, 2026" — the exact phrasing the source template uses. Built
 * from the start date only: the sentence is singular ("on {date}"), and the
 * template has no second slot for an end date, so a multi-day CPD is dated
 * by when it began rather than stretching the sentence to fit a range.
 */
function formatCertificateDate(startAt, timezone = 'Africa/Accra') {
  const date = new Date(startAt);
  const day = Number(new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: timezone }).format(date));
  const month = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: timezone }).format(date);
  const year = new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: timezone }).format(date);
  return `${ordinal(day)} ${month}, ${year}`;
}

/**
 * Whether `registration` currently earns a certificate — the conditions an
 * event publishes on its page (see `serialisePublicEvent`'s `attendance`
 * block) reduced to what is actually enforceable today.
 *
 * "The program is done" is checked two ways, either satisfying it: the
 * `complete` transition (a manual staff action) if staff have run it, or
 * `end_at` having simply passed. The transition alone isn't relied on
 * because nothing auto-runs it — an event staff never gets around to
 * marking `COMPLETED` would otherwise block a certificate forever for a
 * participant who genuinely finished the program.
 *
 * `certificate_requires_evaluation` is now enforced (`hasCompletedRequiredSurvey`,
 * evaluation.service.js) — it stayed unchecked here for a while because there
 * was no survey feature yet to have been completed.
 */
export async function certificateEligibility(registration) {
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
  const eventFinished = event.status === 'COMPLETED' || new Date(event.end_at) <= new Date();
  if (!eventFinished) {
    return {
      eligible: false,
      code: 'EVENT_NOT_FINISHED',
      reason: 'Your certificate will be available once the program ends.',
    };
  }
  if (!(await hasCompletedRequiredSurvey(registration, event))) {
    return {
      eligible: false,
      code: 'EVALUATION_REQUIRED',
      reason: 'Complete the post-event survey before downloading your certificate.',
    };
  }
  if (registration.wants_certificate === false) {
    return { eligible: false, code: 'CERTIFICATE_OPTED_OUT', reason: 'A certificate was not requested for this registration.' };
  }
  return { eligible: true };
}

/**
 * Loads the second-signatory data a `CertificateTemplate` contributes, or
 * `null` if there's nothing usable — no template set on the event, or a
 * template that exists but has no signature image uploaded yet. All-or-
 * nothing on purpose: `renderCertificateHtml()` only draws the dynamic
 * signature block when every field is present, and a name with no image (or
 * vice versa) is exactly the half-finished state that should fall back to
 * the artwork's own baked-in signature rather than render something broken.
 *
 * Shared with the admin preview endpoint (`certificate-template.routes.js`)
 * so preview and the real certificate can never drift apart.
 */
export async function resolveSignatureTwo(template) {
  if (!template?.signatory_name || !template?.signature_file_id) return null;

  const file = template.signatureFile ?? await storage.find(template.signature_file_id);
  const buffer = await storage.bufferFor(file);

  return {
    signatoryName: template.signatory_name,
    signatoryTitle: template.signatory_title,
    signatoryDepartment: template.signatory_department,
    signatureDataUrl: `data:${file.mime_type};base64,${buffer.toString('base64')}`,
  };
}

/**
 * The one row of record that this certificate was issued, keyed by
 * registration (`UNIQUE(registration_id)` in the schema — one certificate
 * per registration, ever). Created on first download and reused after that,
 * so the verification code printed on the certificate never changes between
 * a PDF and a PNG, or between today's download and next year's.
 */
async function ensureCertificateRecord(registration, signatureTwo) {
  const existing = await Certificate.findOne({ where: { registration_id: registration.id } });
  if (existing) {
    existing.download_count += 1;
    existing.last_downloaded_at = new Date();
    await existing.save();
    return existing;
  }

  const event = registration.event;
  const user = registration.user;
  const type = await EventType.findByPk(event.event_type_id);

  try {
    return await Certificate.create({
      registration_id: registration.id,
      event_id: event.id,
      user_id: user.id,
      // The registration's own id stands in for a certificates-only
      // sequence — already unique and known before insert, so issuing a
      // code needs no follow-up write once the row's own id is assigned.
      verification_code: verificationCode(type?.key ?? 'evt', registration.id, event.start_at),
      // Frozen at issuance, same as the rest of this snapshot — editing the
      // template later (or reassigning the event to a different one) must
      // not rewrite what an already-issued certificate says happened.
      issued_snapshot: {
        participantName: `${user.first_name} ${user.last_name}`.trim(),
        eventTitle: event.title,
        dateLabel: formatCertificateDate(event.start_at, event.timezone),
        venue: event.venue || null,
        signatoryName: signatureTwo?.signatoryName ?? null,
        signatoryTitle: signatureTwo?.signatoryTitle ?? null,
        signatoryDepartment: signatureTwo?.signatoryDepartment ?? null,
      },
      status: 'ISSUED',
      issued_at: new Date(),
      download_count: 1,
      last_downloaded_at: new Date(),
    });
  } catch (err) {
    // A concurrent request for the same registration (a double-clicked
    // download) won the race — its row already exists, so use that one
    // rather than surfacing a conflict for what is really a duplicate read.
    if (err.name === 'SequelizeUniqueConstraintError') {
      return Certificate.findOne({ where: { registration_id: registration.id } });
    }
    throw err;
  }
}

export async function generateCertificate(registration, { format = 'pdf' } = {}) {
  const { eligible, code, reason } = await certificateEligibility(registration);
  if (!eligible) throw new ConflictError(reason, code);

  const event = registration.event;
  const user = registration.user;
  if (!user) throw new NotFoundError('Participant');

  const template = event.certificate_template_id
    ? await CertificateTemplate.findByPk(event.certificate_template_id, {
      include: [{ model: File, as: 'signatureFile' }],
    })
    : null;
  const signatureTwo = await resolveSignatureTwo(template);

  const certificate = await ensureCertificateRecord(registration, signatureTwo);
  const verifyUrl = `${env.WEB_URL}/verify/${certificate.verification_code}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
    margin: 1,
    width: 300,
    color: { dark: '#0F66DB', light: '#FFFFFFFF' },
  });

  const html = renderCertificateHtml({
    participantName: `${user.first_name} ${user.last_name}`.trim(),
    eventTitle: event.title,
    dateLabel: formatCertificateDate(event.start_at, event.timezone),
    venue: event.venue || null,
    verificationCode: certificate.verification_code,
    qrDataUrl,
    ...signatureTwo,
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

export default { generateCertificate, certificateEligibility, resolveSignatureTwo };
