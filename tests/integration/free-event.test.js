import request from 'supertest';
import { jest } from '@jest/globals';
import {
  prepareDatabase, teardown, makeUser, authHeader, app, flushPermissionCache, models,
} from '../helpers/setup.js';
import * as registrationService from '../../src/core/registrations/registration.service.js';

jest.setTimeout(120_000);

const { Event, EventType, EventPrice, Registration, Notification } = models;

/**
 * The upcoming CARISCA CPD is free, so this is the path that actually has to
 * work on the day. A free registration must confirm immediately, take no
 * hold, involve no payment provider, and hand over a QR code at once.
 */
let server;
let cpdType;

beforeAll(async () => {
  await prepareDatabase();
  server = app();
  cpdType = await EventType.findOne({ where: { key: 'cpd' } });
});
afterAll(teardown);
beforeEach(flushPermissionCache);

let n = 0;
async function freeEvent({ capacity = null, allowWaitlist = false, requiresPayment = false } = {}) {
  n += 1;
  const event = await Event.create({
    event_type_id: cpdType.id,
    slug: `free-${Date.now()}-${n}`,
    title: `Free CPD ${n}`,
    start_at: new Date(Date.now() + 14 * 864e5),
    end_at: new Date(Date.now() + 14 * 864e5 + 5 * 3600e3),
    timezone: 'Africa/Accra',
    delivery_mode: 'HYBRID',
    country_code: 'GH',
    venue: 'KNUST',
    online_url: 'https://example.test/join',
    capacity,
    allow_waitlist: allowWaitlist,
    status: 'REGISTRATION_OPEN',
    issues_certificate: true,
    certificate_requires_payment: requiresPayment,
    attendance_rule: 'CHECK_IN',
  });
  await EventPrice.create({
    event_id: event.id, tier: 'standard', label: 'Free',
    amount_minor: 0, currency: 'GHS', is_default: true,
  });
  return event;
}

const participant = () => makeUser({ roleKey: 'participant' });

describe('a free CPD', () => {
  test('quotes as free without inventing a currency problem', async () => {
    const event = await freeEvent();
    const user = await participant();

    const res = await request(server)
      .get(`/api/v1/registrations/quote?eventId=${event.id}&attendanceMode=IN_PERSON`)
      .set(authHeader(user));

    expect(res.status).toBe(200);
    expect(res.body.data.isFree).toBe(true);
    expect(res.body.data.amount.amountMinor).toBe(0);
  });

  test('confirms immediately with no hold and no payment', async () => {
    const event = await freeEvent();
    const user = await participant();

    const res = await request(server).post('/api/v1/registrations')
      .set(authHeader(user)).send({ eventId: Number(event.id), mediaConsent: true });

    expect(res.status).toBe(201);
    expect(res.body.data.registration.status).toBe('CONFIRMED');
    expect(res.body.data.registration.holdExpiresAt).toBeNull();
    expect(res.body.data.payment).toBeNull();
    expect(res.body.data.registration.confirmedAt).toBeTruthy();
  });

  test('hands over a QR code straight away', async () => {
    const event = await freeEvent();
    const user = await participant();

    const created = await request(server).post('/api/v1/registrations')
      .set(authHeader(user)).send({ eventId: Number(event.id) });

    const qr = await request(server)
      .get(`/api/v1/registrations/${created.body.data.registration.reference}/qr`)
      .set(authHeader(user));

    expect(qr.body.data.available).toBe(true);
    expect(qr.body.data.qrToken).toHaveLength(32);
  });

  test('sends the confirmation email, not the payment one', async () => {
    const event = await freeEvent();
    const user = await participant();

    await request(server).post('/api/v1/registrations')
      .set(authHeader(user)).send({ eventId: Number(event.id) });

    const sent = await Notification.findAll({ where: { user_id: user.id } });
    const templates = sent.map((s) => s.template);

    expect(templates).toContain('registration_confirmed');
    expect(templates).not.toContain('registration_pending_payment');
  });

  test('the hold sweeper leaves free registrations alone', async () => {
    const event = await freeEvent();
    const user = await participant();
    const { registration } = await registrationService.register({ eventId: event.id, user });

    await registrationService.sweepExpiredHolds();
    await registration.reload();

    // Nothing is holding, so nothing can expire.
    expect(registration.status).toBe('CONFIRMED');
  });

  test('capacity still applies — free does not mean unlimited', async () => {
    const event = await freeEvent({ capacity: 2 });
    const users = await Promise.all([participant(), participant(), participant()]);

    const results = await Promise.allSettled(
      users.map((u) => registrationService.register({ eventId: event.id, user: u })),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.reason?.code === 'EVENT_FULL')).toHaveLength(1);
  });

  test('a waitlisted free registration is not confirmed until promoted', async () => {
    const event = await freeEvent({ capacity: 1, allowWaitlist: true });
    const [a, b] = [await participant(), await participant()];

    const first = await registrationService.register({ eventId: event.id, user: a });
    const second = await registrationService.register({ eventId: event.id, user: b });

    expect(second.status).toBe('WAITLISTED');

    await registrationService.cancel(first.registration.id, { actor: { id: a.id, email: a.email } });
    await second.registration.reload();

    // Promotion of a free place confirms outright rather than asking for money.
    expect(second.registration.status).toBe('CONFIRMED');
    expect(second.registration.hold_expires_at).toBeNull();
  });

  test('certificate eligibility cannot depend on a payment that never happens', async () => {
    // Guards against someone copying a paid event's settings onto a free one
    // and silently blocking every certificate.
    const event = await freeEvent({ requiresPayment: false });
    expect(event.certificate_requires_payment).toBe(false);

    const user = await participant();
    const { registration } = await registrationService.register({ eventId: event.id, user });
    expect(registration.isPaid()).toBe(true);
  });

  test('re-registering after cancelling still confirms immediately', async () => {
    const event = await freeEvent();
    const user = await participant();

    const first = await registrationService.register({ eventId: event.id, user });
    await registrationService.cancel(first.registration.id, { actor: { id: user.id, email: user.email } });

    const again = await registrationService.register({ eventId: event.id, user });
    expect(again.status).toBe('CONFIRMED');
    expect(await Registration.count({ where: { event_id: event.id, user_id: user.id } })).toBe(1);
  });
});
