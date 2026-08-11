import { Router } from 'express';
import * as controller from './auth.controller.js';
import * as schema from './auth.validation.js';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authLimiter, registrationLimiter, emailLimiter } from '../../middleware/rate-limit.js';

const router = Router();

router.post('/register',
  registrationLimiter,
  validate({ body: schema.registerSchema }),
  controller.register);

router.post('/login',
  authLimiter,
  validate({ body: schema.loginSchema }),
  controller.login);

router.post('/refresh',
  authLimiter,
  validate({ body: schema.refreshSchema }),
  controller.refresh);

router.post('/logout', controller.logout);

router.post('/verify-email',
  validate({ body: schema.verifyEmailSchema }),
  controller.verifyEmail);

router.post('/resend-verification',
  emailLimiter,
  validate({ body: schema.emailOnlySchema }),
  controller.resendVerification);

router.post('/forgot-password',
  emailLimiter,
  validate({ body: schema.emailOnlySchema }),
  controller.forgotPassword);

router.post('/reset-password',
  authLimiter,
  validate({ body: schema.resetPasswordSchema }),
  controller.resetPassword);

router.post('/change-password',
  authenticate,
  validate({ body: schema.changePasswordSchema }),
  controller.changePassword);

router.get('/me', authenticate, controller.me);

export default router;
