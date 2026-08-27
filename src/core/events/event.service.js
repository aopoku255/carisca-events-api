import { Op } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import { slugify } from '../../lib/ids.js';
import { NotFoundError, AppError } from '../../lib/errors.js';
import { record as audit } from '../audit/audit.service.js';
import { notify } from '../notifications/notification.service.js';
import { logger } from '../../lib/logger.js';
import {
  STATUS, PUBLIC_STATUSES, assertCan, validateForPublication,
} from './event-state-machine.js';

const {
  Event, EventType, EventPrice, EventSession, EventSpeaker,
  RegistrationQuestion, Registration, CpdEventDetail, SummitEventDetail,
  EventTrack, EventSponsorshipTier, Country, EvaluationForm, EvaluationQuestion,
} = models;

/**
 * Shared event operations. Every module uses this; CPD adds its own rules on
 * top rather than reimplementing lifecycle, slugs or publication checks.
 */

export const DETAIL_INCLUDE = [
  { model: EventType, as: 'type' },
  { model: EventPrice, as: 'prices' },
  {
    model: EventSession,
    as: 'sessions',
    separate: true,
    order: [['sort_order', 'ASC'], ['start_at', 'ASC']],
    include: [{ model: EventTrack, as: 'track' }],
  },
  {
    model: EventSpeaker,
    as: 'speakers',
    separate: true,
    order: [['sort_order', 'ASC']],
    include: [{ model: models.File, as: 'photo' }],
  },
  { model: RegistrationQuestion, as: 'questions', separate: true, order: [['sort_order', 'ASC']] },
  {
    model: EvaluationForm,
    as: 'evaluationForms',
    where: { phase: 'POST' },
    required: false,
    separate: true,
    include: [{
      model: EvaluationQuestion, as: 'questions', separate: true, order: [['sort_order', 'ASC']],
    }],
  },
  { model: CpdEventDetail, as: 'cpd' },
  { model: SummitEventDetail, as: 'summit' },
  { model: EventTrack, as: 'tracks', separate: true, order: [['sort_order', 'ASC']] },
  { model: EventSponsorshipTier, as: 'sponsorshipTiers', separate: true, order: [['sort_order', 'ASC']] },
  { model: Country, as: 'country' },
  { model: models.File, as: 'banner' },
  {
    model: models.Partner,
    as: 'partners',
    through: { attributes: ['role', 'sort_order', 'sponsorship_tier_id'] },
    include: [{ model: models.File, as: 'logo' }],
  },
];

async function uniqueSlug(title) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = slugify(title);
    // eslint-disable-next-line no-await-in-loop
    const clash = await Event.findOne({ where: { slug: candidate }, paranoid: false });
    if (!clash) return candidate;
  }
  throw new AppError('Could not generate a unique slug for this event.', { code: 'SLUG_EXHAUSTED' });
}

