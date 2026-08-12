import { Op, QueryTypes } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import { AppError, NotFoundError, ConflictError } from '../../lib/errors.js';
import { record as audit } from '../audit/audit.service.js';
import { logger } from '../../lib/logger.js';

const { Registration, AttendanceRecord, EventSession, Event, User } = models;

/**
 * Attendance.
 *
 * Written for a door, not a desk: poor light, a queue, a member of staff
 * scanning as fast as people arrive. Everything here is idempotent, because
 * the same badge will be scanned twice and a flaky connection will replay the
 * same request.
 */

/**
 * Finds a registration from whatever the scanner has: a QR token, the printed
 * reference, or an id typed in by hand.
 */
export async function resolveRegistration({ qrToken, reference, registrationId }, { transaction = null } = {}) {
  const where = qrToken ? { qr_token: qrToken }
    : reference ? { reference: String(reference).trim().toUpperCase() }
      : registrationId ? { id: registrationId }
        : null;

  if (!where) {
    throw new AppError('Provide a QR code, a reference or a registration.', {
      status: 422, code: 'NO_IDENTIFIER',
    });
  }

  const registration = await Registration.scope('withQr').findOne({
    where,
    include: [
      { model: Event, as: 'event' },
      { model: User, as: 'user', attributes: ['id', 'first_name', 'last_name', 'email', 'organization'] },
    ],
    transaction,
  });

  if (!registration) {
    throw new NotFoundError('Registration');
  }
  return registration;
}

/** Whether this person may be admitted, and why not if they may not. */
export function admissionCheck(registration) {
  const blockers = [];

  if (registration.status === 'CANCELLED') blockers.push('This registration was cancelled.');
  if (registration.status === 'REFUNDED') blockers.push('This registration was refunded.');
  if (registration.status === 'WAITLISTED') blockers.push('This person is on the waitlist, not registered.');

  // Deliberately NOT a blocker: someone who has not paid is still let in and
  // flagged. Turning a real attendee away at the door over a payment the desk
  // can settle afterwards is the wrong trade — the certificate is where
  // payment is enforced.
  const warnings = [];
  if (registration.status === 'PENDING_PAYMENT') {
    warnings.push('Payment is outstanding — admit and refer to the desk.');
  }
  if (registration.attendance_mode === 'VIRTUAL') {
    warnings.push('This person registered to attend online.');
  }

  return { admissible: blockers.length === 0, blockers, warnings };
}

/**
 * Checks someone in.
 *
 * Scanning an already-checked-in badge is not an error — the scanner shows
 * "already in, at 09:14" so staff can wave them through. Only a genuinely
 * different session creates a second row.
 */
export async function checkIn({
  qrToken, reference, registrationId, sessionId = null,
  method = 'QR', deviceInfo = null, notes = null, actor = null, context = {},
}) {
  const result = await sequelize.transaction(async (transaction) => {
    const registration = await resolveRegistration(
      { qrToken, reference, registrationId }, { transaction },
    );

    const check = admissionCheck(registration);
    if (!check.admissible) {
      throw new ConflictError(check.blockers[0], 'NOT_ADMISSIBLE', {
        reference: registration.reference,
        status: registration.status,
        blockers: check.blockers,
      });
    }

    if (sessionId) {
      const session = await EventSession.findOne({
        where: { id: sessionId, event_id: registration.event_id },
        transaction,
      });
      if (!session) {
        throw new AppError('That session does not belong to this event.', {
          status: 422, code: 'SESSION_MISMATCH',
        });
      }
    }

    const now = new Date();
    const [record, created] = await AttendanceRecord.findOrCreate({
      where: { registration_id: registration.id, session_id: sessionId },
      defaults: {
        registration_id: registration.id,
        session_id: sessionId,
        status: 'CHECKED_IN',
        check_in_at: now,
        method,
        recorded_by: actor?.id ?? null,
        device_info: deviceInfo,
        notes,
      },
      transaction,
    });

    if (created) {
      await audit({
        actor,
        action: 'attendance.checked_in',
        resourceType: 'registration',
        resourceId: registration.id,
        after: { sessionId, method, at: now },
        context,
      }, { transaction });
    }

    return { registration, record, created, warnings: check.warnings };
  });

  if (result.created) {
    logger.info({
      registrationId: result.registration.id,
      sessionId,
      method,
      actorId: actor?.id,
    }, 'attendance recorded');
  }

  return result;
}

/** Records a departure. Only meaningful where check-out is being tracked. */
export async function checkOut({
  qrToken, reference, registrationId, sessionId = null,
  actor = null, context = {},
}) {
  return sequelize.transaction(async (transaction) => {
    const registration = await resolveRegistration(
      { qrToken, reference, registrationId }, { transaction },
    );

    const record = await AttendanceRecord.findOne({
      where: { registration_id: registration.id, session_id: sessionId },
      transaction,
    });

    if (!record) {
      throw new ConflictError(
        'This person has not been checked in yet.',
        'NOT_CHECKED_IN',
        { reference: registration.reference },
      );
    }

    // Read before writing: after the update the column is always set, so
    // deriving this afterwards would report every first check-out as a repeat
    // and make staff think they had double-scanned.
    const alreadyOut = !!record.check_out_at;

    // Re-scanning on the way out keeps the first departure time rather than
    // overwriting it with a later, accidental scan.
    if (!alreadyOut) {
      await record.update({ check_out_at: new Date(), status: 'ATTENDED' }, { transaction });
      await audit({
        actor,
        action: 'attendance.checked_out',
        resourceType: 'registration',
        resourceId: registration.id,
        after: { sessionId, at: record.check_out_at },
        context,
      }, { transaction });
    }

    return { registration, record, alreadyOut };
  });
}

