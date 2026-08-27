import { Op } from 'sequelize';
import { models } from '../../database/models/index.js';
import { paymentReference } from '../../lib/ids.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { notify } from '../notifications/notification.service.js';
import { confirmPaidRegistration } from '../registrations/registration.service.js';
import * as paystack from './paystack.client.js';
import { logger } from '../../lib/logger.js';
import env from '../../config/env.js';

const {
  Payment, PaymentEvent, Registration, User,
} = models;

/**
 * Which currencies route through which Charge API flow. Paystack ties
 * channel availability to the transaction currency/market, not a raw
 * country field, so this is the single source of truth both `initiatePayment`
 * and the frontend's channel picker key off of.
 */
const MOBILE_MONEY_CURRENCIES = new Set(['GHS', 'KES']);
const BANK_CURRENCIES = new Set(['NGN']);
const MOBILE_MONEY_PROVIDERS = { GHS: ['mtn', 'atl', 'vod'], KES: ['mpesa'] };

let banksCache = null; // { fetchedAt, banks }
const BANKS_CACHE_TTL_MS = 6 * 60 * 60_000;

function callbackUrlFor(registration) {
  return `${env.WEB_URL}/dashboard/registrations/${registration.reference}/pay/callback`;
}

/** Dispatches to whichever Paystack "what's the status now" call matches this payment's channel. */
function checkChargeStatus(payment) {
  const channel = payment.provider_metadata?.channel;
  return channel === 'mobile_money' || channel === 'bank'
    ? paystack.checkPendingCharge(payment.reference)
    : paystack.verifyTransaction(payment.reference);
}

/** Nigerian banks rarely change; cached in-process so every pay-page load isn't a live Paystack call. */
export async function listBanks() {
  if (banksCache && Date.now() - banksCache.fetchedAt < BANKS_CACHE_TTL_MS) {
    return banksCache.banks;
  }
  const banks = await paystack.listBanks();
  banksCache = { fetchedAt: Date.now(), banks };
  return banks;
}

/**
 * The one place a payment actually completes. Guarded so both the
 * synchronous path (an OTP submit, a card-checkout verify) and the webhook
 * can call it safely — whichever gets there first wins, the other is a
 * no-op, and neither has to know about the other.
 */
export async function markPaymentSuccessful(payment, providerPayload = {}) {
  if (payment.status === 'SUCCESSFUL') return payment;

  await payment.update({
    status: 'SUCCESSFUL',
    paid_at: new Date(),
    last_verified_at: new Date(),
    provider_metadata: { ...(payment.provider_metadata || {}), ...providerPayload },
  });

  if (payment.registration_id) {
    await confirmPaidRegistration(payment.registration_id);
  }

  logger.info({
    paymentId: payment.id, registrationId: payment.registration_id,
  }, 'payment marked successful');
  return payment;
}

/**
 * The hold stays live and the registration stays `PENDING_PAYMENT` — a
 * failed attempt is not a cancelled registration, it's an invitation to try
 * again before the hold itself expires.
 */
export async function markPaymentFailed(payment, reason) {
  await payment.update({
    status: 'FAILED', failure_reason: reason, last_verified_at: new Date(),
  });

  const registration = payment.registration_id
    ? await Registration.findByPk(payment.registration_id, { include: [{ model: User, as: 'user' }] })
    : null;

  if (registration?.user) {
    await notify({
      userId: registration.user_id,
      channel: 'EMAIL',
      template: 'payment_failed',
      toAddress: registration.user.email,
      subject: 'Your payment did not go through',
      payload: {
        firstName: registration.user.first_name,
        reference: registration.reference,
        reason,
        payUrl: `${env.WEB_URL}/dashboard/registrations/${registration.reference}/pay`,
      },
      resourceType: 'registration',
      resourceId: String(registration.id),
    }).catch((err) => {
      logger.error({ err: err.message, paymentId: payment.id }, 'payment failure email failed');
    });
  }

  return payment;
}

/**
 * Starts a payment attempt. The channel has to match the registration's own
 * currency — each Charge API channel only ever settles in the currencies
 * Paystack supports it for, and that's a Paystack constraint, not a
 * preference, so it's enforced here rather than left to the frontend to get
 * right.
 */