export async function findById(id, { includeDetail = true, transaction = null, lock = false } = {}) {
  const event = await Event.findByPk(id, {
    include: includeDetail && !lock ? DETAIL_INCLUDE : undefined,
    transaction,
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!event) throw new NotFoundError('Event');
  return event;
}

export async function findPublicBySlug(slug) {
  const event = await Event.findOne({
    where: { slug, status: { [Op.in]: PUBLIC_STATUSES } },
    include: DETAIL_INCLUDE,
  });
  if (!event) throw new NotFoundError('Event');
  return event;
}

export async function create(input, { actor, moduleKey, context = {} }) {
  const type = await EventType.findOne({ where: { key: moduleKey } });
  if (!type) throw new NotFoundError(`Event type "${moduleKey}"`);

  const event = await sequelize.transaction(async (transaction) => {
    const created = await Event.create({
      ...input,
      event_type_id: type.id,
      slug: input.slug || await uniqueSlug(input.title),
      status: STATUS.DRAFT,
      created_by: actor?.id ?? null,
    }, { transaction });

    if (input.cpd && moduleKey === 'cpd') {
      await CpdEventDetail.create({ event_id: created.id, ...input.cpd }, { transaction });
    }
    if (input.summit && moduleKey === 'summit') {
      await SummitEventDetail.create({ event_id: created.id, ...input.summit }, { transaction });
    }

    await audit({
      actor,
      action: 'event.created',
      resourceType: 'event',
      resourceId: created.id,
      after: { title: created.title, type: moduleKey, status: created.status },
      context,
    }, { transaction });

    return created;
  });

  logger.info({ eventId: event.id, moduleKey, actorId: actor?.id }, 'event created');
  return findById(event.id);
}

export async function update(id, input, { actor, context = {} }) {
  const event = await findById(id, { includeDetail: false });

  if (event.status === STATUS.ARCHIVED) {
    throw new AppError('An archived event cannot be edited.', { status: 409, code: 'EVENT_ARCHIVED' });
  }

  const before = event.toJSON();

  await sequelize.transaction(async (transaction) => {
    await event.update(input, { transaction });

    if (input.cpd) {
      const [detail] = await CpdEventDetail.findOrCreate({
        where: { event_id: id }, defaults: { event_id: id }, transaction,
      });
      await detail.update(input.cpd, { transaction });
    }
    if (input.summit) {
      const [detail] = await SummitEventDetail.findOrCreate({
        where: { event_id: id }, defaults: { event_id: id }, transaction,
      });
      await detail.update(input.summit, { transaction });
    }

    await audit({
      actor,
      action: 'event.updated',
      resourceType: 'event',
      resourceId: id,
      before,
      after: event.toJSON(),
      context,
    }, { transaction });
  });

  // Confirmed participants must hear about a date or venue change.
  const significant = ['start_at', 'end_at', 'timezone', 'venue', 'online_url'];
  const changed = significant.filter((f) => input[f] !== undefined && String(before[f]) !== String(event[f]));
  if (changed.length && PUBLIC_STATUSES.includes(event.status)) {
    await notifyRegistrants(event, 'event_updated', { changed });
  }

  return findById(id);
}

/** Fan-out to everyone holding a live registration. */
export async function notifyRegistrants(event, template, extraPayload = {}) {
  const registrations = await Registration.findAll({
    where: { event_id: event.id, status: { [Op.in]: ['CONFIRMED', 'PENDING_PAYMENT', 'WAITLISTED'] } },
    include: [{ model: models.User, as: 'user', attributes: ['id', 'email', 'first_name'] }],
  });

  await Promise.all(registrations.map((r) => notify({
    userId: r.user_id,
    channel: 'EMAIL',
    template,
    toAddress: r.user?.email,
    subject: `Update: ${event.title}`,
    payload: {
      firstName: r.user?.first_name,
      eventTitle: event.title,
      reference: r.reference,
      ...extraPayload,
    },
    resourceType: 'event',
    resourceId: String(event.id),
  })));

  return registrations.length;
}

/**
 * Runs a lifecycle transition. `publish` additionally validates that the event
 * is actually usable — see validateForPublication.
 */
export async function transition(id, name, { actor, reason = null, context = {} } = {}) {
  const event = await findById(id, { includeDetail: false });
  const to = assertCan(event, name);

  if (name === 'publish') {
    const [prices, sessions] = await Promise.all([
      EventPrice.findAll({ where: { event_id: id } }),
      EventSession.findAll({ where: { event_id: id } }),
    ]);
    validateForPublication(event, { prices, sessions });
  }

  const from = event.status;

  await sequelize.transaction(async (transaction) => {
    const patch = { status: to };
    if (name === 'publish' && !event.published_at) patch.published_at = new Date();
    if (name === 'cancel') patch.cancelled_reason = reason;

    await event.update(patch, { transaction });

    await audit({
      actor,
      action: `event.${name}`,
      resourceType: 'event',
      resourceId: id,
      before: { status: from },
      after: { status: to },
      metadata: reason ? { reason } : null,
      context,
    }, { transaction });
  });

  if (name === 'cancel') {
    // Refunds are queued by the payments module in Week 2; the notification
    // goes out now regardless so nobody travels to a cancelled event.
    await notifyRegistrants(event, 'event_cancelled', { reason });
  }

  logger.info({ eventId: id, from, to, actorId: actor?.id }, `event.${name}`);
  return findById(id);
}

/**
 * Seats taken: confirmed registrations plus unexpired holds. Counting holds is
 * what stops two people taking the last place while one of them is paying.
 */
export async function occupancy(eventId, { attendanceMode = null, transaction = null } = {}) {
  const where = {
    event_id: eventId,
    status: { [Op.in]: Registration.OCCUPYING },
    [Op.or]: [
      { status: { [Op.ne]: 'PENDING_PAYMENT' } },
      { hold_expires_at: { [Op.gt]: new Date() } },
    ],
  };
  if (attendanceMode) where.attendance_mode = attendanceMode;

  return Registration.count({ where, transaction });
}

/**
 * Currency lives on the price rows, so this is where it has to be protected.
 *
 * An existing registration has its amount and currency frozen on its own row,
 * so it can never be restated. But withdrawing a currency that people are
 * currently mid-payment in leaves them holding a quote nothing can settle,
 * so replacing the price list may not drop a currency still in use.
 */
export async function assertCurrenciesStillCovered(eventId, incomingCurrencies, { transaction = null } = {}) {
  const live = await Registration.findAll({
    attributes: [
      [sequelize.fn('DISTINCT', sequelize.col('currency')), 'currency'],
    ],
    where: {
      event_id: eventId,
      currency: { [Op.ne]: null },
      status: { [Op.in]: ['PENDING_PAYMENT', 'CONFIRMED', 'REQUIRES_REVIEW'] },
    },
    raw: true,
    transaction,
  });

  const offered = new Set(incomingCurrencies.map((c) => String(c).toUpperCase()));
  const orphaned = live
    .map((r) => r.currency)
    .filter((c) => c && !offered.has(String(c).toUpperCase()));

  if (orphaned.length) {
    throw new AppError(
      `Cannot remove ${orphaned.join(', ')} — people are registered at that price.`,
      {
        status: 409,
        code: 'CURRENCY_IN_USE',
        details: { inUse: [...new Set(orphaned)], offered: [...offered] },
      },
    );
  }

  return true;
}

export async function capacityStatus(event, attendanceMode) {
  const capacity = event.capacityFor(attendanceMode);
  if (capacity === null || capacity === undefined) {
    return { capacity: null, taken: null, remaining: null, isFull: false };
  }
  const taken = await occupancy(event.id, { attendanceMode });
  return { capacity, taken, remaining: Math.max(0, capacity - taken), isFull: taken >= capacity };
}

export default {
  findById, findPublicBySlug, create, update, transition,
  occupancy, capacityStatus, notifyRegistrants,
  assertCurrenciesStillCovered, DETAIL_INCLUDE,
};
