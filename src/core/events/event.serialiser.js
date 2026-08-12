import { serialiseMoney } from '../../lib/money.js';
import { serialiseFile } from '../files/storage.service.js';

/**
 * Two views of an event. The public one omits anything operational — who
 * created it, which department owns it, how full it is in absolute terms —
 * because a participant needs none of that and a competitor should not have it.
 */

function base(event) {
  return {
    id: String(event.id),
    slug: event.slug,
    type: event.type ? { key: event.type.key, name: event.type.name } : undefined,
    title: event.title,
    shortDescription: event.short_description ?? null,
    description: event.description ?? null,
    startAt: event.start_at,
    endAt: event.end_at,
    timezone: event.timezone,
    deliveryMode: event.delivery_mode,
    location: {
      countryCode: event.country_code ?? null,
      country: event.country?.name ?? null,
      city: event.city ?? null,
      venue: event.venue ?? null,
    },
    registrationOpensAt: event.registration_opens_at ?? null,
    registrationClosesAt: event.registration_closes_at ?? null,
    status: event.status,
    issuesCertificate: !!event.issues_certificate,
    // Public: banners are marked PUBLIC at upload, so the URL needs no auth.
    banner: serialiseFile(event.banner),
  };
}

function prices(event) {
  if (!event.prices) return undefined;
  return event.prices.map((p) => ({
    id: String(p.id),
    tier: p.tier,
    label: p.label,
    attendanceMode: p.attendance_mode,
    audience: p.audience,
    money: serialiseMoney(p.amount_minor, p.currency),
    availableFrom: p.available_from ?? null,
    availableUntil: p.available_until ?? null,
  }));
}

function questions(event) {
  if (!event.questions) return undefined;
  return event.questions.map((q) => ({
    id: String(q.id),
    label: q.label,
    helpText: q.help_text ?? null,
    type: q.type,
    options: q.options ?? null,
    required: !!q.is_required,
    sortOrder: q.sort_order,
  }));
}

function sessions(event) {
  if (!event.sessions) return undefined;
  return event.sessions.map((s) => ({
    id: String(s.id),
    title: s.title,
    description: s.description ?? null,
    startAt: s.start_at,
    endAt: s.end_at,
    location: s.location ?? null,
    requiredForAttendance: !!s.is_required_for_attendance,
  }));
}

function speakers(event) {
  if (!event.speakers) return undefined;
  return event.speakers.map((s) => ({
    id: String(s.id),
    name: s.name,
    title: s.title ?? null,
    organization: s.organization ?? null,
    bio: s.bio ?? null,
    role: s.role,
  }));
}

function cpd(event) {
  if (!event.cpd) return undefined;
  return {
    credits: event.cpd.cpd_credits ? Number(event.cpd.cpd_credits) : null,
    accreditingBody: event.cpd.accrediting_body ?? null,
    learningObjectives: event.cpd.learning_objectives ?? [],
    targetAudience: event.cpd.target_audience ?? [],
    requirements: event.cpd.requirements ?? null,
  };
}

/** For the public site and the participant portal. */
export function serialisePublicEvent(event, { capacity = null } = {}) {
  return {
    ...base(event),
    onlineUrl: undefined, // only released to a confirmed registrant
    // The certificate condition is published deliberately: telling someone a
    // certificate is awarded without saying what earns it is a complaint
    // waiting to happen.
    attendance: {
      rule: event.attendance_rule,
      minPercent: event.min_attendance_percent ?? null,
    },
    prices: prices(event),
    questions: questions(event),
    sessions: sessions(event),
    speakers: speakers(event),
    cpd: cpd(event),
    // Whether places remain, not the exact headcount.
    availability: capacity ? {
      inPerson: capacity.inPerson ? { isFull: capacity.inPerson.isFull } : null,
      virtual: capacity.virtual ? { isFull: capacity.virtual.isFull } : null,
    } : undefined,
    contact: {
      email: event.contact_email ?? null,
      phone: event.contact_phone ?? null,
    },
  };
}

/** For the admin console. */
export function serialiseAdminEvent(event, { capacity = null } = {}) {
  return {
    ...base(event),
    onlineUrl: event.online_url ?? null,
    capacity: event.capacity ?? null,
    virtualCapacity: event.virtual_capacity ?? null,
    allowWaitlist: !!event.allow_waitlist,
    paymentHoldHours: event.payment_hold_hours ?? null,
    cancelledReason: event.cancelled_reason ?? null,
    certificate: {
      issues: !!event.issues_certificate,
      templateId: event.certificate_template_id ? String(event.certificate_template_id) : null,
      requiresPayment: !!event.certificate_requires_payment,
      requiresEvaluation: !!event.certificate_requires_evaluation,
    },
    attendance: {
      rule: event.attendance_rule,
      minPercent: event.min_attendance_percent ?? null,
    },
    organizerDepartmentId: event.organizer_department_id ? String(event.organizer_department_id) : null,
    createdBy: event.created_by ? String(event.created_by) : null,
    publishedAt: event.published_at ?? null,
    createdAt: event.created_at,
    updatedAt: event.updated_at,
    prices: prices(event),
    questions: questions(event),
    sessions: sessions(event),
    speakers: speakers(event),
    cpd: cpd(event),
    occupancy: capacity ?? undefined,
  };
}

export function serialiseRegistration(registration, { includeAnswers = false, includeQr = false } = {}) {
  const out = {
    id: String(registration.id),
    reference: registration.reference,
    status: registration.status,
    attendanceMode: registration.attendance_mode,
    holdExpiresAt: registration.hold_expires_at ?? null,
    amount: registration.currency
      ? serialiseMoney(registration.price_amount_minor, registration.currency)
      : null,
    priceTier: registration.price_tier ?? null,
    wantsCertificate: registration.wants_certificate,
    isPreviousAttendee: registration.is_previous_attendee,
    mediaConsentGiven: !!registration.media_consent_at,
    comments: registration.comments ?? null,
    specialRequirements: registration.special_requirements ?? null,
    confirmedAt: registration.confirmed_at ?? null,
    cancelledAt: registration.cancelled_at ?? null,
    cancellationReason: registration.cancellation_reason ?? null,
    createdAt: registration.created_at,
  };

  if (registration.event) {
    out.event = {
      id: String(registration.event.id),
      slug: registration.event.slug,
      title: registration.event.title,
      startAt: registration.event.start_at,
      endAt: registration.event.end_at,
      timezone: registration.event.timezone,
      status: registration.event.status,
      // The joining link is a benefit of having registered, so it is released
      // here rather than on the public event page.
      onlineUrl: registration.status === 'CONFIRMED' ? registration.event.online_url ?? null : null,
    };
  }

  if (registration.user) {
    out.participant = {
      id: String(registration.user.id),
      name: `${registration.user.first_name} ${registration.user.last_name}`.trim(),
      email: registration.user.email,
      organization: registration.user.organization ?? null,
      countryCode: registration.user.country_code ?? null,
    };
  }

  if (includeAnswers && registration.answers) {
    out.answers = registration.answers.map((a) => ({
      questionId: String(a.question_id),
      label: a.question?.label ?? null,
      type: a.question?.type ?? null,
      value: a.value,
    }));
  }

  if (includeQr && registration.qr_token) out.qrToken = registration.qr_token;

  return out;
}

export default { serialisePublicEvent, serialiseAdminEvent, serialiseRegistration };
