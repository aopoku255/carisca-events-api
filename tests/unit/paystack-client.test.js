import crypto from 'node:crypto';

/**
 * The real signature check, not mocked — this is the one piece of the
 * Paystack integration that's pure and worth testing directly rather than
 * through the mocked client the integration suite uses everywhere else.
 */

process.env.PAYSTACK_SECRET_KEY ||= 'test-paystack-secret-key';

const { verifyPaystackSignature } = await import('../../src/core/payments/paystack.client.js');
const env = (await import('../../src/config/env.js')).default;

describe('verifyPaystackSignature', () => {
  const rawBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { id: 123 } }));

  test('accepts a signature computed with the real secret over the exact bytes', () => {
    const signature = crypto.createHmac('sha512', env.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
    expect(verifyPaystackSignature(rawBody, signature)).toBe(true);
  });

  test('rejects a signature computed over a different body', () => {
    const tampered = Buffer.from(JSON.stringify({ event: 'charge.success', data: { id: 999 } }));
    const signature = crypto.createHmac('sha512', env.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
    expect(verifyPaystackSignature(tampered, signature)).toBe(false);
  });

  test('rejects a signature computed with the wrong key', () => {
    const signature = crypto.createHmac('sha512', 'not-the-real-key').update(rawBody).digest('hex');
    expect(verifyPaystackSignature(rawBody, signature)).toBe(false);
  });

  test('rejects a missing signature header', () => {
    expect(verifyPaystackSignature(rawBody, undefined)).toBe(false);
  });
});
