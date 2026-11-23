import { Op } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { notify } from '../notifications/notification.service.js';
import { record as audit } from '../audit/audit.service.js';
import { logger } from '../../lib/logger.js';

const { Registration, Event, User } = models;

/** Past the point where one send should be a deliberate, smaller batch. */
export const MAX_RECIPIENTS = 2000;

// Everyone who holds or waits for a place. A cancelled or refunded registration
// is not someone the event still has anything to tell.
const DEFAULT_STATUSES = ['CONFIRMED', 'PENDING_PAYMENT', 'REQUIRES_REVIEW', 'WAITLISTED'];

async function resolveRecipients({ eventId, references, statuses, attendanceMode }) {
  const event = await Event.findByPk(eventId);
  if (!event) throw new NotFoundError('Event');

  const where = {
    event_id: eventId,
    status: { [Op.in]: statuses?.length ? statuses : DEFAULT_STATUSES },
  };
  if (attendanceMode) where.attendance_mode = attendanceMode;
  if (references?.length) where.reference = { [Op.in]: references };

  const registrations = await Registration.findAll({
    where,
    include: [{
      model: User, as: 'user', required: true, attributes: ['id', 'email', 'first_name', 'status'],
    }],
  });

  // A suspended or inactive account is not somewhere staff should be mailing.
  const recipients = registrations.filter((r) => r.user?.email && r.user.status === 'ACTIVE');
  return { event, recipients };
}

/** How many people a send with these filters would reach — nothing is queued. */
export async function countRecipients(filters) {
  const { recipients } = await resolveRecipients(filters);
  return recipients.length;
}

/**
 * Queues one email per registrant through the notification outbox, so a slow
 * or failing mail relay retries rather than losing messages, and a large
 * send drains in the background instead of holding the request open.
 */
export async function sendToRegistrants({
  eventId, references, statuses, attendanceMode, subject, message, actor, context = {},
}) {
  const { event, recipients } = await resolveRecipients({
    eventId, references, statuses, attendanceMode,
  });

  if (!recipients.length) {
    throw new ValidationError([{ field: 'recipients', message: 'No one matches, so nothing was sent.' }]);
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new ValidationError([{
      field: 'recipients',
      message: `That would email ${recipients.length} people; the limit for one send is ${MAX_RECIPIENTS}. Narrow it by status or attendance.`,
    }]);
  }

  await sequelize.transaction(async (transaction) => {
    for (const r of recipients) {
      // eslint-disable-next-line no-await-in-loop
      await notify({
        userId: r.user_id,
        channel: 'EMAIL',
        template: 'admin_message',
        toAddress: r.user.email,
        subject,
        payload: {
          firstName: r.user.first_name,
          eventTitle: event.title,
          bannerFileId: event.banner_file_id,
          reference: r.reference,
          subject,
          message,
        },
        resourceType: 'registration',
        resourceId: String(r.id),
      }, { transaction });
    }

    await audit({
      actor,
      action: 'registration.emailed',
      resourceType: 'event',
      resourceId: event.id,
      after: {
        recipients: recipients.length,
        subject,
        individual: !!references?.length && recipients.length === 1,
        statuses: statuses ?? null,
        attendanceMode: attendanceMode ?? null,
      },
      context,
    }, { transaction });
  });

  logger.info({ eventId, recipients: recipients.length, actorId: actor?.id }, 'participants emailed');
  return { queued: recipients.length };
}

export default { countRecipients, sendToRegistrants, MAX_RECIPIENTS };
