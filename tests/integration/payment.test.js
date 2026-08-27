import request from 'supertest';
import { jest } from '@jest/globals';

/**
 * The Paystack client is mocked at the module boundary — this suite proves
 * our own routing, ownership, idempotency and status-transition logic, not
 * that Paystack's API works. `verifyPaystackSignature` is the one exception
 * (tests/unit/paystack-client.test.js exercises the real implementation);
 * here it's mocked too so a webhook test can drive both the "signed" and
 * "not signed" paths without computing a real HMAC.
 */

const initializeTransactionMock = jest.fn();
const verifyTransactionMock = jest.fn();
const initiateMobileMoneyChargeMock = jest.fn();
const initiateBankChargeMock = jest.fn();
const submitOtpMock = jest.fn();
const submitPinMock = jest.fn();
const submitBirthdayMock = jest.fn();
const checkPendingChargeMock = jest.fn();
const listBanksMock = jest.fn();
const verifyPaystackSignatureMock = jest.fn();

jest.unstable_mockModule('../../src/core/payments/paystack.client.js', () => ({
  initializeTransaction: initializeTransactionMock,
  verifyTransaction: verifyTransactionMock,
  initiateMobileMoneyCharge: initiateMobileMoneyChargeMock,
  initiateBankCharge: initiateBankChargeMock,
  submitOtp: submitOtpMock,
  submitPin: submitPinMock,
  submitBirthday: submitBirthdayMock,
  checkPendingCharge: checkPendingChargeMock,
  listBanks: listBanksMock,
  verifyPaystackSignature: verifyPaystackSignatureMock,
}));

// Imported after the mock is registered, or the real module (and its
// `PAYSTACK_SECRET_KEY` requirement) wins.
const {
  prepareDatabase, teardown, makeUser, authHeader, app, flushPermissionCache, models,
} = await import('../helpers/setup.js');

jest.setTimeout(120_000);

const {
  Event, EventType, EventPrice, Registration, Payment,
} = models;

let server;
let cpdType;

beforeAll(async () => {
  await prepareDatabase();
  server = app();
  cpdType = await EventType.findOne({ where: { key: 'cpd' } });
});
afterAll(teardown);
beforeEach(() => {
  flushPermissionCache();
  jest.clearAllMocks();
});

let seq = 0;
async function makeEvent({ amountMinor = 5000, currency = 'USD' } = {}) {
  seq += 1;
  const event = await Event.create({
    event_type_id: cpdType.id,
    slug: `pay-evt-${Date.now()}-${seq}`,
    title: `Payment Test Event ${seq}`,
    start_at: new Date(Date.now() + 7 * 864e5),
    end_at: new Date(Date.now() + 7 * 864e5 + 3 * 3600e3),
    timezone: 'Africa/Accra',
    delivery_mode: 'HYBRID',
    country_code: 'GH',
    venue: 'KNUST School of Business',
    status: 'REGISTRATION_OPEN',
    issues_certificate: false,
  });
  await EventPrice.create({
    event_id: event.id, tier: 'standard', label: 'Standard',
    amount_minor: amountMinor, currency, is_default: true,
  });
  return event;
}

const participant = () => makeUser({ roleKey: 'participant' });

async function pendingRegistration(event, user) {
  const res = await request(server).post('/api/v1/registrations')
    .set(authHeader(user)).send({ eventId: Number(event.id), mediaConsent: true });
  expect(res.body.data.registration.status).toBe('PENDING_PAYMENT');
  return res.body.data.registration.reference;
}

