import { Op } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import { render } from '../../core/notifications/templates/index.js';
import { sendMail } from '../../core/notifications/channels/mail.js';
import { logger } from '../../lib/logger.js';

const { Notification } = models;

/**
 * Drains the notification outbox.
 *
 * Rows are claimed with SELECT ... FOR UPDATE SKIP LOCKED so several workers
 * can run without sending the same email twice. Failures back off
 * exponentially and give up after MAX_ATTEMPTS rather than retrying forever.
 */

const MAX_ATTEMPTS = 5;
const BATCH = 25;

/**
 * A row is only left in SENDING if a worker died mid-batch. After this long we
 * assume that happened and make it eligible again. Without this, a crash
 * strands notifications in a state nothing ever queries.
 */
const STALE_SENDING_MS = 10 * 60_000;

export async function reclaimStalled({ now = new Date() } = {}) {
  const [count] = await Notification.update(
    { status: 'PENDING' },
    {
      where: {
        status: 'SENDING',
        updated_at: { [Op.lt]: new Date(now.getTime() - STALE_SENDING_MS) },
      },
    },
  );
  if (count) logger.warn({ count }, 'reclaimed stalled notifications');
  return count;
}

/** 1m, 5m, 25m, 2h — long enough to outlast a short provider outage. */
function backoffMs(attempts) {
  return Math.min(60_000 * 5 ** (attempts - 1), 4 * 60 * 60_000);
}

async function claimBatch(limit) {
  return sequelize.transaction(async (transaction) => {
    const due = await Notification.findAll({
      where: {
        status: 'PENDING',
        channel: { [Op.ne]: 'IN_APP' }, // in-app notifications need no delivery
        [Op.or]: [
          { next_attempt_at: { [Op.lte]: new Date() } },
          { next_attempt_at: { [Op.is]: null } },
        ],
      },
      order: [['id', 'ASC']],
      limit,
      transaction,
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
    });

    if (due.length) {
      await Notification.update(
        { status: 'SENDING' },
        { where: { id: { [Op.in]: due.map((n) => n.id) } }, transaction },
      );
    }

    return due;
  });
}

async function deliver(notification) {
  const { subject, html, text } = render(notification.template, notification.payload || {});

  if (notification.channel === 'EMAIL') {
    if (!notification.to_address) throw new Error('No recipient address');
    await sendMail({
      to: notification.to_address,
      subject: notification.subject || subject,
      html,
      text,
    });
    return;
  }

  if (notification.channel === 'SMS') {
    throw new Error('SMS delivery is not configured yet');
  }

  throw new Error(`Unknown channel ${notification.channel}`);
}

export async function dispatchOnce({ limit = BATCH } = {}) {
  await reclaimStalled();
  const batch = await claimBatch(limit);
  if (!batch.length) return { sent: 0, failed: 0, processed: 0 };

  let sent = 0;
  let failed = 0;

  for (const notification of batch) {
    const attempts = notification.attempts + 1;

    /**
     * Written through the model class rather than the instance on purpose.
     * These instances were loaded before the claim flipped them to SENDING, so
     * their in-memory status is stale; `instance.update({ status: 'PENDING' })`
     * looks like a no-op to Sequelize's dirty tracking and silently omits the
     * column, stranding the row in SENDING where nothing ever picks it up.
     */
    const write = (fields) => Notification.update(fields, { where: { id: notification.id } });

    try {
      // eslint-disable-next-line no-await-in-loop
      await deliver(notification);
      // eslint-disable-next-line no-await-in-loop
      await write({
        status: 'SENT', sent_at: new Date(), attempts, last_error: null, next_attempt_at: null,
      });
      sent += 1;
    } catch (err) {
      const giveUp = attempts >= MAX_ATTEMPTS;
      // eslint-disable-next-line no-await-in-loop
      await write({
        status: giveUp ? 'FAILED' : 'PENDING',
        attempts,
        last_error: String(err.message).slice(0, 2000),
        next_attempt_at: giveUp ? null : new Date(Date.now() + backoffMs(attempts)),
      });
      failed += 1;

      logger[giveUp ? 'error' : 'warn']({
        notificationId: notification.id,
        template: notification.template,
        attempts,
        err: err.message,
      }, giveUp ? 'notification permanently failed' : 'notification delivery failed, will retry');
    }
  }

  return { sent, failed, processed: batch.length };
}

export default { dispatchOnce, reclaimStalled };