export async function initiatePayment(registration, { channel, mobileMoney, bank } = {}) {
  if (!['PENDING_PAYMENT', 'REQUIRES_REVIEW'].includes(registration.status)) {
    throw new ConflictError('This registration is not waiting on payment.', 'NOT_AWAITING_PAYMENT');
  }

  const { currency } = registration;
  const isMobileMoney = MOBILE_MONEY_CURRENCIES.has(currency);
  const isBank = BANK_CURRENCIES.has(currency);

  if (channel === 'mobile_money' && !isMobileMoney) {
    throw new ConflictError(`Mobile money is not available for ${currency}-priced registrations.`, 'CHANNEL_UNAVAILABLE');
  }
  if (channel === 'bank' && !isBank) {
    throw new ConflictError(`Bank payment is not available for ${currency}-priced registrations.`, 'CHANNEL_UNAVAILABLE');
  }
  if (channel === 'card' && (isMobileMoney || isBank)) {
    throw new ConflictError(`A ${currency} registration is not paid by card.`, 'CHANNEL_UNAVAILABLE');
  }
  if (channel === 'mobile_money') {
    const allowedProviders = MOBILE_MONEY_PROVIDERS[currency] ?? [];
    if (!mobileMoney?.phone || !mobileMoney?.provider) {
      throw new ValidationError([
        { field: 'mobileMoney', message: 'A phone number and mobile network are required.' },
      ]);
    }
    if (!allowedProviders.includes(mobileMoney.provider)) {
      throw new ValidationError([
        { field: 'mobileMoney.provider', message: `That mobile network is not available for ${currency}.` },
      ]);
    }
  }
  if (channel === 'bank' && (!bank?.accountNumber || !bank?.code)) {
    throw new ValidationError([
      { field: 'bank', message: 'A bank and account number are required.' },
    ]);
  }

  const payment = await Payment.create({
    registration_id: registration.id,
    event_id: registration.event_id,
    user_id: registration.user_id,
    reference: paymentReference(),
    provider: 'paystack',
    amount_minor: registration.price_amount_minor,
    currency: registration.currency,
    status: 'PROCESSING',
  });

  const email = registration.user.email;

  // Paystack itself — network trouble, a missing key, a rejected request —
  // must not leave this row stuck in PROCESSING forever: the reconciliation
  // sweep would poll it indefinitely for a charge Paystack never actually
  // started. Whatever went wrong here is final, not a status to reconcile.
  try {
    if (channel === 'mobile_money') {
      const data = await paystack.initiateMobileMoneyCharge({
        email,
        amountMinor: registration.price_amount_minor,
        currency: registration.currency,
        reference: payment.reference,
        phone: mobileMoney.phone,
        provider: mobileMoney.provider,
      });

      await payment.update({
        provider_reference: payment.reference,
        provider_metadata: {
          channel: 'mobile_money', paystackStatus: data.status, displayText: data.display_text ?? null,
        },
      });

      if (data.status === 'success') await markPaymentSuccessful(payment, { paystackStatus: data.status });

      return {
        payment, status: data.status, displayText: data.display_text ?? null,
      };
    }

    if (channel === 'bank') {
      const data = await paystack.initiateBankCharge({
        email,
        amountMinor: registration.price_amount_minor,
        currency: registration.currency,
        reference: payment.reference,
        bankCode: bank.code,
        accountNumber: bank.accountNumber,
      });

      await payment.update({
        provider_reference: payment.reference,
        provider_metadata: {
          channel: 'bank', paystackStatus: data.status, displayText: data.display_text ?? null,
        },
      });

      if (data.status === 'success') await markPaymentSuccessful(payment, { paystackStatus: data.status });

      return {
        payment, status: data.status, displayText: data.display_text ?? null,
      };
    }

    const data = await paystack.initializeTransaction({
      email,
      amountMinor: registration.price_amount_minor,
      currency: registration.currency,
      reference: payment.reference,
      callbackUrl: callbackUrlFor(registration),
    });

    await payment.update({
      provider_reference: payment.reference,
      checkout_url: data.authorization_url,
      provider_metadata: { channel: 'card' },
    });

    return { payment, checkoutUrl: data.authorization_url };
  } catch (err) {
    await payment.update({ status: 'FAILED', failure_reason: err.message?.slice(0, 500) ?? 'Could not start the payment.' });
    throw err;
  }
}

async function relayChargeResult(payment, data) {
  await payment.update({
    provider_metadata: { ...(payment.provider_metadata || {}), paystackStatus: data.status },
  });

  if (data.status === 'success') {
    await markPaymentSuccessful(payment, { paystackStatus: data.status });
  } else if (data.status === 'failed') {
    await markPaymentFailed(payment, data.message || 'The charge failed.');
  }

  return { payment, status: data.status, message: data.message ?? null };
}

export async function findPaymentByReference(reference) {
  const payment = await Payment.findOne({ where: { reference } });
  if (!payment) throw new NotFoundError('Payment');
  return payment;
}

export async function submitOtp(reference, otp) {
  const payment = await findPaymentByReference(reference);
  if (payment.status === 'SUCCESSFUL') return { payment, status: 'success', message: null };
  const data = await paystack.submitOtp({ reference: payment.reference, otp });
  return relayChargeResult(payment, data);
}

export async function submitPin(reference, pin) {
  const payment = await findPaymentByReference(reference);
  if (payment.status === 'SUCCESSFUL') return { payment, status: 'success', message: null };
  const data = await paystack.submitPin({ reference: payment.reference, pin });
  return relayChargeResult(payment, data);
}

