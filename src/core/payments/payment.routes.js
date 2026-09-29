import { Router } from 'express';
import { z } from 'zod';
import { models } from '../../database/models/index.js';
import * as paymentService from './payment.service.js';
import { ok, created } from '../../lib/response.js';
import { serialiseMoney } from '../../lib/money.js';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { AuthorizationError, NotFoundError } from '../../lib/errors.js';

const { Registration, User } = models;

const router = Router();

/**
 * Ownership only, no staff permission — a participant pays for their own
 * registration and nothing else, the same boundary `registration.routes.js`
 * draws around its own owner-only routes.
 */
async function ownedRegistrationByReference(reference, userId) {
  const registration = await Registration.findOne({
    where: { reference },
    include: [{ model: User, as: 'user' }],
  });
  if (!registration) throw new NotFoundError('Registration');
  if (String(registration.user_id) !== String(userId)) {
    throw new AuthorizationError('You do not have access to this registration.');
  }
  return registration;
}

async function ownedPaymentByReference(reference, userId) {
  const payment = await paymentService.findPaymentByReference(reference);
  if (String(payment.user_id) !== String(userId)) {
    throw new AuthorizationError('You do not have access to this payment.');
  }
  return payment;
}

router.post('/initiate',
  authenticate,
  validate({
    body: z.object({
      registrationReference: z.string().trim().min(1).max(48),
      channel: z.enum(['mobile_money', 'checkout', 'bank_transfer', 'card']),
      mobileMoney: z.object({
        phone: z.string().trim().min(6).max(20),
        provider: z.enum(['mtn', 'atl', 'vod', 'mpesa']),
      }).optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const { registrationReference, channel, mobileMoney } = req.body;
      const registration = await ownedRegistrationByReference(registrationReference, req.user.id);
      const result = await paymentService.initiatePayment(registration, { channel, mobileMoney });

      return created(res, {
        reference: result.payment.reference,
        status: result.status ?? 'initialized',
        displayText: result.displayText ?? null,
        checkoutUrl: result.checkoutUrl ?? null,
        virtualAccount: result.virtualAccount ?? null,
      });
    } catch (err) {
      return next(err);
    }
  });

router.post('/:reference/submit-otp',
  authenticate,
  validate({
    params: z.object({ reference: z.string().trim().min(1).max(48) }),
    body: z.object({ otp: z.string().trim().min(1).max(20) }),
  }),
  async (req, res, next) => {
    try {
      await ownedPaymentByReference(req.params.reference, req.user.id);
      const result = await paymentService.submitOtp(req.params.reference, req.body.otp);
      return ok(res, { status: result.status, message: result.message });
    } catch (err) {
      return next(err);
    }
  });

router.post('/:reference/submit-pin',
  authenticate,
  validate({
    params: z.object({ reference: z.string().trim().min(1).max(48) }),
    body: z.object({ pin: z.string().trim().min(1).max(10) }),
  }),
  async (req, res, next) => {
    try {
      await ownedPaymentByReference(req.params.reference, req.user.id);
      const result = await paymentService.submitPin(req.params.reference, req.body.pin);
      return ok(res, { status: result.status, message: result.message });
    } catch (err) {
      return next(err);
    }
  });

/**
 * Reads current status — and, for a payment still awaiting a verdict on a
 * channel that settles asynchronously (card checkout's redirect, M-Pesa's
 * STK push, an OGateway checkout), checks with Paystack first. This is
 * what both the card checkout-return page and the pay page's "waiting"
 * screen poll. Ghana mobile money is the one channel that's never checked
 * here: its own submit-otp/submit-pin response, the webhook, and the
 * reconciliation sweep already cover it, and OTP/PIN codes expire — polling
 * this route wouldn't move it forward.
 */
router.get('/:reference',
  authenticate,
  validate({ params: z.object({ reference: z.string().trim().min(1).max(48) }) }),
  async (req, res, next) => {
    try {
      let payment = await ownedPaymentByReference(req.params.reference, req.user.id);
      const channel = payment.provider_metadata?.channel;

      if (['PENDING', 'PROCESSING'].includes(payment.status)
          && (channel === 'card' || channel === 'checkout' || channel === 'bank_transfer'
              || (channel === 'mobile_money' && payment.provider_metadata?.paystackStatus === 'pending'))) {
        payment = await paymentService.verifyPayment(payment.reference);
      }

      return ok(res, {
        reference: payment.reference,
        status: payment.status,
        amount: serialiseMoney(payment.amount_minor, payment.currency),
        checkoutUrl: payment.checkout_url,
        virtualAccount: payment.provider_metadata?.virtualAccount ?? null,
        failureReason: payment.failure_reason,
      });
    } catch (err) {
      return next(err);
    }
  });

export default router;
