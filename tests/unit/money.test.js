import {
  primeCurrencyExponents, toMinor, fromMinor, serialiseMoney, exponentFor,
  assertSameCurrency, isFree,
} from '../../src/lib/money.js';

beforeAll(() => {
  primeCurrencyExponents({ GHS: 2, USD: 2, NGN: 2, JPY: 0, KWD: 3 });
});

describe('converting to minor units', () => {
  test('handles the case from the brief: GHS 100.50 → 10050', () => {
    expect(toMinor('100.50', 'GHS')).toBe(10050);
  });

  test.each([
    ['0', 'GHS', 0],
    ['1', 'GHS', 100],
    ['1.5', 'GHS', 150],
    ['1.05', 'GHS', 105],
    ['999999.99', 'GHS', 99999999],
    ['250', 'JPY', 250],
    ['1.234', 'KWD', 1234],
  ])('%s %s → %i', (amount, currency, expected) => {
    expect(toMinor(amount, currency)).toBe(expected);
  });

  test('respects each currency\'s exponent rather than assuming two', () => {
    expect(exponentFor('JPY')).toBe(0);
    expect(exponentFor('KWD')).toBe(3);
    expect(toMinor('100', 'JPY')).toBe(100);
    expect(toMinor('100', 'GHS')).toBe(10000);
  });

  test('rejects more precision than the currency allows', () => {
    expect(() => toMinor('1.005', 'GHS')).toThrow(/at most 2 decimal/);
    expect(() => toMinor('1.5', 'JPY')).toThrow(/at most 0 decimal/);
  });

  test('rejects values that are not amounts', () => {
    expect(() => toMinor('abc', 'GHS')).toThrow(/not a valid monetary amount/);
    expect(() => toMinor('', 'GHS')).toThrow();
    expect(() => toMinor('1e5', 'GHS')).toThrow();
    expect(() => toMinor('1,000.00', 'GHS')).toThrow();
  });

  test('rejects an unknown currency instead of guessing', () => {
    expect(() => toMinor('10.00', 'XYZ')).toThrow(/Unsupported or inactive currency/);
  });

  /**
   * The reason this module exists. 0.1 + 0.2 !== 0.3 in binary floating point,
   * and 19.99 * 100 is 1998.9999999999998 — both of which quietly corrupt
   * money if amounts are ever handled as floats.
   */
  test('is immune to the floating-point errors that motivate integer money', () => {
    expect(toMinor('19.99', 'GHS')).toBe(1999);
    expect(Math.round(19.99 * 100)).toBe(1999);
    expect(19.99 * 100).not.toBe(1999);

    expect(toMinor('0.1', 'GHS') + toMinor('0.2', 'GHS')).toBe(30);
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  test('handles negatives, which refunds need', () => {
    expect(toMinor('-50.25', 'GHS')).toBe(-5025);
  });
});

describe('formatting back for display', () => {
  test.each([
    [10050, 'GHS', '100.50'],
    [0, 'GHS', '0.00'],
    [5, 'GHS', '0.05'],
    [100, 'JPY', '100'],
    [1234, 'KWD', '1.234'],
    [-5025, 'GHS', '-50.25'],
  ])('%i %s → %s', (minor, currency, expected) => {
    expect(fromMinor(minor, currency)).toBe(expected);
  });

  test('round-trips without drift', () => {
    for (const amount of ['0.01', '1.00', '99.99', '12345.67']) {
      expect(fromMinor(toMinor(amount, 'GHS'), 'GHS')).toBe(amount);
    }
  });

  test('serialises the integer alongside the display string', () => {
    expect(serialiseMoney(10050, 'GHS')).toEqual({
      amountMinor: 10050,
      currency: 'GHS',
      formatted: '100.50',
    });
    expect(serialiseMoney(null, 'GHS')).toBeNull();
  });
});

describe('guards', () => {
  test('refuses to combine different currencies', () => {
    expect(() => assertSameCurrency('GHS', 'USD')).toThrow(/Cannot combine/);
    expect(() => assertSameCurrency('GHS', 'ghs')).not.toThrow();
  });

  test('recognises a free event', () => {
    expect(isFree(0)).toBe(true);
    expect(isFree(1)).toBe(false);
  });
});
