import jwt from 'jsonwebtoken';
import { Op } from 'sequelize';
import env from '../../config/env.js';
import { models } from '../../database/models/index.js';
import { sha256, newUlid, randomToken } from '../../lib/ids.js';
import { AuthenticationError } from '../../lib/errors.js';

const { RefreshToken } = models;

/**
 * Access tokens are short-lived and carry only an identity plus a token
 * version — no permissions, no roles. Refresh tokens rotate on every use and
 * are stored only as a digest.
 */

export function signAccessToken(user) {
  return jwt.sign(
    {
      sub: String(user.id),
      tv: user.token_version,
      staff: !!user.is_staff,
    },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.ACCESS_TOKEN_TTL, issuer: 'carisca-api' },
  );
}

export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: 'carisca-api' });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new AuthenticationError('Your session has expired. Please sign in again.', 'TOKEN_EXPIRED');
    }
    throw new AuthenticationError('Invalid authentication token.', 'TOKEN_INVALID');
  }
}

function refreshExpiry() {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Issues a refresh token. `familyId` continues an existing rotation chain;
 * omitting it starts a new one (a fresh sign-in).
 */
export async function issueRefreshToken(user, { familyId = null, ip = null, userAgent = null, transaction = null } = {}) {
  const raw = randomToken(32);
  const family = familyId || newUlid();

  await RefreshToken.create({
    user_id: user.id,
    token_hash: sha256(raw),
    family_id: family,
    ip,
    user_agent: userAgent ? String(userAgent).slice(0, 255) : null,
    expires_at: refreshExpiry(),
  }, { transaction });

  return { token: raw, familyId: family };
}

/**
 * Rotates a refresh token.
 *
 * Presenting a token that has already been rotated means it was replayed —
 * either the user's copy leaked or an attacker's did. We cannot tell which, so
 * the entire family is revoked and both parties are forced to sign in again.
 */
export async function rotateRefreshToken(rawToken, { ip = null, userAgent = null } = {}) {
  const hash = sha256(rawToken);
  const record = await RefreshToken.findOne({ where: { token_hash: hash } });

  if (!record) {
    throw new AuthenticationError('Invalid refresh token.', 'REFRESH_INVALID');
  }

  if (record.revoked_at) {
    await RefreshToken.update(
      { revoked_at: new Date(), revoked_reason: 'REUSE_DETECTED' },
      { where: { family_id: record.family_id, revoked_at: { [Op.is]: null } } },
    );
    throw new AuthenticationError(
      'This session has been ended for security reasons. Please sign in again.',
      'REFRESH_REUSED',
    );
  }

  if (record.expires_at <= new Date()) {
    throw new AuthenticationError('Your session has expired. Please sign in again.', 'REFRESH_EXPIRED');
  }

  const user = await models.User.findByPk(record.user_id);
  if (!user || !user.isActive()) {
    await RefreshToken.update(
      { revoked_at: new Date(), revoked_reason: 'USER_INACTIVE' },
      { where: { family_id: record.family_id, revoked_at: { [Op.is]: null } } },
    );
    throw new AuthenticationError('This account is not active.', 'ACCOUNT_INACTIVE');
  }

  record.revoked_at = new Date();
  record.revoked_reason = 'ROTATED';
  await record.save();

  const next = await issueRefreshToken(user, { familyId: record.family_id, ip, userAgent });

  return { user, accessToken: signAccessToken(user), refreshToken: next.token };
}

export async function revokeToken(rawToken, reason = 'LOGOUT') {
  const [count] = await RefreshToken.update(
    { revoked_at: new Date(), revoked_reason: reason },
    { where: { token_hash: sha256(rawToken), revoked_at: { [Op.is]: null } } },
  );
  return count > 0;
}

/** Used on password reset, deactivation and role change. */
export async function revokeAllForUser(userId, reason = 'REVOKED') {
  const [count] = await RefreshToken.update(
    { revoked_at: new Date(), revoked_reason: reason },
    { where: { user_id: userId, revoked_at: { [Op.is]: null } } },
  );
  return count;
}

export default {
  signAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeToken,
  revokeAllForUser,
};
