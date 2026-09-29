import { Op } from 'sequelize';
import { models } from '../../database/models/index.js';
import { paymentReference } from '../../lib/ids.js';
import {
  AppError, ConflictError, NotFoundError, ValidationError,
} from '../../lib/errors.js';
import { notify } from '../notifications/notification.service.js';
import { confirmPaidRegistration } from '../registrations/registration.service.js';
import * as paystack from './paystack.client.js';
import * as ogateway from './ogateway.client.js';
import { fromMinor } from '../../lib/money.js';
import { logger } from '../../lib/logger.js';
import env from '../../config/env.js';

const {
  Payment, PaymentEvent, Registration, User, Event,
} = models;

/**
 * Which currencies route through which flow. Channel availability follows the
 * transaction currency/market, not a raw country field, so this is the single
 * source of truth both `initiatePayment` and the frontend's channel picker
 * key off of. Ghana and Kenya use Paystack's mobile-money Charge API; Nigeria
 * (NGN) is paid by bank transfer into an OGateway virtual account; everything
 * else is Paystack card checkout.
 */
const MOBILE_MONEY_CURRENCIES = new Set(['GHS', 'KES']);
const BANK_TRANSFER_CURRENCIES = new Set(['NGN']);
const MOBILE_MONEY_PROVIDERS = { GHS: ['mtn', 'atl', 'vod'], KES: ['mpesa'] };

function callbackUrlFor(registration) {
  return `${env.WEB_URL}/dashboard/registrations/${registration.reference}/pay/callback`;
}

/**
 * OGateway statuses folded into the Paystack-shaped verdict the rest of this
 * file already branches on. A COMPLETED transfer for less than the amount due
 * is deliberately neither success nor failure — the registration must not
 * confirm on a short payment, and it isn't the participant's failure to retry.
 */
function normaliseOgatewayStatus(payment, data) {
  const paidAmount = Number(data.amount);
  const dueAmount = Number(fromMinor(payment.amount_minor, payment.currency));

  if (data.status === 'COMPLETED') {
    if (data.currency && data.currency !== payment.currency) {
      logger.error({ paymentId: payment.id, got: data.currency }, 'ogateway payment settled in the wrong currency');
      return { status: 'underpaid', message: 'Payment currency did not match.' };
    }
    if (!(paidAmount >= dueAmount)) {
      logger.error({ paymentId: payment.id, paidAmount, dueAmount }, 'ogateway payment was less than the amount due');
      return { status: 'underpaid', message: 'Payment was less than the amount due.' };
    }
    return { status: 'success', message: null };
  }
  if (['FAILED', 'CANCELLED'].includes(data.status)) {
    return { status: 'failed', message: data.provider_message || data.message || 'The transfer was not completed.' };
  }
  return { status: 'pending', message: null };
}

/** Dispatches to whichever provider call matches this payment's channel. */
async function checkChargeStatus(payment) {
  if (payment.provider === 'ogateway') {
    const data = await ogateway.getPayment(payment.provider_metadata?.ogatewayId);
    const verdict = normaliseOgatewayStatus(payment, data);
    return { status: verdict.status, gateway_response: verdict.message };
  }

  const channel = payment.provider_metadata?.channel;
  return channel === 'mobile_money'
    ? paystack.checkPendingCharge(payment.reference)
    : paystack.verifyTransaction(payment.reference);
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
    ? await Registration.findByPk(payment.registration_id, {
      include: [{ model: User, as: 'user' }, { model: Event, as: 'event' }],
    })
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
        eventTitle: registration.event?.title,
        bannerFileId: registration.event?.banner_file_id,
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
export async function initiatePayment(registration, { channel, mobileMoney } = {}) {
  if (!['PENDING_PAYMENT', 'REQUIRES_REVIEW'].includes(registration.status)) {
    throw new ConflictError('This registration is not waiting on payment.', 'NOT_AWAITING_PAYMENT');
  }

  const { currency } = registration;
  const isMobileMoney = MOBILE_MONEY_CURRENCIES.has(currency);
  const isBankTransfer = BANK_TRANSFER_CURRENCIES.has(currency);

  if (channel === 'mobile_money' && !isMobileMoney) {
    throw new ConflictError(`Mobile money is not available for ${currency}-priced registrations.`, 'CHANNEL_UNAVAILABLE');
  }
  if (channel === 'bank_transfer' && !isBankTransfer) {
    throw new ConflictError(`Bank transfer is not available for ${currency}-priced registrations.`, 'CHANNEL_UNAVAILABLE');
  }
  if (channel === 'card' && (isMobileMoney || isBankTransfer)) {
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

  const payment = await Payment.create({
    registration_id: registration.id,
    event_id: registration.event_id,
    user_id: registration.user_id,
    reference: paymentReference(),
    provider: channel === 'bank_transfer' ? 'ogateway' : 'paystack',
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

    if (channel === 'bank_transfer') {
      const { user } = registration;
      const data = await ogateway.createVirtualAccount({
        amount: Number(fromMinor(registration.price_amount_minor, registration.currency)),
        currency: registration.currency,
        reference: payment.reference,
        accountName: `${user.first_name} ${user.last_name}`.trim(),
        // "The customer's mobile number or identifier" — the phone on file.
        accountNumber: String(user.phone ?? '').replace(/\D/g, ''),
        reason: `Registration ${registration.reference}`,
        email,
      });

      const virtualAccount = {
        bankName: data.virtual_account?.bank_name ?? null,
        accountName: data.virtual_account?.account_name ?? null,
        accountNumber: data.virtual_account?.account_number ?? null,
      };
      if (!virtualAccount.accountNumber) {
        throw new AppError('The payment provider did not return an account to pay into.', {
          status: 502, code: 'OGATEWAY_NO_ACCOUNT',
        });
      }

      await payment.update({
        provider_reference: String(data.id),
        provider_metadata: { channel: 'bank_transfer', ogatewayId: String(data.id), virtualAccount },
      });

      return { payment, status: 'pending_transfer', virtualAccount };
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
 * Processes one OGateway callback. Its payload carries no event id or type,
 * only the transaction's own `id` and `status`, so `id:status` is the dedupe
 * key — a replay of the same outcome fails the unique insert and is skipped,
 * while COMPLETED arriving after an earlier FAILED for the same id is still
 * processed. The payment is found by `reference_business`, the reference we
 * sent when creating the virtual account.
 */
export async function processOgatewayWebhook({ payload, signatureValid }) {
  let paymentEvent;
  try {
    paymentEvent = await PaymentEvent.create({
      provider: 'ogateway',
      provider_event_id: `${payload?.id ?? 'unknown'}:${payload?.status ?? 'unknown'}`,
      event_type: `collection.${String(payload?.status ?? 'unknown').toLowerCase()}`,
      raw_payload: payload,
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
    const payment = payload?.reference_business
      ? await Payment.findOne({ where: { reference: payload.reference_business, provider: 'ogateway' } })
      : null;

    if (payment) {
      await paymentEvent.update({ payment_id: payment.id });
      const verdict = normaliseOgatewayStatus(payment, payload);

      if (verdict.status === 'success') {
        await markPaymentSuccessful(payment, { ogatewayStatus: payload.status, webhook: true });
      } else if (verdict.status === 'failed' && payment.status !== 'SUCCESSFUL') {
        await markPaymentFailed(payment, verdict.message);
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
  verifyPayment,
  markPaymentSuccessful,
  markPaymentFailed,
  processWebhookEvent,
  processOgatewayWebhook,
  reconcilePendingPayments,
  findPaymentByReference,
};
