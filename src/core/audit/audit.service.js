import { models } from '../../database/models/index.js';
import { logger } from '../../lib/logger.js';

const { AuditLog } = models;

/**
 * Append-only record of administrative action. Writing a log entry must never
 * be the reason an operation fails, so failures here are logged loudly and
 * swallowed — except inside a transaction, where the caller has explicitly
 * chosen to tie the audit entry to the change it describes.
 */

const SENSITIVE_KEYS = new Set([
  'password', 'password_hash', 'token', 'token_hash', 'secret',
  'accessToken', 'refreshToken', 'qr_token', 'verification_code',
]);

/** Strips secrets from before/after snapshots before they reach the log. */
export function scrub(value) {
  if (!value || typeof value !== 'object') return value ?? null;
  if (Array.isArray(value)) return value.map(scrub);

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(k)) out[k] = '[redacted]';
    else if (v && typeof v === 'object') out[k] = scrub(v);
    else out[k] = v;
  }
  return out;
}

export async function record({
  actor = null,
  action,
  resourceType,
  resourceId = null,
  before = null,
  after = null,
  metadata = null,
  context = {},
}, { transaction = null } = {}) {
  const entry = {
    actor_user_id: actor?.id ?? null,
    actor_email: actor?.email ?? null,
    action,
    resource_type: resourceType,
    resource_id: resourceId === null ? null : String(resourceId),
    before: scrub(before),
    after: scrub(after),
    metadata: scrub(metadata),
    ip: context.ip ?? null,
    user_agent: context.userAgent ? String(context.userAgent).slice(0, 255) : null,
    request_id: context.requestId ?? null,
  };

  if (transaction) {
    // Deliberate: the caller wants the audit entry to live or die with the
    // change, so a failure here should roll the whole thing back.
    return AuditLog.create(entry, { transaction });
  }

  try {
    return await AuditLog.create(entry);
  } catch (err) {
    logger.error({ err: err.message, action, resourceType, resourceId }, 'audit write failed');
    return null;
  }
}

/** Convenience wrapper for Express handlers, which always carry a context. */
export function auditFrom(req) {
  return (args, options) => record({
    ...args,
    actor: req.user ? { id: req.user.id, email: req.user.email } : null,
    context: { ip: req.ip, userAgent: req.get?.('user-agent'), requestId: req.id },
  }, options);
}

export default { record, auditFrom, scrub };