/**
 * Marks everyone who never turned up as absent, once the event is over.
 * Idempotent, so running it twice changes nothing.
 */
export async function finaliseAttendance(eventId, { actor = null, context = {} } = {}) {
  const confirmed = await Registration.findAll({
    where: { event_id: eventId, status: 'CONFIRMED' },
    include: [{ model: AttendanceRecord, as: 'attendance' }],
  });

  const absentees = confirmed.filter((r) => (r.attendance ?? []).length === 0);

  if (absentees.length) {
    await AttendanceRecord.bulkCreate(
      absentees.map((r) => ({
        registration_id: r.id,
        session_id: null,
        status: 'ABSENT',
        method: 'MANUAL',
        recorded_by: actor?.id ?? null,
        notes: 'Marked absent when attendance was finalised',
      })),
      { ignoreDuplicates: true },
    );

    await audit({
      actor,
      action: 'attendance.finalised',
      resourceType: 'event',
      resourceId: eventId,
      metadata: { markedAbsent: absentees.length, present: confirmed.length - absentees.length },
      context,
    });
  }

  return { markedAbsent: absentees.length, present: confirmed.length - absentees.length };
}

/**
 * How much of the event a person actually attended.
 *
 * Only sessions flagged `is_required_for_attendance` count toward the
 * denominator, so an optional social evening cannot drag someone below the
 * threshold for their certificate.
 */
export async function attendanceRate(registrationId) {
  const registration = await Registration.findByPk(registrationId, {
    include: [{ model: Event, as: 'event' }],
  });
  if (!registration) throw new NotFoundError('Registration');

  const requiredSessions = await EventSession.count({
    where: { event_id: registration.event_id, is_required_for_attendance: true },
  });

  const records = await AttendanceRecord.findAll({
    where: { registration_id: registrationId },
  });

  const present = records.filter((r) => ['CHECKED_IN', 'ATTENDED'].includes(r.status));
  const checkedInAtAll = present.length > 0;

  // No sessions configured: attendance is simply whether they turned up.
  if (requiredSessions === 0) {
    return {
      requiredSessions: 0,
      attendedSessions: present.length,
      percent: checkedInAtAll ? 100 : 0,
      checkedIn: checkedInAtAll,
    };
  }

  const attendedRequired = present.filter((r) => r.session_id !== null).length;
  const percent = Math.round((attendedRequired / requiredSessions) * 100);

  return {
    requiredSessions,
    attendedSessions: attendedRequired,
    percent: Math.min(100, percent),
    checkedIn: checkedInAtAll,
  };
}

/** The door list: everyone expected, with their current attendance state. */
export async function rosterFor(eventId, { q = null, status = null, limit = 500 } = {}) {
  const replacements = { eventId, limit: Number(limit) };
  let filter = '';

  if (q) {
    filter += ` AND (u.first_name LIKE :q OR u.last_name LIKE :q OR u.email LIKE :q
                     OR r.reference LIKE :q OR u.organization LIKE :q)`;
    replacements.q = `%${q}%`;
  }
  if (status === 'checked_in') filter += ' AND a.id IS NOT NULL';
  if (status === 'not_arrived') filter += ' AND a.id IS NULL';

  return sequelize.query(
    `SELECT r.id, r.reference, r.status, r.attendance_mode,
            u.first_name, u.last_name, u.email, u.organization,
            a.id AS attendance_id, a.check_in_at, a.check_out_at, a.status AS attendance_status
       FROM registrations r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN attendance_records a
              ON a.registration_id = r.id AND a.session_id IS NULL
      WHERE r.event_id = :eventId
        AND r.deleted_at IS NULL
        AND r.status IN ('CONFIRMED', 'PENDING_PAYMENT', 'REQUIRES_REVIEW')
        ${filter}
      ORDER BY u.last_name ASC, u.first_name ASC
      LIMIT :limit`,
    { replacements, type: QueryTypes.SELECT },
  );
}

export async function summaryFor(eventId) {
  const [row] = await sequelize.query(
    `SELECT
        COUNT(DISTINCT r.id) AS expected,
        COUNT(DISTINCT CASE WHEN a.id IS NOT NULL THEN r.id END) AS arrived,
        COUNT(DISTINCT CASE WHEN a.check_out_at IS NOT NULL THEN r.id END) AS departed
       FROM registrations r
       LEFT JOIN attendance_records a
              ON a.registration_id = r.id AND a.session_id IS NULL
                 AND a.status IN ('CHECKED_IN','ATTENDED')
      WHERE r.event_id = :eventId
        AND r.deleted_at IS NULL
        AND r.status IN ('CONFIRMED','PENDING_PAYMENT','REQUIRES_REVIEW')`,
    { replacements: { eventId }, type: QueryTypes.SELECT },
  );

  const expected = Number(row.expected);
  const arrived = Number(row.arrived);

  return {
    expected,
    arrived,
    departed: Number(row.departed),
    notArrived: expected - arrived,
    arrivalRate: expected ? Math.round((arrived / expected) * 100) : 0,
  };
}

export default {
  resolveRegistration, admissionCheck, checkIn, checkOut,
  finaliseAttendance, attendanceRate, rosterFor, summaryFor,
};
