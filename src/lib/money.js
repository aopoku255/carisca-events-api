/**
 * Money is always an integer count of minor units plus an explicit currency.
 * Nothing in this file returns a float, and no caller should ever construct an
 * amount by multiplying a decimal by 100 in application code — use toMinor(),
 * which reads the exponent from the currencies table.
 */
import { AppError } from './errors.js';

/** Exponents are cached per process; the currencies table changes rarely. */
let exponentCache = null;

export async function loadCurrencyExponents(sequelize) {
  const [rows] = await sequelize.query('SELECT code, exponent FROM currencies WHERE is_active = 1');
  exponentCache = new Map(rows.map((r) => [r.code, Number(r.exponent)]));
  return exponentCache;
}

export function primeCurrencyExponents(map) {
  exponentCache = map instanceof Map ? map : new Map(Object.entries(map));
}

export function exponentFor(currency) {
  if (!exponentCache) {
    throw new AppError('Currency exponents have not been loaded.', { code: 'CURRENCY_NOT_LOADED' });
  }
  const code = String(currency).toUpperCase();
  if (!exponentCache.has(code)) {
    throw new AppError(`Unsupported or inactive currency: ${code}`, {
      status: 422,
      code: 'UNSUPPORTED_CURRENCY',
    });
  }
  return exponentCache.get(code);
}

/**
 * "100.50", 100.5 → 10050 for a 2-exponent currency.
 * Parsed as a string to avoid binary floating point ever touching the value.
 */
export function toMinor(amount, currency) {
  const exponent = exponentFor(currency);
  const raw = String(amount).trim();

  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new AppError(`"${amount}" is not a valid monetary amount.`, {
      status: 422,
      code: 'INVALID_AMOUNT',
    });
  }

  const negative = raw.startsWith('-');
  const [whole, fraction = ''] = raw.replace('-', '').split('.');

  if (fraction.length > exponent) {
    throw new AppError(
      `${currency} supports at most ${exponent} decimal place${exponent === 1 ? '' : 's'}.`,
      { status: 422, code: 'INVALID_AMOUNT_PRECISION' },
    );
  }

  const padded = fraction.padEnd(exponent, '0');
  const minor = BigInt(whole + padded);
  return Number(negative ? -minor : minor);
}

/** 10050 → "100.50" for a 2-exponent currency. Presentation only. */
export function fromMinor(amountMinor, currency) {
  const exponent = exponentFor(currency);
  const negative = amountMinor < 0;
  const digits = String(Math.abs(Math.trunc(Number(amountMinor)))).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent) || '0';
  const fraction = exponent ? `.${digits.slice(digits.length - exponent)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** For API responses: the integer, the currency, and a preformatted string. */
export function serialiseMoney(amountMinor, currency) {
  if (amountMinor === null || amountMinor === undefined) return null;
  const code = String(currency).toUpperCase();
  return {
    amountMinor: Number(amountMinor),
    currency: code,
    formatted: fromMinor(amountMinor, code),
  };
}

export function assertSameCurrency(a, b) {
  if (String(a).toUpperCase() !== String(b).toUpperCase()) {
    throw new AppError(`Cannot combine amounts in ${a} and ${b}.`, {
      status: 422,
      code: 'CURRENCY_MISMATCH',
    });
  }
}

export function isFree(amountMinor) {
  return Number(amountMinor) === 0;
}
