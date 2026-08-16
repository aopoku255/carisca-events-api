import { jest } from '@jest/globals';

/**
 * The SMTP driver is tested against a stubbed nodemailer rather than a real
 * relay. What matters here is not that nodemailer works — it does — but that
 * we classify its failures correctly, because that classification is what
 * decides whether the outbox retries for four hours or gives up immediately.
 */

const sendMailMock = jest.fn();
const verifyMock = jest.fn();
const closeMock = jest.fn();
const createTransportMock = jest.fn(() => ({
  sendMail: sendMailMock, verify: verifyMock, close: closeMock,
}));

jest.unstable_mockModule('nodemailer', () => ({
  default: { createTransport: createTransportMock },
}));

// Imported after the mock is registered, or the real module wins.
const { sendMail, createSmtpDriver, MailDeliveryError } = await import(
  '../../src/core/notifications/channels/mail.js'
);

beforeEach(() => {
  jest.clearAllMocks();
  sendMailMock.mockResolvedValue({
    messageId: '<abc@carisca>', accepted: ['participant@example.test'], rejected: [],
  });
});

describe('the log driver', () => {
  // tests/helpers/env.js pins MAIL_DRIVER=log, so sendMail() routes here.
  test('accepts a message without contacting a server', async () => {
    const result = await sendMail({
      to: 'participant@example.test', subject: 'Hello', html: '<p>Hi</p>', text: 'Hi',
    });

    expect(result.provider).toBe('log');
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  test('refuses a message with no recipient', async () => {
    await expect(sendMail({ subject: 'Hello', text: 'Hi' })).rejects.toThrow(/recipient/i);
  });
});

describe('the smtp driver', () => {
  let driver;

  const send = (overrides = {}) => driver.send({
    from: 'CARISCA <no-reply@carisca.test>',
    to: 'participant@example.test',
    subject: 'You are registered',
    html: '<p>Confirmed</p>',
    text: 'Confirmed',
    ...overrides,
  });

  beforeEach(() => { driver = createSmtpDriver(); });

  test('returns the provider message id on success', async () => {
    const result = await send();

    expect(result).toMatchObject({ provider: 'smtp', id: '<abc@carisca>' });
    expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: 'participant@example.test',
      subject: 'You are registered',
      html: '<p>Confirmed</p>',
      text: 'Confirmed',
    }));
  });

  test('builds a pooled transport once and reuses it', async () => {
    await send();
    await send();

    expect(createTransportMock).toHaveBeenCalledTimes(1);
    expect(createTransportMock).toHaveBeenCalledWith(expect.objectContaining({ pool: true }));
  });

  test('does not open a connection until something is actually sent', () => {
    createSmtpDriver();
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  test('treats a rejected recipient as permanent even when the send resolves', async () => {
    sendMailMock.mockResolvedValue({
      messageId: '<x@carisca>', accepted: [], rejected: ['nobody@example.test'],
    });

    const err = await send().catch((e) => e);

    expect(err).toBeInstanceOf(MailDeliveryError);
    expect(err.permanent).toBe(true);
    expect(err.message).toMatch(/nobody@example.test/);
  });

  test('treats a 5xx reply as permanent — retrying cannot change the answer', async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error('550 no such user'), {
      responseCode: 550,
    }));

    const err = await send().catch((e) => e);

    expect(err).toBeInstanceOf(MailDeliveryError);
    expect(err.permanent).toBe(true);
  });

  test('treats a 4xx reply as transient so the outbox retries', async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error('451 try again later'), {
      responseCode: 451,
    }));

    const err = await send().catch((e) => e);

    expect(err.permanent).toBe(false);
  });

  test('treats a dropped connection as transient', async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
    }));

    const err = await send().catch((e) => e);

    expect(err.permanent).toBe(false);
  });

  test('verify surfaces a bad credential instead of swallowing it', async () => {
    verifyMock.mockRejectedValue(new Error('535 authentication failed'));

    await expect(driver.verify()).rejects.toThrow(/authentication failed/);
  });
});
