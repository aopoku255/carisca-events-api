import { models } from '../database/models/index.js';
import { verifyAccessToken } from '../core/auth/token.service.js';
import { getPermissions, assertKnownPermission } from '../core/rbac/rbac.service.js';
import { AuthenticationError, AuthorizationError } from '../lib/errors.js';

const { User, Role } = models;

/**
 * Verifies the bearer token and loads the user.
 *
 * The token version check is what makes deactivation and password resets take
 * effect immediately: a token minted before the bump no longer matches the
 * user's current version and is refused, without any token blacklist.
 */
export async function authenticate(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');

    if (!token || scheme.toLowerCase() !== 'bearer') {
      throw new AuthenticationError('Sign in to continue.');
    }

    const payload = verifyAccessToken(token);
    const user = await User.findByPk(payload.sub, {
      include: [{ model: Role, as: 'roles', through: { attributes: [] } }],
    });

    if (!user) throw new AuthenticationError('This account no longer exists.', 'ACCOUNT_MISSING');

    if (user.status !== 'ACTIVE') {
      throw new AuthenticationError('This account is not active.', 'ACCOUNT_INACTIVE');
    }

    if (Number(payload.tv) !== Number(user.token_version)) {
      throw new AuthenticationError(
        'Your session is no longer valid. Please sign in again.',
        'TOKEN_STALE',
      );
    }

    req.user = user;
    req.authPayload = payload;
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Populates req.user when a token is present, but never rejects. */
export async function optionalAuthenticate(req, res, next) {
  const header = req.get('authorization') || '';
  if (!header.toLowerCase().startsWith('bearer ')) return next();
  return authenticate(req, res, (err) => (err ? next() : next()));
}

/**
 * Resolves effective permissions. Separate from `authenticate` so that routes
 * needing only identity (a participant reading their own profile) do not pay
 * for a permission lookup.
 */
export async function loadPermissions(req, res, next) {
  try {
    if (!req.user) throw new AuthenticationError();
    req.permissions = await getPermissions(req.user.id);
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Resolves permissions when there is a caller, and quietly moves on when there
 * is not.
 *
 * For resources that are public for some rows and restricted for others — a
 * file, a certificate verification — where the route must serve anonymous
 * callers but still honour a signed-in user's rights.
 */
export async function loadPermissionsOptional(req, res, next) {
  try {
    req.permissions = req.user ? await getPermissions(req.user.id) : new Set();
    return next();
  } catch (err) {
    return next(err);
  }
}

function ensurePermissionsLoaded(req) {
  if (!req.permissions) {
    throw new Error(
      'requirePermission() used without loadPermissions() earlier in the chain.',
    );
  }
}

/** Requires every listed permission. */
export function requirePermission(...keys) {
  keys.forEach(assertKnownPermission);

  return (req, res, next) => {
    try {
      if (!req.user) throw new AuthenticationError();
      ensurePermissionsLoaded(req);

      const missing = keys.filter((k) => !req.permissions.has(k));
      if (missing.length) {
        throw new AuthorizationError(
          'You do not have permission to perform this action.',
          { required: keys, missing },
        );
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/** Requires at least one of the listed permissions. */
export function requireAnyPermission(...keys) {
  keys.forEach(assertKnownPermission);

  return (req, res, next) => {
    try {
      if (!req.user) throw new AuthenticationError();
      ensurePermissionsLoaded(req);

      if (!keys.some((k) => req.permissions.has(k))) {
        throw new AuthorizationError(
          'You do not have permission to perform this action.',
          { requiredAnyOf: keys },
        );
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/** Gate for the admin console as a whole. */
export function requireStaff(req, res, next) {
  if (!req.user) return next(new AuthenticationError());
  if (!req.user.is_staff) {
    return next(new AuthorizationError('This area is restricted to CARISCA staff.'));
  }
  return next();
}

/**
 * Ownership check for participant-facing resources.
 *
 * Deliberately independent of permissions: no permission grants a way past it,
 * and a staff member needs an explicit view permission to see someone else's
 * record rather than inheriting access by being staff.
 */
export function requireOwnershipOr(...permissionKeys) {
  permissionKeys.forEach(assertKnownPermission);

  return (ownerIdResolver) => async (req, res, next) => {
    try {
      if (!req.user) throw new AuthenticationError();

      const ownerId = await ownerIdResolver(req);
      if (ownerId !== null && String(ownerId) === String(req.user.id)) return next();

      const permissions = req.permissions || await getPermissions(req.user.id);
      if (permissionKeys.some((k) => permissions.has(k))) return next();

      throw new AuthorizationError('You do not have access to this resource.');
    } catch (err) {
      return next(err);
    }
  };
}

export default {
  authenticate,
  optionalAuthenticate,
  loadPermissions,
  loadPermissionsOptional,
  requirePermission,
  requireAnyPermission,
  requireStaff,
  requireOwnershipOr,
};
