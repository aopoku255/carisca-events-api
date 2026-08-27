import crypto from 'node:crypto';
import env from '../../config/env.js';
import { ServiceUnavailableError, AppError } from '../../lib/errors.js';
import { timingSafeEqual } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';

/**
 * A hand-rolled wrapper over Paystack's REST API, not their SDK — the surface
 * used here is a handful of endpoints and a signature check, which a
 * dependency buys nothing for. Every function throws `ServiceUnavailableError` if
 * `PAYSTACK_SECRET_KEY` is unset, which is what lets this whole module ship
 * and stay inert until a real key is dropped into the environment.
 *
 * Endpoint paths and field names are taken from Paystack's own TypeScript
 * SDK type definitions (their docs site blocks non-browser requests) —
 * `amount` throughout is the minor-unit integer this codebase already tracks
 * as `amount_minor`, no conversion needed.
 */

const BASE_URL = 'https://api.paystack.co';

function requireKey() {
  if (!env.PAYSTACK_SECRET_KEY) {
    throw new ServiceUnavailableError('Paystack', 'Online payment is not configured yet.');
  }
  return env.PAYSTACK_SECRET_KEY;
}

async function call(method, path, body) {
  const key = requireKey();

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    logger.error({ err: err.message, path }, 'paystack request failed to send');
    throw new ServiceUnavailableError('Paystack');
  }

  const json = await response.json().catch(() => null);

  if (!response.ok || !json?.status) {
    logger.warn({ path, httpStatus: response.status, body: json }, 'paystack request was refused');
    throw new AppError(json?.message || 'The payment provider refused this request.', {
      status: 422,
      code: 'PAYSTACK_REJECTED',
      details: json?.data ?? null,
    });
  }

  return json.data;
}

/** Card checkout — redirect the browser to `data.authorization_url`. */
export function initializeTransaction({
  email, amountMinor, currency, reference, callbackUrl,
}) {
  return call('POST', '/transaction/initialize', {
    email,
    amount: amountMinor,
    currency,
    reference,
    callback_url: callbackUrl,
  });
}

/** Call after the browser returns from checkout — never trust the redirect alone. */
export function verifyTransaction(reference) {
  return call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
}

/**
 * Ghana mobile money. `provider` is one of `mtn`/`atl`/`vod`. `data.status`
 * on the response says what happens next — usually `send_otp`, sometimes a
 * PIN is asked for instead via `submitPin`.
 */
export function initiateMobileMoneyCharge({
  email, amountMinor, currency, reference, phone, provider,
}) {
  return call('POST', '/charge', {
    email,
    amount: amountMinor,
    currency,
    reference,
    mobile_money: { phone, provider },
  });
}

export function submitOtp({ reference, otp }) {
  return call('POST', '/charge/submit_otp', { reference, otp });
}

export function submitPin({ reference, pin }) {
  return call('POST', '/charge/submit_pin', { reference, pin });
}

export function submitBirthday({ reference, birthday }) {
  return call('POST', '/charge/submit_birthday', { reference, birthday });
}

/**
 * Nigeria "Pay with Bank". `data.status` after this call is usually
 * `send_birthday` or `send_otp` — which one Paystack asks for first isn't
 * documented anywhere reachable (their docs site 403s non-browser requests),
 * so callers must not assume an order and should branch on whatever status
 * actually comes back.
 */
export function initiateBankCharge({
  email, amountMinor, currency, reference, bankCode, accountNumber, birthday,
}) {
  return call('POST', '/charge', {
    email,
    amount: amountMinor,
    currency,
    reference,
    bank: { code: bankCode, account_number: accountNumber },
    ...(birthday ? { birthday } : {}),
  });
}

/** Nigerian banks that support "Pay with Bank" — populates the account-charge picker. */
export function listBanks() {
  return call('GET', '/bank?country=nigeria&currency=NGN&pay_with_bank=true');
}

/** Polls a charge that never resolved synchronously — used by the reconciliation sweep. */
export function checkPendingCharge(reference) {
  return call('GET', `/charge/${encodeURIComponent(reference)}`);
}

/**
 * HMAC-SHA512 of the raw request body, keyed by the secret key itself —
 * Paystack has no separate webhook secret. `rawBody` must be the exact bytes
 * received, before any JSON parsing, or the digest will never match.
 */
export function verifyPaystackSignature(rawBody, signatureHeader) {
  if (!signatureHeader || !env.PAYSTACK_SECRET_KEY) return false;
  const expected = crypto
    .createHmac('sha512', env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');
  return timingSafeEqual(expected, signatureHeader);
}

export default {
  initializeTransaction,
  verifyTransaction,
  initiateMobileMoneyCharge,
  initiateBankCharge,
  submitOtp,
  submitPin,
  submitBirthday,
  checkPendingCharge,
  listBanks,
  verifyPaystackSignature,
};
