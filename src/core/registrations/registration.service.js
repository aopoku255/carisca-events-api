import { Op, QueryTypes } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import env from '../../config/env.js';
import { registrationReference, randomHex } from '../../lib/ids.js';
import { AppError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { notify } from '../notifications/notification.service.js';
import { record as audit } from '../audit/audit.service.js';
import { resolvePrice } from '../events/price-resolver.service.js';
import { validateAnswers } from './answer-validator.js';
import { logger } from '../../lib/logger.js';

const {
  Event, Registration, RegistrationAnswer, RegistrationQuestion,
  RegistrationStatusHistory, User, Country,
} = models;

const OCCUPYING = Registration.OCCUPYING;

/**
 * Registration, including the part that has to be right: two people must never
 * both take the last seat.
 */

async function recordStatus(registration, from, to, { reason = null, actorId = null, transaction }) {
  return RegistrationStatusHistory.create({
    registration_id: registration.id,
    from_status: from,
    to_status: to,
    reason,
    changed_by: actorId,
  }, { transaction });
}

/**
 * Counts seats inside the caller's transaction, after the event row is locked.
 * A pending registration only occupies a seat while its hold is live.
 */
async function takenSeats(eventId, attendanceMode, transaction) {
  const [row] = await sequelize.query(
    `SELECT COUNT(*) AS taken
       FROM registrations
      WHERE event_id = :eventId
        AND attendance_mode = :mode
        AND deleted_at IS NULL
        AND status IN (:statuses)
        AND (status <> 'PENDING_PAYMENT' OR hold_expires_at > NOW(3))`,
    {
      replacements: { eventId, mode: attendanceMode, statuses: OCCUPYING },
      type: QueryTypes.SELECT,
      transaction,
    },
  );
  return Number(row.taken);
}

function holdExpiry(event) {
  const hours = event.payment_hold_hours;
  if (hours) return new Date(Date.now() + hours * 3600_000);
  return new Date(Date.now() + env.REGISTRATION_HOLD_MINUTES * 60_000);
}

function snapshotOf(user) {
  return {
    prefix: user.prefix,
    firstName: user.first_name,
    middleName: user.middle_name,
    lastName: user.last_name,
    suffix: user.suffix,
    email: user.email,
    phone: user.phone,
    gender: user.gender,
    organization: user.organization,
    jobTitle: user.job_title,
    positionId: user.position_id ? String(user.position_id) : null,
    sectorId: user.sector_id ? String(user.sector_id) : null,
    city: user.city,
    stateProvince: user.state_province,
    countryCode: user.country_code,
  };
}

/**
 * Creates a registration.
 *
 * The event row is locked FOR UPDATE before capacity is counted, so two
 * concurrent requests serialise here rather than both reading "one seat left".
 * The seat is then held — a paid registration is not confirmed until the money
 * actually arrives, but nobody else can take the place in the meantime.
 */
export async function register({
  eventId,
  user,
  attendanceMode = 'IN_PERSON',
  answers = {},
  comments = null,
  specialRequirements = null,
  wantsCertificate = null,
  isPreviousAttendee = null,
  mediaConsent = false,
  evidenceFileId = null,
  preferredCurrency = null,
}, { context = {} } = {}) {
  const result = await sequelize.transaction(async (transaction) => {
    // Lock first. Everything after this is serialised per event.
    const event = await Event.findByPk(eventId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!event) throw new NotFoundError('Event');

    if (event.status === 'CANCELLED') {
      throw new ConflictError('This event has been cancelled.', 'EVENT_CANCELLED');
    }
    if (!event.isOpenForRegistration()) {
      throw new ConflictError('Registration for this event is not open.', 'REGISTRATION_CLOSED');
    }
    if (attendanceMode === 'VIRTUAL' && event.delivery_mode === 'OFFLINE') {
      throw new ConflictError('This event is in person only.', 'MODE_UNAVAILABLE');
    }
    if (attendanceMode === 'IN_PERSON' && event.delivery_mode === 'ONLINE') {
      throw new ConflictError('This event is online only.', 'MODE_UNAVAILABLE');
    }

    // One registration per person per event, enforced by a unique index as
    // well. A cancelled registration is reactivated rather than duplicated,
    // because MySQL cannot express a partial unique index.
    const existing = await Registration.findOne({
      where: { event_id: eventId, user_id: user.id },
      transaction,
      paranoid: false,
    });

    if (existing && OCCUPYING.includes(existing.status) && !existing.holdHasLapsed()) {
      throw new ConflictError(
        'You are already registered for this event.',
        'ALREADY_REGISTERED',
        { reference: existing.reference, status: existing.status },
      );
    }

    const questions = await RegistrationQuestion.findAll({
      where: { event_id: eventId },
      order: [['sort_order', 'ASC']],
      transaction,
    });
    const answerRows = validateAnswers(questions, answers);

    const country = user.country_code
      ? await Country.findByPk(user.country_code, { transaction })
      : null;

    const price = await resolvePrice({
      eventId,
      attendanceMode,
      participantCountry: user.country_code,
      participantRegion: country?.region ?? null,
      eventCountry: event.country_code,
      preferredCurrency,
      countryDefaultCurrency: country?.default_currency ?? null,
      transaction,
    });

    const capacity = event.capacityFor(attendanceMode);
    let status = 'PENDING_PAYMENT';
    let waitlisted = false;

    if (capacity !== null && capacity !== undefined) {
      const taken = await takenSeats(eventId, attendanceMode, transaction);
      // The reactivating registration is not currently occupying a seat, so
      // it is not double-counted here.
      if (taken >= capacity) {
        if (!event.allow_waitlist) {
          throw new ConflictError(
            'This event is fully booked.',
            'EVENT_FULL',
            { capacity, attendanceMode },
          );
        }
        status = 'WAITLISTED';
        waitlisted = true;
      }
    }

    // A free registration is confirmed immediately; there is nothing to wait for.
    const isFree = price.amountMinor === 0;
    if (isFree && !waitlisted) status = 'CONFIRMED';

    const payload = {
      event_id: eventId,
      user_id: user.id,
      status,
      attendance_mode: attendanceMode,
      hold_expires_at: status === 'PENDING_PAYMENT' ? holdExpiry(event) : null,
      price_amount_minor: price.amountMinor,
      currency: price.currency,
      price_tier: price.tier,
      profile_snapshot: snapshotOf(user),
      comments,
      special_requirements: specialRequirements,
      wants_certificate: wantsCertificate,
      is_previous_attendee: isPreviousAttendee,
      media_consent_at: mediaConsent ? new Date() : null,
      media_consent_ip: mediaConsent ? (context.ip ?? null) : null,
      evidence_file_id: evidenceFileId,
      confirmed_at: status === 'CONFIRMED' ? new Date() : null,
      cancelled_at: null,
      cancellation_reason: null,
    };

    let registration;
    let previousStatus = null;

    if (existing) {
      previousStatus = existing.status;
      if (existing.deleted_at) await existing.restore({ transaction });
      await existing.update(payload, { transaction });
      registration = existing;
      await RegistrationAnswer.destroy({ where: { registration_id: existing.id }, transaction });
    } else {
      registration = await Registration.create({
        ...payload,
        reference: registrationReference(event.event_type_id === 1 ? 'CPD' : 'EVT'),
        qr_token: randomHex(32),
      }, { transaction });
    }

    if (answerRows.length) {
      await RegistrationAnswer.bulkCreate(
        answerRows.map((a) => ({ ...a, registration_id: registration.id })),
        { transaction },
      );
    }

    await recordStatus(registration, previousStatus, status, {
      reason: waitlisted ? 'Event at capacity' : null,
      actorId: user.id,
      transaction,
    });

    // Written inside the transaction: no email for a registration that rolls back.
    await notify({
      userId: user.id,
      channel: 'EMAIL',
      template: waitlisted ? 'registration_waitlisted'
        : isFree ? 'registration_confirmed' : 'registration_pending_payment',
      toAddress: user.email,
      subject: waitlisted
        ? `Waitlisted: ${event.title}`
        : isFree ? `You're registered: ${event.title}` : `Complete your registration: ${event.title}`,
      payload: {
        firstName: user.first_name,
        eventTitle: event.title,
        reference: registration.reference,
        attendanceMode,
        amount: price.money,
        holdExpiresAt: registration.hold_expires_at,
        paymentUrl: isFree ? null : `${env.WEB_URL}/registrations/${registration.reference}/pay`,
      },
      resourceType: 'registration',
      resourceId: String(registration.id),
    }, { transaction });

    await audit({
      actor: { id: user.id, email: user.email },
      action: 'registration.created',
      resourceType: 'registration',
      resourceId: registration.id,
      after: { eventId, status, attendanceMode, amountMinor: price.amountMinor, currency: price.currency },
      context,
    }, { transaction });

    return { registration, event, price, status };
  });

  logger.info({
    registrationId: result.registration.id,
    eventId,
    userId: user.id,
    status: result.status,
  }, 'registration created');

  return result;
}

export async function cancel(registrationId, { actor, reason = null, context = {} }) {
  const registration = await Registration.findByPk(registrationId);
  if (!registration) throw new NotFoundError('Registration');

  if (['CANCELLED', 'REFUNDED'].includes(registration.status)) {
    throw new ConflictError('This registration is already cancelled.', 'ALREADY_CANCELLED');
  }

  const from = registration.status;

  await sequelize.transaction(async (transaction) => {
    await registration.update({
      status: 'CANCELLED',
      cancelled_at: new Date(),
      cancellation_reason: reason,
      hold_expires_at: null,
    }, { transaction });

    await recordStatus(registration, from, 'CANCELLED', { reason, actorId: actor?.id, transaction });

    await audit({
      actor,
      action: 'registration.cancelled',
      resourceType: 'registration',
      resourceId: registrationId,
      before: { status: from },
      after: { status: 'CANCELLED' },
      metadata: { reason },
      context,
    }, { transaction });
  });

  // A cancellation frees a seat; the first person waiting gets it.
  await promoteFromWaitlist(registration.event_id, registration.attendance_mode);

  return registration;
}

/**
 * Moves waitlisted people into a freed seat, oldest first. Runs after any
 * cancellation or expiry rather than on a timer, so the offer goes out while
 * the participant still cares.
 */
export async function promoteFromWaitlist(eventId, attendanceMode) {
  return sequelize.transaction(async (transaction) => {
    const event = await Event.findByPk(eventId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!event) return 0;

    const capacity = event.capacityFor(attendanceMode);
    if (capacity === null || capacity === undefined) return 0;

    const taken = await takenSeats(eventId, attendanceMode, transaction);
    const free = capacity - taken;
    if (free <= 0) return 0;

    const waiting = await Registration.findAll({
      where: { event_id: eventId, attendance_mode: attendanceMode, status: 'WAITLISTED' },
      order: [['created_at', 'ASC']],
      limit: free,
      include: [{ model: User, as: 'user', attributes: ['id', 'email', 'first_name'] }],
      transaction,
    });

    for (const registration of waiting) {
      const isFree = Number(registration.price_amount_minor) === 0;
      const status = isFree ? 'CONFIRMED' : 'PENDING_PAYMENT';

      // eslint-disable-next-line no-await-in-loop
      await registration.update({
        status,
        hold_expires_at: status === 'PENDING_PAYMENT' ? holdExpiry(event) : null,
        confirmed_at: isFree ? new Date() : null,
      }, { transaction });

      // eslint-disable-next-line no-await-in-loop
      await recordStatus(registration, 'WAITLISTED', status, {
        reason: 'Promoted from waitlist', transaction,
      });

      // eslint-disable-next-line no-await-in-loop
      await notify({
        userId: registration.user_id,
        channel: 'EMAIL',
        template: 'waitlist_promoted',
        toAddress: registration.user?.email,
        subject: `A place has opened up: ${event.title}`,
        payload: {
          firstName: registration.user?.first_name,
          eventTitle: event.title,
          reference: registration.reference,
          holdExpiresAt: registration.hold_expires_at,
          paymentUrl: isFree ? null : `${env.WEB_URL}/registrations/${registration.reference}/pay`,
        },
        resourceType: 'registration',
        resourceId: String(registration.id),
      }, { transaction });
    }

    if (waiting.length) {
      logger.info({ eventId, attendanceMode, promoted: waiting.length }, 'promoted from waitlist');
    }
    return waiting.length;
  });
}

/**
 * Releases holds that were never paid. Run on a schedule.
 *
 * The registration is not deleted — it becomes CANCELLED with a reason, so a
 * participant who returns can see what happened rather than finding nothing.
 */
export async function sweepExpiredHolds({ now = new Date() } = {}) {
  const expired = await Registration.findAll({
    where: {
      status: 'PENDING_PAYMENT',
      hold_expires_at: { [Op.lt]: now },
    },
    include: [{ model: User, as: 'user', attributes: ['id', 'email', 'first_name'] }],
    limit: 500,
  });

  if (!expired.length) return { released: 0 };

  const affected = new Map();

  for (const registration of expired) {
    // eslint-disable-next-line no-await-in-loop
    await sequelize.transaction(async (transaction) => {
      await registration.update({
        status: 'CANCELLED',
        cancelled_at: now,
        cancellation_reason: 'Payment was not completed before the deadline',
        hold_expires_at: null,
      }, { transaction });

      await recordStatus(registration, 'PENDING_PAYMENT', 'CANCELLED', {
        reason: 'Hold expired', transaction,
      });

      await notify({
        userId: registration.user_id,
        channel: 'EMAIL',
        template: 'registration_expired',
        toAddress: registration.user?.email,
        subject: 'Your registration has expired',
        payload: {
          firstName: registration.user?.first_name,
          reference: registration.reference,
        },
        resourceType: 'registration',
        resourceId: String(registration.id),
      }, { transaction });
    });

    affected.set(`${registration.event_id}:${registration.attendance_mode}`, {
      eventId: registration.event_id,
      mode: registration.attendance_mode,
    });
  }

  for (const { eventId, mode } of affected.values()) {
    // eslint-disable-next-line no-await-in-loop
    await promoteFromWaitlist(eventId, mode);
  }

  logger.info({ released: expired.length }, 'expired registration holds released');
  return { released: expired.length };
}

export async function findForUser(userId, { status = null } = {}) {
  const where = { user_id: userId };
  if (status) where.status = status;

  return Registration.findAll({
    where,
    include: [{ model: Event, as: 'event' }],
    order: [['created_at', 'DESC']],
  });
}

export async function findByReference(reference, { withQr = false } = {}) {
  const scope = withQr ? Registration.scope('withQr') : Registration;
  const registration = await scope.findOne({
    where: { reference },
    include: [
      { model: Event, as: 'event' },
      { model: RegistrationAnswer, as: 'answers', include: [{ model: RegistrationQuestion, as: 'question' }] },
    ],
  });
  if (!registration) throw new NotFoundError('Registration');
  return registration;
}

export default {
  register, cancel, promoteFromWaitlist, sweepExpiredHolds,
  findForUser, findByReference,
};
