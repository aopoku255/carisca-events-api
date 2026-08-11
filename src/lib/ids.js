import crypto from 'node:crypto';
import { ulid } from 'ulid';

/**
 * Identifier generation. Two rules run through all of it:
 *
 *   - Anything a participant could see or guess (QR tokens, storage keys,
 *     verification codes) carries real entropy, never a sequential id.
 *   - Anything quoted back to a human over the phone avoids characters that
 *     are easily confused: no I, L, O, U, 0 or 1.
 */

const HUMAN_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newUlid() {
  return ulid();
}

/** Random, URL-safe, unguessable. Used for QR tokens and storage keys. */
export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Fixed-length opaque token for CHAR columns (QR tokens are CHAR(32)). */
export function randomHex(length = 32) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

function humanChunk(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += HUMAN_ALPHABET[bytes[i] % HUMAN_ALPHABET.length];
  return out;
}

/**
 * Registration reference, e.g. CAR-CPD-26-K4F9PQ.
 * Short enough to read aloud at a registration desk.
 */
export function registrationReference(moduleKey, date = new Date()) {
  const yy = String(date.getUTCFullYear()).slice(-2);
  return `CAR-${String(moduleKey).toUpperCase()}-${yy}-${humanChunk(6)}`;
}

/** Payment reference. ULID keeps these sortable by creation time. */
export function paymentReference() {
  return `PAY-${ulid()}`;
}

/**
 * Certificate verification code, e.g. CARISCA-CPD-2026-000123-K4F9.
 * The sequence makes it legible and auditable; the random suffix stops the
 * space from being enumerated by walking integers.
 */
export function verificationCode(moduleKey, sequence, date = new Date()) {
  const year = date.getUTCFullYear();
  const seq = String(sequence).padStart(6, '0');
  return `CARISCA-${String(moduleKey).toUpperCase()}-${year}-${seq}-${humanChunk(4)}`;
}

/** SHA-256 hex digest — used for storing refresh and verification tokens. */
export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Constant-time comparison for secrets and signatures. */
export function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function slugify(input, suffix = true) {
  const base = String(input)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);
  return suffix ? `${base}-${humanChunk(4).toLowerCase()}` : base;
}
