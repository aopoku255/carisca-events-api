import * as authService from './auth.service.js';
import { rotateRefreshToken, revokeToken, revokeAllForUser } from './token.service.js';
import { getPermissions } from '../rbac/rbac.service.js';
import { serialiseUser } from '../users/user.serialiser.js';
import { record as audit } from '../audit/audit.service.js';
import { ok, created } from '../../lib/response.js';

const contextOf = (req) => ({
  ip: req.ip,
  userAgent: req.get('user-agent'),
  requestId: req.id,
});

export async function register(req, res, next) {
  try {
    const { user, verificationToken } = await authService.register(req.body, contextOf(req));

    await audit({
      actor: { id: user.id, email: user.email },
      action: 'user.registered',
      resourceType: 'user',
      resourceId: user.id,
      after: { email: user.email, isStaff: false },
      context: contextOf(req),
    });

    return created(res, {
      user: serialiseUser(user),
      // Present in development only, so the flow can be exercised without mail.
      verificationToken,
    }, 'Account created. Check your email to confirm your address.');
  } catch (err) {
    return next(err);
  }
}

export async function login(req, res, next) {
  try {
    const { user, accessToken, refreshToken } = await authService.login(req.body, contextOf(req));
    const permissions = await getPermissions(user.id);

    return ok(res, {
      user: serialiseUser(user, { permissions }),
      accessToken,
      refreshToken,
    }, 'Signed in.');
  } catch (err) {
    return next(err);
  }
}

export async function refresh(req, res, next) {
  try {
    const result = await rotateRefreshToken(req.body.refreshToken, contextOf(req));
    return ok(res, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    }, 'Session refreshed.');
  } catch (err) {
    return next(err);
  }
}

export async function logout(req, res, next) {
  try {
    if (req.body?.refreshToken) {
      await revokeToken(req.body.refreshToken, 'LOGOUT');
    } else if (req.user) {
      await revokeAllForUser(req.user.id, 'LOGOUT_ALL');
    }
    return ok(res, null, 'Signed out.');
  } catch (err) {
    return next(err);
  }
}

export async function verifyEmail(req, res, next) {
  try {
    const user = await authService.verifyEmail(req.body.token);
    return ok(res, { user: serialiseUser(user) }, 'Email address confirmed.');
  } catch (err) {
    return next(err);
  }
}

export async function resendVerification(req, res, next) {
  try {
    await authService.resendVerification(req.body.email);
    return ok(res, null, 'If that address has an unconfirmed account, a new link is on its way.');
  } catch (err) {
    return next(err);
  }
}

export async function forgotPassword(req, res, next) {
  try {
    await authService.requestPasswordReset(req.body.email);
    return ok(res, null, 'If that address has an account, a reset link is on its way.');
  } catch (err) {
    return next(err);
  }
}

export async function resetPassword(req, res, next) {
  try {
    await authService.resetPassword(req.body.token, req.body.password);
    return ok(res, null, 'Password updated. Sign in with your new password.');
  } catch (err) {
    return next(err);
  }
}

export async function changePassword(req, res, next) {
  try {
    await authService.changePassword(req.user.id, req.body.currentPassword, req.body.newPassword);

    await audit({
      actor: { id: req.user.id, email: req.user.email },
      action: 'user.password_changed',
      resourceType: 'user',
      resourceId: req.user.id,
      context: contextOf(req),
    });

    return ok(res, null, 'Password changed. Other sessions have been signed out.');
  } catch (err) {
    return next(err);
  }
}

export async function me(req, res, next) {
  try {
    const permissions = await getPermissions(req.user.id);
    return ok(res, { user: serialiseUser(req.user, { permissions }) });
  } catch (err) {
    return next(err);
  }
}

export default {
  register, login, refresh, logout, verifyEmail, resendVerification,
  forgotPassword, resetPassword, changePassword, me,
};