export async function submitBirthday(reference, birthday) {
  const payment = await findPaymentByReference(reference);
  if (payment.status === 'SUCCESSFUL') return { payment, status: 'success', message: null };
  const data = await paystack.submitBirthday({ reference: payment.reference, birthday });
  return relayChargeResult(payment, data);
}

/**
 * Used by the card-checkout return page and the pay page's "waiting" screen
 * for mobile-money/bank charges that settle asynchronously (M-Pesa's STK
 * push, a bank charge still awaiting the customer) — never trust a redirect
 * or an idle UI alone.
 */
export async function verifyPayment(reference) {
  const payment = await findPaymentByReference(reference);
  if (payment.status === 'SUCCESSFUL') return payment;

  const data = await checkChargeStatus(payment);
  await payment.update({ last_verified_at: new Date() });

  if (data.status === 'success') {
    await markPaymentSuccessful(payment, { paystackStatus: data.status });
  } else if (['failed', 'abandoned'].includes(data.status)) {
    await markPaymentFailed(payment, data.gateway_response || 'Payment was not completed.');
  }

  return payment;
}

/**
 * Processes one Paystack webhook delivery. `providerEventId` is the dedupe
 * key — Paystack sends no dedicated event-id field, so the event type plus
 * the transaction's own numeric id (stable across retries) stands in for
 * one. The unique constraint on `payment_events.provider_event_id` is what
 * actually enforces the dedupe; a replay fails that insert and is caught
 * below rather than reprocessed.
 */
export async function processWebhookEvent({
  eventType, data, providerEventId, rawPayload, signatureValid,
}) {
  let paymentEvent;
  try {
    paymentEvent = await PaymentEvent.create({
      provider: 'paystack',
      provider_event_id: providerEventId,
      event_type: eventType,
      raw_payload: rawPayload,
      signature_valid: signatureValid,
      received_at: new Date(),
    });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') return { deduped: true, processed: false };
    throw err;
  }

  if (!signatureValid) {
    await paymentEvent.update({ processing_status: 'IGNORED', processing_error: 'Invalid signature' });
    return { deduped: false, processed: false };
  }

  try {
    if (eventType === 'charge.success' && data?.reference) {
      const payment = await Payment.findOne({ where: { reference: data.reference } });
      if (payment) {
        await paymentEvent.update({ payment_id: payment.id });
        await markPaymentSuccessful(payment, { paystackStatus: 'success', webhook: true });
      }
    }
    await paymentEvent.update({ processing_status: 'PROCESSED', processed_at: new Date() });
  } catch (err) {
    await paymentEvent.update({ processing_status: 'FAILED', processing_error: err.message });
    throw err;
  }

  return { deduped: false, processed: true };
}

/**
 * The safety net for a webhook that never arrives and a participant who
 * never comes back to the app after paying. Same shape as
 * `registration.service.js`'s `sweepExpiredHolds()` — a bounded poll on a
 * schedule, not a retry queue.
 */
export async function reconcilePendingPayments({ now = new Date() } = {}) {
  const staleAfter = new Date(now.getTime() - 5 * 60_000);
  const recentlyChecked = new Date(now.getTime() - 2 * 60_000);

  const pending = await Payment.findAll({
    where: {
      status: { [Op.in]: ['PENDING', 'PROCESSING'] },
      created_at: { [Op.lt]: staleAfter },
      [Op.or]: [
        { last_verified_at: null },
        { last_verified_at: { [Op.lt]: recentlyChecked } },
      ],
    },
    limit: 200,
  });

  let reconciled = 0;

  for (const payment of pending) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const data = await checkChargeStatus(payment);

      // eslint-disable-next-line no-await-in-loop
      await payment.update({ last_verified_at: new Date() });

      if (data.status === 'success') {
        // eslint-disable-next-line no-await-in-loop
        await markPaymentSuccessful(payment, { paystackStatus: data.status });
        reconciled += 1;
      } else if (['failed', 'abandoned'].includes(data.status)) {
        // eslint-disable-next-line no-await-in-loop
        await markPaymentFailed(payment, data.gateway_response || data.message || 'Payment was not completed.');
      }
    } catch (err) {
      logger.warn({ err: err.message, paymentId: payment.id }, 'payment reconciliation check failed');
    }
  }

  if (pending.length) logger.info({ checked: pending.length, reconciled }, 'payment reconciliation swept');
  return { checked: pending.length, reconciled };
}

export default {
  initiatePayment,
  submitOtp,
  submitPin,
  submitBirthday,
  verifyPayment,
  markPaymentSuccessful,
  markPaymentFailed,
  processWebhookEvent,
  reconcilePendingPayments,
  findPaymentByReference,
  listBanks,
};
