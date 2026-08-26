import { AppError } from '../../lib/errors.js';

/**
 * Event lifecycle. Statuses change through named transitions, never by a
 * client PATCHing `status` — otherwise a draft could be dropped straight into
 * COMPLETED and skip every check along the way.
 */

export const STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  PUBLISHED: 'PUBLISHED',
  REGISTRATION_OPEN: 'REGISTRATION_OPEN',
  REGISTRATION_CLOSED: 'REGISTRATION_CLOSED',
  ONGOING: 'ONGOING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  ARCHIVED: 'ARCHIVED',
});

/** transition name → { from: [...], to } */
export const TRANSITIONS = Object.freeze({
  submitForApproval: { from: [STATUS.DRAFT], to: STATUS.PENDING_APPROVAL },
  requestChanges: { from: [STATUS.PENDING_APPROVAL], to: STATUS.DRAFT },
  publish: { from: [STATUS.DRAFT, STATUS.PENDING_APPROVAL], to: STATUS.PUBLISHED },
  unpublish: { from: [STATUS.PUBLISHED], to: STATUS.DRAFT },
  openRegistration: { from: [STATUS.PUBLISHED, STATUS.REGISTRATION_CLOSED], to: STATUS.REGISTRATION_OPEN },
  closeRegistration: { from: [STATUS.REGISTRATION_OPEN], to: STATUS.REGISTRATION_CLOSED },
  start: {
    from: [STATUS.PUBLISHED, STATUS.REGISTRATION_OPEN, STATUS.REGISTRATION_CLOSED],
    to: STATUS.ONGOING,
  },
  complete: { from: [STATUS.ONGOING, STATUS.REGISTRATION_CLOSED], to: STATUS.COMPLETED },
  cancel: {
    from: [
      STATUS.DRAFT, STATUS.PENDING_APPROVAL, STATUS.PUBLISHED,
      STATUS.REGISTRATION_OPEN, STATUS.REGISTRATION_CLOSED, STATUS.ONGOING,
    ],
    to: STATUS.CANCELLED,
  },
  archive: { from: [STATUS.COMPLETED, STATUS.CANCELLED], to: STATUS.ARCHIVED },
});

/** Statuses in which the public may see the event at all. */
export const PUBLIC_STATUSES = Object.freeze([
  STATUS.PUBLISHED, STATUS.REGISTRATION_OPEN, STATUS.REGISTRATION_CLOSED,
  STATUS.ONGOING, STATUS.COMPLETED,
]);

/** Once anyone has registered, some edits are no longer safe. */
export const LOCKED_AFTER_REGISTRATIONS = Object.freeze([
  'currency', 'event_type_id',
]);

export function can(event, transition) {
  const rule = TRANSITIONS[transition];
  if (!rule) return false;
  return rule.from.includes(event.status);
}

export function assertCan(event, transition) {
  const rule = TRANSITIONS[transition];
  if (!rule) {
    throw new AppError(`Unknown transition "${transition}".`, { code: 'UNKNOWN_TRANSITION' });
  }
  if (!rule.from.includes(event.status)) {
    throw new AppError(
      `An event that is ${event.status} cannot be ${transitionVerb(transition)}.`,
      {
        status: 409,
        code: 'INVALID_TRANSITION',
        details: { current: event.status, transition, allowedFrom: rule.from },
      },
    );
  }
  return rule.to;
}

function transitionVerb(transition) {
  return {
    submitForApproval: 'submitted for approval',
    requestChanges: 'returned for changes',
    publish: 'published',
    unpublish: 'unpublished',
    openRegistration: 'opened for registration',
    closeRegistration: 'closed for registration',
    start: 'started',
    complete: 'completed',
    cancel: 'cancelled',
    archive: 'archived',
  }[transition] || transition;
}

/**
 * Configuration that must be in place before the public can see an event.
 *
 * Catching these at publish rather than at registration is the difference
 * between an administrator seeing a clear error and a participant hitting a
 * broken checkout.
 */
export function validateForPublication(event, { prices = [], sessions = [] } = {}) {
  const problems = [];

  if (!event.title?.trim()) problems.push('The event needs a title.');
  if (!event.start_at || !event.end_at) problems.push('The event needs a start and end date.');
  if (event.start_at && event.end_at && event.end_at < event.start_at) {
    problems.push('The event ends before it starts.');
  }
  if (!event.timezone) problems.push('The event needs a timezone.');

  if (event.registration_closes_at && event.registration_opens_at
      && event.registration_closes_at < event.registration_opens_at) {
    problems.push('Registration closes before it opens.');
  }
  if (event.registration_closes_at && event.end_at && event.registration_closes_at > event.end_at) {
    problems.push('Registration closes after the event has finished.');
  }

  if (event.delivery_mode !== 'ONLINE' && !event.venue?.trim()) {
    problems.push('An in-person or hybrid event needs a venue.');
  }
  if (event.delivery_mode !== 'OFFLINE' && !event.online_url?.trim()) {
    problems.push('An online or hybrid event needs a joining link.');
  }

  // A paid event with no price the resolver can find is a broken checkout.
  if (prices.length === 0) {
    problems.push('The event needs at least one price. Use 0 for a free event.');
  }

  if (event.attendance_rule === 'SESSION_PERCENT') {
    if (!event.min_attendance_percent) {
      problems.push('A session-percentage attendance rule needs a minimum percentage.');
    }
    if (!sessions.some((s) => s.is_required_for_attendance)) {
      problems.push('A session-percentage attendance rule needs at least one required session.');
    }
  }

  if (problems.length) {
    throw new AppError('This event is not ready to be published.', {
      status: 422,
      code: 'NOT_PUBLISHABLE',
      details: { problems },
    });
  }

  return true;
}

export default { STATUS, TRANSITIONS, PUBLIC_STATUSES, can, assertCan, validateForPublication };
