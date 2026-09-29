import crypto from 'node:crypto';
import env from '../../config/env.js';
import { ServiceUnavailableError, AppError } from '../../lib/errors.js';
import { timingSafeEqual } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';

/**
 * OGateway (https://docs.ogateway.io) — collects Nigerian (NGN) payments
 * through its hosted Checkout page or a temporary bank-transfer virtual account. Hand-rolled over fetch like the Paystack client;
 * inert (every call throws ServiceUnavailableError) until OGATEWAY_API_KEY is set.
 *
 * Unlike Paystack, `amount` here is in major units (50000 = ₦50,000), and the
 * API key goes in the Authorization header with no "Bearer" prefix.
 */

const BASE_URL = 'https://api.ogateway.io';

function requireKey() {
  if (!env.OGATEWAY_API_KEY) {
    throw new ServiceUnavailableError('OGateway', 'Online payment is not configured yet.');
  }
  return env.OGATEWAY_API_KEY;
}

async function call(method, path, body, { notFoundIsNull = false } = {}) {
  const key = requireKey();

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      // A JSON content-type on a body-less GET makes OGateway answer 502.
      headers: { Authorization: key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    logger.error({ err: err.message, path }, 'ogateway request failed to send');
    throw new ServiceUnavailableError('OGateway');
  }

  const json = await response.json().catch(() => null);

  if (notFoundIsNull && response.status === 404) return null;

  if (!response.ok) {
    logger.warn({ path, httpStatus: response.status, body: json }, 'ogateway request was refused');
    const message = Array.isArray(json?.message) ? json.message.join(' ') : json?.message;
    throw new AppError(message || 'The payment provider refused this request.', {
      status: 422,
      code: 'OGATEWAY_REJECTED',
      details: null,
    });
  }

  return json;
}

/**
 * Creates a hosted checkout session. The response's `id` is both what the
 * webhook later reports as its own `id` and what `getPayment` looks up —
 * OGateway generates its own `reference_business` for checkouts, so `id` is
 * the only key that ties a callback back to our payment.
 */
export function createCheckout({ amount, currency }) {
  return call('POST', '/collections/checkout', {
    amount,
    currency,
    ...(env.OGATEWAY_CALLBACK_URL ? { callbackURL: env.OGATEWAY_CALLBACK_URL } : {}),
  });
}

/**
 * A temporary bank account the participant transfers into from their own
 * banking app, shown on our own page rather than OGateway's. The response's
 * `id` is what the webhook reports and `getPayment` looks up;
 * `virtual_account` is what gets displayed.
 */
export function createVirtualAccount({
  amount, currency, reference, accountName, accountNumber, reason, email,
}) {
  return call('POST', '/collections/virtual-account', {
    amount,
    currency,
    network: env.OGATEWAY_VA_NETWORK,
    accountName,
    accountNumber,
    reason,
    reference,
    email,
    ...(env.OGATEWAY_CALLBACK_URL ? { callbackURL: env.OGATEWAY_CALLBACK_URL } : {}),
  });
}

/**
 * Null while nothing has been attempted yet: a checkout session only becomes
 * a payment once the customer starts paying on the hosted page.
 */
export function getPayment(id) {
  return call('GET', `/payments/${encodeURIComponent(id)}`, undefined, { notFoundIsNull: true });
}

/** HMAC-SHA512 (hex) of the exact raw body, keyed by the webhook secret. */
export function verifyOgatewaySignature(rawBody, signatureHeader) {
  if (!signatureHeader || !env.OGATEWAY_WEBHOOK_SECRET) return false;
  const expected = crypto
    .createHmac('sha512', env.OGATEWAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return timingSafeEqual(expected, signatureHeader);
}

export default { createCheckout, createVirtualAccount, getPayment, verifyOgatewaySignature };
