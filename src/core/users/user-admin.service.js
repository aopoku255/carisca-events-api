import { models, sequelize } from '../../database/models/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { hashPassword } from '../auth/auth.service.js';
import { revokeAllForUser } from '../auth/token.service.js';
import { invalidateUser } from '../rbac/rbac.service.js';
import { record as audit } from '../audit/audit.service.js';
import { serialiseUser } from './user.serialiser.js';
import { sendMail } from '../notifications/channels/mail.js';
import { render } from '../notifications/templates/index.js';
import { logger } from '../../lib/logger.js';

const { User, Role, Department } = models;

/**
 * Administrative user management — the counterpart to user.routes.js, which
 * can only ever act on the caller's own record.
 *
 * Everything here is audited, because these are the operations that change who
 * can do what. The audit entry is written inside the same transaction as the
 * change for role and status edits: an unexplained privilege change is worse
 * than a failed one.
 */

const WITH_REFS = [
  { model: Role, as: 'roles', through: { attributes: [] } },
  { model: Department, as: 'department' },
];

/** Profile columns an administrator may set, mapped to their database names. */
const COLUMN = {
  prefix: 'prefix',
  firstName: 'first_name',
  middleName: 'middle_name',
  lastName: 'last_name',
  suffix: 'suffix',
  phone: 'phone',
  organization: 'organization',
  jobTitle: 'job_title',
  countryCode: 'country_code',
  city: 'city',
  stateProvince: 'state_province',
  timezone: 'timezone',
};

export async function findUser(id) {
  const user = await User.findByPk(id, { include: WITH_REFS });
  if (!user) throw new NotFoundError('User');
  return user;
}

/** Resolves role keys to rows, refusing the whole set if any key is unknown. */
async function resolveRoles(roleKeys, transaction = null) {
  if (!roleKeys?.length) return [];

  const roles = await Role.findAll({ where: { key: roleKeys }, transaction });
  const found = new Set(roles.map((r) => r.key));
  const missing = roleKeys.filter((k) => !found.has(k));

  if (missing.length) {
    throw new ValidationError([{ field: 'roleKeys', message: `Unknown role: ${missing.join(', ')}.` }]);
  }
  return roles;
}

async function resolveDepartment(departmentId, transaction = null) {
  if (!departmentId) return null;
  const department = await Department.findByPk(departmentId, { transaction });
  if (!department) {
    throw new ValidationError([{ field: 'departmentId', message: 'Unknown department.' }]);
  }
  return department;
}

/**
 * Creates an account on an administrator's behalf.
 *
 * The initial password is set here rather than emailed as an invitation link:
 * there is no set-password page in either frontend yet, so an invite-by-link
 * would send people to a 404. Instead the password the admin typed is emailed
 * directly to the new account — not through notify()'s queue, which persists
 * its payload in the notifications table indefinitely. A password has no
 * business sitting in a database column once it has been delivered, so this
 * sends it straight through the mail channel and keeps no record of the value
 * anywhere but the (already-hashed) users table and the outbound message
 * itself.
 *
 * Email delivery failing must never fail the account creation it is
 * reporting on — the admin still has the password they just typed and can
 * pass it on directly, exactly as before this existed. The caller is told
 * whether it actually sent, so the confirmation screen can say which.
 */
export async function createUser(input, { actor, context = {} } = {}) {
  const email = String(input.email).trim().toLowerCase();

  // paranoid: false — a soft-deleted account still holds the unique index, so
  // reporting "already exists" is the truth even though it is invisible.
  const existing = await User.findOne({ where: { email }, paranoid: false });
  if (existing) {
    throw new ConflictError('An account with this email address already exists.', 'EMAIL_TAKEN');
  }

  await resolveDepartment(input.departmentId);
  const roles = await resolveRoles(input.roleKeys);

  // Staff is what admits someone to the console at all. Anyone given a role
  // beyond participant needs it, so it is inferred rather than left to be
  // forgotten — an explicit isStaff still wins.
  const isStaff = input.isStaff ?? roles.some((r) => r.key !== 'participant');

  const user = await sequelize.transaction(async (transaction) => {
    const created = await User.create({
      email,
      password_hash: await hashPassword(input.password),
      first_name: input.firstName,
      last_name: input.lastName,
      middle_name: input.middleName || null,
      prefix: input.prefix || null,
      suffix: input.suffix || null,
      phone: input.phone || null,
      country_code: input.countryCode || null,
      organization: input.organization || null,
      job_title: input.jobTitle || null,
      timezone: input.timezone || null,
      department_id: input.departmentId || null,
      status: input.status || 'ACTIVE',
      is_staff: isStaff,
      // An administrator creating the account is the verification. Leaving it
      // null would put a "please confirm your email" state on an account
      // nobody is going to confirm.
      email_verified_at: new Date(),
    }, { transaction });

    if (roles.length) await created.setRoles(roles, { transaction });

    await audit({
      actor,
      action: 'user.created',
      resourceType: 'user',
      resourceId: created.id,
      after: { email, isStaff, status: created.status, roles: roles.map((r) => r.key) },
      context,
    }, { transaction });

    return created;
  });

  logger.info({ userId: user.id, actorId: actor?.id }, 'user created by administrator');

  let welcomeEmailSent = false;
  try {
    const { subject, html, text } = render('account_created', {
      firstName: user.first_name,
      email: user.email,
      password: input.password,
      isStaff,
    });
    await sendMail({ to: user.email, subject, html, text });
    welcomeEmailSent = true;
  } catch (err) {
    // Never lets a bounced or misconfigured mailbox undo an account that
    // otherwise created cleanly — the admin already has the password.
    logger.error({ err: err.message, userId: user.id }, 'welcome email failed to send');
  }

  await user.reload({ include: WITH_REFS });
  return { user, welcomeEmailSent };
}

