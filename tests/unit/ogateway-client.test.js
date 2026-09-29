import crypto from 'node:crypto';

process.env.OGATEWAY_WEBHOOK_SECRET ||= 'test-ogateway-webhook-secret';

const { verifyOgatewaySignature } = await import('../../src/core/payments/ogateway.client.js');
const env = (await import('../../src/config/env.js')).default;

describe('verifyOgatewaySignature', () => {
  const rawBody = Buffer.from(JSON.stringify({ id: 'abc', status: 'COMPLETED' }));
  const sign = (body, key) => crypto.createHmac('sha512', key).update(body).digest('hex');

  test('accepts a signature computed with the webhook secret over the exact bytes', () => {
    expect(verifyOgatewaySignature(rawBody, sign(rawBody, env.OGATEWAY_WEBHOOK_SECRET))).toBe(true);
  });

  test('rejects a signature computed over a different body', () => {
    const tampered = Buffer.from(JSON.stringify({ id: 'abc', status: 'FAILED' }));
    expect(verifyOgatewaySignature(tampered, sign(rawBody, env.OGATEWAY_WEBHOOK_SECRET))).toBe(false);
  });

  test('rejects a signature computed with the wrong key', () => {
    expect(verifyOgatewaySignature(rawBody, sign(rawBody, 'not-the-real-key'))).toBe(false);
  });

  test('rejects a missing signature header', () => {
    expect(verifyOgatewaySignature(rawBody, undefined)).toBe(false);
  });
});
