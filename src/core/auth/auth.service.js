import argon2 from 'argon2';
import { Op } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import env from '../../config/env.js';
import { sha256, randomToken } from '../../lib/ids.js';
import {
  AuthenticationError, ConflictError, NotFoundError, ValidationError,
} from '../../lib/errors.js';
import { revokeAllForUser, signAccessToken, issueRefreshToken } from './token.service.js';
import { invalidateUser } from '../rbac/rbac.service.js';
import { notify } from '../notifications/notification.service.js';
import { logger } from '../../lib/logger.js';

const { User, Role, UserToken } = models;

const ARGON_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB — OWASP's minimum recommendation for argon2id
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plain) {
  return argon2.hash(plain, ARGON_OPTIONS);
}

export function verifyPassword(hash, plain) {
  return argon2.verify(hash, plain).catch(() => false);
}

async function issueUserToken(userId, type, ttlMs, transaction) {
  const raw = randomToken(32);
  await UserToken.create({
    user_id: userId,
    type,
    token_hash: sha256(raw),
    expires_at: new Date(Date.now() + ttlMs),
  }, { transaction });
  return raw;
}

/**
 * Registers a public participant. The `participant` role is assigned so every
 * user has one, though it grants nothing — participants reach their own data
 * by ownership, not permission.
 */
export async function register(input, context = {}) {
  const email = String(input.email).trim().toLowerCase();

  const existing = await User.findOne({ where: { email }, paranoid: false });
  if (existing) {
    // Deliberately explicit. Enumeration is already possible through the
    // registration form, and a vague error here only frustrates real users.
    throw new ConflictError('An account with this email address already exists.', 'EMAIL_TAKEN');
  }

  const { user, verificationToken } = await sequelize.transaction(async (transaction) => {
    const created = await User.create({
      email,
      password_hash: await hashPassword(input.password),
      first_name: input.firstName,
      last_name: input.lastName,
      phone: input.phone || null,
      country_code: input.countryCode || null,
      organization: input.organization || null,
      job_title: input.jobTitle || null,
      timezone: input.timezone || null,
      status: 'ACTIVE',
      is_staff: false,
    }, { transaction });

    const participantRole = await Role.findOne({ where: { key: 'participant' }, transaction });
    if (participantRole) {
      await created.addRole(participantRole, { transaction });
    }

    const token = await issueUserToken(
      created.id,
      'EMAIL_VERIFICATION',
      env.EMAIL_VERIFICATION_TTL_HOURS * 3600_000,
      transaction,
    );

    // Written inside the transaction: a rolled-back registration cannot send
    // a welcome email, and a crash after commit cannot lose it.
    await notify({
      userId: created.id,
      channel: 'EMAIL',
      template: 'email_verification',
      toAddress: created.email,
      subject: 'Confirm your CARISCA account',
      payload: {
        firstName: created.first_name,
        verifyUrl: `${env.WEB_URL}/verify-email?token=${token}`,
        expiresInHours: env.EMAIL_VERIFICATION_TTL_HOURS,
      },
      resourceType: 'user',
      resourceId: String(created.id),
    }, { transaction });

    return { user: created, verificationToken: token };
  });

  logger.info({ userId: user.id, ip: context.ip }, 'user registered');

  return {
    user,
    // Returned only outside production so the development flow does not depend
    // on a mail server being configured.
    verificationToken: env.isProduction ? undefined : verificationToken,
  };
}

export async function login({ email, password }, context = {}) {
  const user = await User.scope('withSecrets').findOne({
    where: { email: String(email).trim().toLowerCase() },
  });

  // Same error and comparable timing whether the account exists or not.
  if (!user) {
    await argon2.hash('timing-equalisation-placeholder', ARGON_OPTIONS).catch(() => {});
    throw new AuthenticationError('Incorrect email address or password.', 'INVALID_CREDENTIALS');
  }

  const valid = await verifyPassword(user.password_hash, password);
  if (!valid) {
    logger.warn({ userId: user.id, ip: context.ip }, 'failed login');
    throw new AuthenticationError('Incorrect email address or password.', 'INVALID_CREDENTIALS');
  }

  if (user.status === 'SUSPENDED') {
    throw new AuthenticationError('This account has been suspended. Contact CARISCA for assistance.', 'ACCOUNT_SUSPENDED');
  }
  if (user.status === 'INACTIVE') {
    throw new AuthenticationError('This account is not active.', 'ACCOUNT_INACTIVE');
  }

  user.last_login_at = new Date();
  await user.save();

  const { token: refreshToken } = await issueRefreshToken(user, {
    ip: context.ip,
    userAgent: context.userAgent,
  });

  logger.info({ userId: user.id, ip: context.ip }, 'user signed in');

  return {
    user: await User.findByPk(user.id, { include: [{ model: Role, as: 'roles' }] }),
    accessToken: signAccessToken(user),
    refreshToken,
  };
}