describe('paying by mobile money (GHS)', () => {
  test('initiate, then a successful OTP confirms the registration', async () => {
    const event = await makeEvent({ amountMinor: 15000, currency: 'GHS' });
    const user = await participant();
    const reference = await pendingRegistration(event, user);

    initiateMobileMoneyChargeMock.mockResolvedValue({ status: 'send_otp', display_text: 'Enter the OTP sent to your phone' });

    const initiate = await request(server).post('/api/v1/payments/initiate')
      .set(authHeader(user))
      .send({ registrationReference: reference, channel: 'mobile_money', mobileMoney: { phone: '0551234987', provider: 'mtn' } });

    expect(initiate.status).toBe(201);
    expect(initiate.body.data.status).toBe('send_otp');
    const paymentReference = initiate.body.data.reference;

    submitOtpMock.mockResolvedValue({ status: 'success' });

    const submit = await request(server).post(`/api/v1/payments/${paymentReference}/submit-otp`)
      .set(authHeader(user)).send({ otp: '123456' });

    expect(submit.status).toBe(200);
    expect(submit.body.data.status).toBe('success');

    const registration = await Registration.findOne({ where: { reference } });
    expect(registration.status).toBe('CONFIRMED');

    const payment = await Payment.findOne({ where: { reference: paymentReference } });
    expect(payment.status).toBe('SUCCESSFUL');
    expect(payment.paid_at).not.toBeNull();
  });

  test('a failed OTP leaves the registration pending, not cancelled', async () => {
    const event = await makeEvent({ amountMinor: 15000, currency: 'GHS' });
    const user = await participant();
    const reference = await pendingRegistration(event, user);

    initiateMobileMoneyChargeMock.mockResolvedValue({ status: 'send_otp' });
    const initiate = await request(server).post('/api/v1/payments/initiate')
      .set(authHeader(user))
      .send({ registrationReference: reference, channel: 'mobile_money', mobileMoney: { phone: '0551234987', provider: 'mtn' } });
    const paymentReference = initiate.body.data.reference;

    submitOtpMock.mockResolvedValue({ status: 'failed', message: 'Insufficient funds' });
    const submit = await request(server).post(`/api/v1/payments/${paymentReference}/submit-otp`)
      .set(authHeader(user)).send({ otp: '000000' });

    expect(submit.body.data.status).toBe('failed');

    const registration = await Registration.findOne({ where: { reference } });
    expect(registration.status).toBe('PENDING_PAYMENT');
    expect(registration.hold_expires_at).not.toBeNull();

    const payment = await Payment.findOne({ where: { reference: paymentReference } });
    expect(payment.status).toBe('FAILED');
    expect(payment.failure_reason).toBe('Insufficient funds');
  });

  test('card is refused for a GHS-priced registration', async () => {
    const event = await makeEvent({ amountMinor: 15000, currency: 'GHS' });
    const user = await participant();
    const reference = await pendingRegistration(event, user);

    const res = await request(server).post('/api/v1/payments/initiate')
      .set(authHeader(user)).send({ registrationReference: reference, channel: 'card' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHANNEL_UNAVAILABLE');
  });

  /*
   * Found by manual smoke-testing against a real (unconfigured) API: the
   * first version of initiatePayment() created the Payment row before
   * calling Paystack, and never caught the failure — a config error left it
   * stuck in PROCESSING forever, which the reconciliation sweep would then
   * poll indefinitely for a charge Paystack never actually started.
   */
  test('Paystack itself being unreachable fails the payment cleanly, not stuck processing', async () => {
    const event = await makeEvent({ amountMinor: 15000, currency: 'GHS' });
    const user = await participant();
    const reference = await pendingRegistration(event, user);

    initiateMobileMoneyChargeMock.mockRejectedValue(new Error('Online payment is not configured yet.'));

    const res = await request(server).post('/api/v1/payments/initiate')
      .set(authHeader(user))
      .send({ registrationReference: reference, channel: 'mobile_money', mobileMoney: { phone: '0551234987', provider: 'mtn' } });

    expect(res.status).toBe(500);

    const payment = await Payment.findOne({ where: { registration_id: (await Registration.findOne({ where: { reference } })).id } });
    expect(payment.status).toBe('FAILED');
    expect(payment.failure_reason).toBe('Online payment is not configured yet.');
  });
});

describe('paying by card (non-GHS)', () => {
  test('initiate returns a checkout URL, and Paystack\'s webhook confirms the registration', async () => {
    const event = await makeEvent({ amountMinor: 5000, currency: 'USD' });
    const user = await participant();
    const reference = await pendingRegistration(event, user);

    initializeTransactionMock.mockResolvedValue({
      authorization_url: 'https://checkout.paystack.com/abc123', access_code: 'abc123',
    });

    const initiate = await request(server).post('/api/v1/payments/initiate')
      .set(authHeader(user)).send({ registrationReference: reference, channel: 'card' });

    expect(initiate.status).toBe(201);
    expect(initiate.body.data.checkoutUrl).toBe('https://checkout.paystack.com/abc123');
    const paymentReference = initiate.body.data.reference;

    verifyPaystackSignatureMock.mockReturnValue(true);
    const webhookBody = JSON.stringify({
      event: 'charge.success',
      data: { id: 999111, reference: paymentReference, status: 'success' },
    });

    const webhook = await request(server).post('/api/v1/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', 'irrelevant-because-mocked')
      .send(webhookBody);

    expect(webhook.status).toBe(200);

    const registration = await Registration.findOne({ where: { reference } });
    expect(registration.status).toBe('CONFIRMED');
    const payment = await Payment.findOne({ where: { reference: paymentReference } });
    expect(payment.status).toBe('SUCCESSFUL');

    // A replay of the identical event is deduped, not reprocessed — proven by
    // it staying a no-op rather than erroring on the unique constraint.
    const replay = await request(server).post('/api/v1/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', 'irrelevant-because-mocked')
      .send(webhookBody);
    expect(replay.status).toBe(200);
  });

  test('an unsigned webhook is ignored rather than trusted', async () => {
    const event = await makeEvent({ amountMinor: 5000, currency: 'USD' });
    const user = await participant();
    const reference = await pendingRegistration(event, user);

    initializeTransactionMock.mockResolvedValue({ authorization_url: 'https://checkout.paystack.com/xyz' });
    const initiate = await request(server).post('/api/v1/payments/initiate')
      .set(authHeader(user)).send({ registrationReference: reference, channel: 'card' });
    const paymentReference = initiate.body.data.reference;

    verifyPaystackSignatureMock.mockReturnValue(false);
    const webhook = await request(server).post('/api/v1/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', 'forged')
      .send(JSON.stringify({ event: 'charge.success', data: { id: 42, reference: paymentReference } }));

    // Still 200 — Paystack must not be given a reason to retry a forged
    // event — but nothing about the registration or payment moved.
    expect(webhook.status).toBe(200);
    const registration = await Registration.findOne({ where: { reference } });
    expect(registration.status).toBe('PENDING_PAYMENT');
    const payment = await Payment.findOne({ where: { reference: paymentReference } });
    expect(payment.status).not.toBe('SUCCESSFUL');
  });

  test('mobile money is refused for a non-GHS registration', async () => {
    const event = await makeEvent({ amountMinor: 5000, currency: 'USD' });
    const user = await participant();
    const reference = await pendingRegistration(event, user);

    const res = await request(server).post('/api/v1/payments/initiate')
      .set(authHeader(user))
      .send({ registrationReference: reference, channel: 'mobile_money', mobileMoney: { phone: '0551234987', provider: 'mtn' } });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHANNEL_UNAVAILABLE');
  });
});

describe('paying by mobile money (KES, M-Pesa)', () => {
  test('an STK push left pending resolves through polling, not an OTP prompt', async () => {
    const event = await makeEvent({ amountMinor: 250000, currency: 'KES' });
    const user = await participant();
    const reference = await pendingRegistration(event, user);

    initiateMobileMoneyChargeMock.mockResolvedValue({ status: 'pending', display_text: 'Approve the prompt on your phone' });

    const initiate = await request(server).post('/api/v1/payments/initiate')
      .set(authHeader(user))
      .send({ registrationReference: reference, channel: 'mobile_money', mobileMoney: { phone: '+254722000000', provider: 'mpesa' } });

    expect(initiate.status).toBe(201);
    expect(initiate.body.data.status).toBe('pending');
    const paymentReference = initiate.body.data.reference;

    // The customer approves on their own phone — our app only ever polls.
    checkPendingChargeMock.mockResolvedValue({ status: 'success' });

    const poll = await request(server).get(`/api/v1/payments/${paymentReference}`).set(authHeader(user));
    expect(poll.status).toBe(200);
    expect(poll.body.data.status).toBe('SUCCESSFUL');
    expect(checkPendingChargeMock).toHaveBeenCalledWith(paymentReference);

    const registration = await Registration.findOne({ where: { reference } });
    expect(registration.status).toBe('CONFIRMED');
  });

  test('the wrong provider for a KES registration is refused', async () => {
    const event = await makeEvent({ amountMinor: 250000, currency: 'KES' });
    const user = await participant();
    const reference = await pendingRegistration(event, user);

    const res = await request(server).post('/api/v1/payments/initiate')
      .set(authHeader(user))
      .send({ registrationReference: reference, channel: 'mobile_money', mobileMoney: { phone: '0551234987', provider: 'mtn' } });

    expect(res.status).toBe(422);
  });

  test('bank and card are both refused for a KES-priced registration', async () => {
    const event = await makeEvent({ amountMinor: 250000, currency: 'KES' });
    const user = await participant();
    const reference = await pendingRegistration(event, user);

    const bank = await request(server).post('/api/v1/payments/initiate')
      .set(authHeader(user))
      .send({ registrationReference: reference, channel: 'bank', bank: { code: '057', accountNumber: '0000000000' } });
    expect(bank.status).toBe(409);

    const card = await request(server).post('/api/v1/payments/initiate')
      .set(authHeader(user)).send({ registrationReference: reference, channel: 'card' });
    expect(card.status).toBe(409);
  });
});

describe('paying by bank (NGN, Pay with Bank)', () => {
  test('a birthday challenge, then an OTP, confirms the registration', async () => {
    const event = await makeEvent({ amountMinor: 800000, currency: 'NGN' });
    const user = await participant();
    const reference = await pendingRegistration(event, user);

    initiateBankChargeMock.mockResolvedValue({ status: 'send_birthday' });
    const initiate = await request(server).post('/api/v1/payments/initiate')
      .set(authHeader(user))
      .send({ registrationReference: reference, channel: 'bank', bank: { code: '057', accountNumber: '0000000000' } });

    expect(initiate.status).toBe(201);
    expect(initiate.body.data.status).toBe('send_birthday');
    const paymentReference = initiate.body.data.reference;

    submitBirthdayMock.mockResolvedValue({ status: 'send_otp' });
    const birthday = await request(server).post(`/api/v1/payments/${paymentReference}/submit-birthday`)
      .set(authHeader(user)).send({ birthday: '1990-05-14' });
    expect(birthday.body.data.status).toBe('send_otp');
    expect(submitBirthdayMock).toHaveBeenCalledWith({ reference: paymentReference, birthday: '1990-05-14' });

    submitOtpMock.mockResolvedValue({ status: 'success' });
    const otp = await request(server).post(`/api/v1/payments/${paymentReference}/submit-otp`)
      .set(authHeader(user)).send({ otp: '123456' });
    expect(otp.body.data.status).toBe('success');

    const registration = await Registration.findOne({ where: { reference } });
    expect(registration.status).toBe('CONFIRMED');
  });

  // Paystack's own ordering of birthday vs OTP isn't documented anywhere
  // reachable — this proves the same code path confirms a registration when
  // no birthday is ever asked for, i.e. nothing here assumes a fixed order.
  test('no birthday challenge at all still confirms the registration', async () => {
    const event = await makeEvent({ amountMinor: 800000, currency: 'NGN' });
    const user = await participant();
    const reference = await pendingRegistration(event, user);

    initiateBankChargeMock.mockResolvedValue({ status: 'send_otp' });
    const initiate = await request(server).post('/api/v1/payments/initiate')
      .set(authHeader(user))
      .send({ registrationReference: reference, channel: 'bank', bank: { code: '057', accountNumber: '0000000000' } });
    const paymentReference = initiate.body.data.reference;

    submitOtpMock.mockResolvedValue({ status: 'success' });
    const otp = await request(server).post(`/api/v1/payments/${paymentReference}/submit-otp`)
      .set(authHeader(user)).send({ otp: '123456' });
    expect(otp.body.data.status).toBe('success');

    const registration = await Registration.findOne({ where: { reference } });
    expect(registration.status).toBe('CONFIRMED');
  });

  test('mobile money and card are both refused for an NGN-priced registration', async () => {
    const event = await makeEvent({ amountMinor: 800000, currency: 'NGN' });
    const user = await participant();
    const reference = await pendingRegistration(event, user);

    const mobileMoney = await request(server).post('/api/v1/payments/initiate')
      .set(authHeader(user))
      .send({ registrationReference: reference, channel: 'mobile_money', mobileMoney: { phone: '0551234987', provider: 'mtn' } });
    expect(mobileMoney.status).toBe(409);

    const card = await request(server).post('/api/v1/payments/initiate')
      .set(authHeader(user)).send({ registrationReference: reference, channel: 'card' });
    expect(card.status).toBe(409);
  });

  test('a missing account number is rejected before Paystack is ever called', async () => {
    const event = await makeEvent({ amountMinor: 800000, currency: 'NGN' });
    const user = await participant();
    const reference = await pendingRegistration(event, user);

    const res = await request(server).post('/api/v1/payments/initiate')
      .set(authHeader(user))
      .send({ registrationReference: reference, channel: 'bank', bank: { code: '057' } });

    expect(res.status).toBe(422);
    expect(initiateBankChargeMock).not.toHaveBeenCalled();
  });
});

describe('GET /payments/banks', () => {
  test('proxies Paystack\'s bank list', async () => {
    const user = await participant();
    listBanksMock.mockResolvedValue([{ name: 'Access Bank', code: '044' }]);

    const res = await request(server).get('/api/v1/payments/banks').set(authHeader(user));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ name: 'Access Bank', code: '044' }]);
  });
});

