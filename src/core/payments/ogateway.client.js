import crypto from 'node:crypto';
import env from '../../config/env.js';
import { ServiceUnavailableError, AppError } from '../../lib/errors.js';
import { timingSafeEqual } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';

/**
 * OGateway (https://docs.ogateway.io) — collects Nigerian bank transfers via a
 * temporary virtual account. Hand-rolled over fetch like the Paystack client;
 * inert (every call throws ServiceUnavailableError) until OGATEWAY_API_KEY is set.
 *
 * Unlike Paystack, `amount` here is in major units (50000 = ₦50,000), and the
 * API key goes in the Authorization header with no "Bearer" prefix.
 */

const BASE_URL = 'https://api.ogateway.io';

function requireKey() {
  if (!env.OGATEWAY_API_KEY) {
    throw new ServiceUnavailableError('OGateway', 'Bank transfer payment is not configured yet.');
  }
  return env.OGATEWAY_API_KEY;
}

async function call(method, path, body) {
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
 * Generates the temporary account the participant transfers into. The
 * response's `id` is what `getPayment` looks up later; `virtual_account` is
 * what gets shown to the participant.
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

export function getPayment(id) {
  return call('GET', `/payments/${encodeURIComponent(id)}`);
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

export default { createVirtualAccount, getPayment, verifyOgatewaySignature };
