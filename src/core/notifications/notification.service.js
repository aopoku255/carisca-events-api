import { models } from '../../database/models/index.js';

const { Notification } = models;

/**
 * The outbox. Callers write a notification row inside whatever transaction
 * caused it; a worker dispatches it afterwards.
 *
 * Nothing here talks to an email provider. That is the whole point: a mail
 * outage delays delivery, it never fails a registration, and a rolled-back
 * transaction cannot leave a stray email behind.
 */
export async function notify({
  userId = null,
  channel = 'EMAIL',
  template,
  subject = null,
  toAddress = null,
  payload = null,
  resourceType = null,
  resourceId = null,
}, { transaction = null } = {}) {
  if (!template) throw new Error('notify() requires a template');

  return Notification.create({
    user_id: userId,
    channel,
    template,
    subject,
    to_address: toAddress,
    payload,
    status: 'PENDING',
    next_attempt_at: new Date(),
    resource_type: resourceType,
    resource_id: resourceId,
  }, { transaction });
}

/** Queue an in-app notification alongside an email. */
export async function notifyInApp(args, options = {}) {
  return notify({ ...args, channel: 'IN_APP' }, options);
}

export async function markRead(notificationId, userId) {
  const [count] = await Notification.update(
    { read_at: new Date() },
    { where: { id: notificationId, user_id: userId, read_at: null } },
  );
  return count > 0;
}

export async function markAllRead(userId) {
  const [count] = await Notification.update(
    { read_at: new Date() },
    { where: { user_id: userId, channel: 'IN_APP', read_at: null } },
  );
  return count;
}

export default { notify, notifyInApp, markRead, markAllRead };