export async function verifyEmail(rawToken) {
  const record = await UserToken.findOne({
    where: { token_hash: sha256(rawToken), type: 'EMAIL_VERIFICATION' },
  });

  if (!record || !record.isUsable()) {
    throw new ValidationError(null, 'This verification link is invalid or has expired.');
  }

  await sequelize.transaction(async (transaction) => {
    record.consumed_at = new Date();
    await record.save({ transaction });
    await User.update(
      { email_verified_at: new Date() },
      { where: { id: record.user_id }, transaction },
    );
  });

  return User.findByPk(record.user_id);
}

export async function resendVerification(email) {
  const user = await User.findOne({ where: { email: String(email).trim().toLowerCase() } });
  // Always reports success: whether an address is registered is not something
  // an unauthenticated caller should be able to probe.
  if (!user || user.email_verified_at) return { sent: true };

  await sequelize.transaction(async (transaction) => {
    const token = await issueUserToken(
      user.id, 'EMAIL_VERIFICATION', env.EMAIL_VERIFICATION_TTL_HOURS * 3600_000, transaction,
    );
    await notify({
      userId: user.id,
      channel: 'EMAIL',
      template: 'email_verification',
      toAddress: user.email,
      subject: 'Confirm your CARISCA account',
      payload: {
        firstName: user.first_name,
        verifyUrl: `${env.WEB_URL}/verify-email?token=${token}`,
        expiresInHours: env.EMAIL_VERIFICATION_TTL_HOURS,
      },
      resourceType: 'user',
      resourceId: String(user.id),
    }, { transaction });
  });

  return { sent: true };
}

export async function requestPasswordReset(email) {
  const user = await User.findOne({ where: { email: String(email).trim().toLowerCase() } });
  if (!user) return { sent: true };

  await sequelize.transaction(async (transaction) => {
    // Any outstanding reset links are voided so only the newest one works.
    await UserToken.update(
      { consumed_at: new Date() },
      {
        where: { user_id: user.id, type: 'PASSWORD_RESET', consumed_at: { [Op.is]: null } },
        transaction,
      },
    );

    const token = await issueUserToken(
      user.id, 'PASSWORD_RESET', env.PASSWORD_RESET_TTL_MINUTES * 60_000, transaction,
    );

    await notify({
      userId: user.id,
      channel: 'EMAIL',
      template: 'password_reset',
      toAddress: user.email,
      subject: 'Reset your CARISCA password',
      payload: {
        firstName: user.first_name,
        resetUrl: `${env.WEB_URL}/reset-password?token=${token}`,
        expiresInMinutes: env.PASSWORD_RESET_TTL_MINUTES,
      },
      resourceType: 'user',
      resourceId: String(user.id),
    }, { transaction });
  });

  return { sent: true };
}

/**
 * Completes a password reset. Every existing session is destroyed and the
 * token version is bumped, so a stolen session cannot survive the reset that
 * was meant to lock the attacker out.
 */
export async function resetPassword(rawToken, newPassword) {
  const record = await UserToken.findOne({
    where: { token_hash: sha256(rawToken), type: 'PASSWORD_RESET' },
  });

  if (!record || !record.isUsable()) {
    throw new ValidationError(null, 'This reset link is invalid or has expired.');
  }

  const user = await User.findByPk(record.user_id);
  if (!user) throw new NotFoundError('Account');

  await sequelize.transaction(async (transaction) => {
    record.consumed_at = new Date();
    await record.save({ transaction });

    user.password_hash = await hashPassword(newPassword);
    user.token_version += 1;
    await user.save({ transaction });
  });

  await revokeAllForUser(user.id, 'PASSWORD_RESET');
  await invalidateUser(user.id);

  logger.info({ userId: user.id }, 'password reset completed');
  return { reset: true };
}

export async function changePassword(userId, currentPassword, newPassword) {
  const user = await User.scope('withSecrets').findByPk(userId);
  if (!user) throw new NotFoundError('Account');

  if (!(await verifyPassword(user.password_hash, currentPassword))) {
    throw new AuthenticationError('Your current password is incorrect.', 'INVALID_CREDENTIALS');
  }

  user.password_hash = await hashPassword(newPassword);
  user.token_version += 1;
  await user.save();

  await revokeAllForUser(user.id, 'PASSWORD_CHANGED');
  await invalidateUser(user.id);

  return { changed: true };
}

export default {
  register,
  login,
  verifyEmail,
  resendVerification,
  requestPasswordReset,
  resetPassword,
  changePassword,
  hashPassword,
  verifyPassword,
};