/**
 * Updates profile, department, staff flag and status.
 *
 * Losing staff access or being deactivated has to take effect now rather than
 * whenever the current access token happens to expire, so both bump the token
 * version and revoke outstanding sessions.
 */
export async function updateUser(id, input, { actor, context = {} } = {}) {
  const user = await findUser(id);
  const before = serialiseUser(user);

  if (String(user.id) === String(actor?.id)) {
    if (input.status !== undefined && input.status !== user.status) {
      throw new ValidationError([{ field: 'status', message: 'You cannot change your own account status.' }]);
    }
    if (input.isStaff === false) {
      throw new ValidationError([{ field: 'isStaff', message: 'You cannot remove your own staff access.' }]);
    }
  }

  const patch = {};
  for (const [field, column] of Object.entries(COLUMN)) {
    if (input[field] !== undefined) patch[column] = input[field] || null;
  }

  if (input.departmentId !== undefined) {
    await resolveDepartment(input.departmentId);
    patch.department_id = input.departmentId || null;
  }
  if (input.isStaff !== undefined) patch.is_staff = input.isStaff;
  if (input.status !== undefined) patch.status = input.status;

  const losesAccess = (input.status !== undefined && input.status !== 'ACTIVE' && user.status === 'ACTIVE')
    || (input.isStaff === false && user.is_staff);

  if (losesAccess) patch.token_version = user.token_version + 1;

  await user.update(patch);
  await user.reload({ include: WITH_REFS });

  if (losesAccess) {
    await revokeAllForUser(user.id, 'ADMIN_ACTION');
    await invalidateUser(user.id);
  }

  await audit({
    actor,
    action: 'user.updated',
    resourceType: 'user',
    resourceId: user.id,
    before,
    after: serialiseUser(user),
    metadata: losesAccess ? { sessionsRevoked: true } : null,
    context,
  });

  return user;
}

/**
 * Replaces a user's roles wholesale, matching how the admin UI edits them.
 *
 * Editing your own roles is refused outright. It is the one change that can
 * lock the last administrator out of the console, and a second administrator
 * making it is a cheap safeguard against a slip.
 */
export async function setUserRoles(id, roleKeys, { actor, context = {} } = {}) {
  const user = await findUser(id);

  if (String(user.id) === String(actor?.id)) {
    throw new ValidationError([{ field: 'roleKeys', message: 'You cannot change your own roles. Ask another administrator.' }]);
  }

  const before = user.roles.map((r) => r.key).sort();
  const roles = await resolveRoles(roleKeys);
  const after = roles.map((r) => r.key).sort();

  await sequelize.transaction(async (transaction) => {
    await user.setRoles(roles, { transaction });

    await audit({
      actor,
      action: 'user.roles_changed',
      resourceType: 'user',
      resourceId: user.id,
      before: { roles: before },
      after: { roles: after },
      context,
    }, { transaction });
  });

  // The permission cache is keyed by user and would otherwise serve the old
  // set until it expired on its own.
  await invalidateUser(user.id);

  await user.reload({ include: WITH_REFS });
  logger.info({ userId: user.id, actorId: actor?.id, roles: after }, 'user roles changed');

  return user;
}

/**
 * Sets a new password on someone else's account, for the case where a person
 * cannot receive email. Every session is destroyed, exactly as a self-service
 * reset does — an administrator handing out a new password must not leave the
 * old sessions alive.
 */
export async function resetUserPassword(id, password, { actor, context = {} } = {}) {
  const user = await findUser(id);

  user.password_hash = await hashPassword(password);
  user.token_version += 1;
  await user.save();

  await revokeAllForUser(user.id, 'ADMIN_PASSWORD_RESET');
  await invalidateUser(user.id);

  await audit({
    actor,
    action: 'user.password_reset_by_admin',
    resourceType: 'user',
    resourceId: user.id,
    metadata: { email: user.email },
    context,
  });

  logger.info({ userId: user.id, actorId: actor?.id }, 'password reset by administrator');
  return user;
}

export default {
  findUser, createUser, updateUser, setUserRoles, resetUserPassword,
};