describe('ownership', () => {
  test('someone else cannot initiate a payment on your registration', async () => {
    const event = await makeEvent();
    const user = await participant();
    const stranger = await participant();
    const reference = await pendingRegistration(event, user);

    const res = await request(server).post('/api/v1/payments/initiate')
      .set(authHeader(stranger)).send({ registrationReference: reference, channel: 'card' });

    expect(res.status).toBe(403);
  });

  test('someone else cannot poll or submit an OTP for your payment', async () => {
    const event = await makeEvent({ amountMinor: 15000, currency: 'GHS' });
    const user = await participant();
    const stranger = await participant();
    const reference = await pendingRegistration(event, user);

    initiateMobileMoneyChargeMock.mockResolvedValue({ status: 'send_otp' });
    const initiate = await request(server).post('/api/v1/payments/initiate')
      .set(authHeader(user))
      .send({ registrationReference: reference, channel: 'mobile_money', mobileMoney: { phone: '0551234987', provider: 'mtn' } });
    const paymentReference = initiate.body.data.reference;

    const poll = await request(server).get(`/api/v1/payments/${paymentReference}`).set(authHeader(stranger));
    expect(poll.status).toBe(403);

    const otp = await request(server).post(`/api/v1/payments/${paymentReference}/submit-otp`)
      .set(authHeader(stranger)).send({ otp: '123456' });
    expect(otp.status).toBe(403);
  });
});
