import request from 'supertest';
import { jest } from '@jest/globals';
import {
  prepareDatabase, teardown, makeUser, authHeader, app, flushPermissionCache, models, sequelize,
} from '../helpers/setup.js';
import * as registrationService from '../../src/core/registrations/registration.service.js';
import { dispatchOnce } from '../../src/jobs/workers/notification-dispatcher.js';

jest.setTimeout(120_000);

const { Event, EventType, EventPrice, Registration, RegistrationQuestion, Notification } = models;

let server;
let cpdType;

beforeAll(async () => {
  await prepareDatabase();
  server = app();
  cpdType = await EventType.findOne({ where: { key: 'cpd' } });
});
afterAll(teardown);
beforeEach(flushPermissionCache);

let seq = 0;
async function makeEvent({
  capacity = null, virtualCapacity = null, allowWaitlist = false,
  amountMinor = 5000, currency = 'USD', status = 'REGISTRATION_OPEN',
  deliveryMode = 'HYBRID', holdHours = null,
} = {}) {
  seq += 1;
  const event = await Event.create({
    event_type_id: cpdType.id,
    slug: `evt-${Date.now()}-${seq}`,
    title: `Test CPD ${seq}`,
    start_at: new Date(Date.now() + 7 * 864e5),
    end_at: new Date(Date.now() + 8 * 864e5),
    timezone: 'Africa/Accra',
    delivery_mode: deliveryMode,
    country_code: 'GH',
    venue: 'KNUST School of Business',
    online_url: 'https://example.test/join',
    capacity,
    virtual_capacity: virtualCapacity,
    allow_waitlist: allowWaitlist,
    payment_hold_hours: holdHours,
    status,
  });
  await EventPrice.create({
    event_id: event.id, tier: 'standard', label: 'Standard',
    amount_minor: amountMinor, currency, is_default: true,
  });
  return event;
}

const participant = () => makeUser({ roleKey: 'participant' });

describe('registering', () => {
  test('a free event confirms immediately', async () => {
    const event = await makeEvent({ amountMinor: 0 });
    const user = await participant();

    const res = await request(server).post('/api/v1/registrations')
      .set(authHeader(user))
      .send({ eventId: Number(event.id), attendanceMode: 'IN_PERSON', mediaConsent: true });

    expect(res.status).toBe(201);
    expect(res.body.data.registration.status).toBe('CONFIRMED');
    expect(res.body.data.payment).toBeNull();
    expect(res.body.data.registration.reference).toMatch(/^CAR-CPD-\d{2}-[A-Z0-9]{6}$/);
  });

  test('an incomplete profile is refused before anything else is checked', async () => {
    const event = await makeEvent({ amountMinor: 0 });
    const user = await makeUser({ roleKey: 'participant', phone: null, organization: null });

    const res = await request(server).post('/api/v1/registrations')
      .set(authHeader(user))
      .send({ eventId: Number(event.id), attendanceMode: 'IN_PERSON', mediaConsent: true });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROFILE_INCOMPLETE');
    expect(res.body.error.details.missingFields).toEqual(expect.arrayContaining(['phone', 'organization']));
    // Country/job title/position/sector were left at makeUser()'s complete
    // defaults — only the two explicitly nulled fields should be reported.
    expect(res.body.error.details.missingFields).toHaveLength(2);
  });

  test('a complete profile registers normally', async () => {
    const event = await makeEvent({ amountMinor: 0 });
    const user = await makeUser({ roleKey: 'participant' });

    const res = await request(server).post('/api/v1/registrations')
      .set(authHeader(user))
      .send({ eventId: Number(event.id), attendanceMode: 'IN_PERSON', mediaConsent: true });

    expect(res.status).toBe(201);
    expect(res.body.data.registration.status).toBe('CONFIRMED');
  });

  test('a paid event holds the place pending payment', async () => {
    const event = await makeEvent({ amountMinor: 5000, currency: 'USD' });
    const user = await participant();

    const res = await request(server).post('/api/v1/registrations')
      .set(authHeader(user))
      .send({ eventId: Number(event.id), attendanceMode: 'IN_PERSON' });

    expect(res.status).toBe(201);
    expect(res.body.data.registration.status).toBe('PENDING_PAYMENT');
    expect(res.body.data.registration.holdExpiresAt).toBeTruthy();
    expect(res.body.data.payment.amount.formatted).toBe('50.00');
  });

  test('the per-event hold window overrides the default', async () => {
    const event = await makeEvent({ holdHours: 48 });
    const user = await participant();

    const res = await request(server).post('/api/v1/registrations')
      .set(authHeader(user)).send({ eventId: Number(event.id) });

    const hours = (new Date(res.body.data.registration.holdExpiresAt) - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(47);
    expect(hours).toBeLessThan(49);
  });

  test('registering twice is refused', async () => {
    const event = await makeEvent();
    const user = await participant();
    const body = { eventId: Number(event.id) };

    expect((await request(server).post('/api/v1/registrations').set(authHeader(user)).send(body)).status).toBe(201);

    const second = await request(server).post('/api/v1/registrations').set(authHeader(user)).send(body);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_REGISTERED');
  });

  test('cancelling then re-registering reuses the row and keeps the history', async () => {
    const event = await makeEvent({ amountMinor: 0 });
    const user = await participant();
    const body = { eventId: Number(event.id) };

    const first = await request(server).post('/api/v1/registrations').set(authHeader(user)).send(body);
    const reference = first.body.data.registration.reference;

    await request(server).post(`/api/v1/registrations/${reference}/cancel`)
      .set(authHeader(user)).send({ reason: 'Changed my mind' });

    const again = await request(server).post('/api/v1/registrations').set(authHeader(user)).send(body);
    expect(again.status).toBe(201);

    // One row, not two — the unique index on (event_id, user_id) holds.
    expect(await Registration.count({ where: { event_id: event.id, user_id: user.id } })).toBe(1);

    const history = await models.RegistrationStatusHistory.findAll({
      where: { registration_id: first.body.data.registration.id },
      order: [['id', 'ASC']],
    });
    expect(history.map((h) => h.to_status)).toEqual(['CONFIRMED', 'CANCELLED', 'CONFIRMED']);
  });

  test('registration is refused when the event is not open', async () => {
    const event = await makeEvent({ status: 'DRAFT' });
    const user = await participant();

    const res = await request(server).post('/api/v1/registrations')
      .set(authHeader(user)).send({ eventId: Number(event.id) });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REGISTRATION_CLOSED');
  });

  test('a cancelled event refuses registration with its own reason', async () => {
    const event = await makeEvent();
    await event.update({ status: 'CANCELLED' });
    const user = await participant();

    const res = await request(server).post('/api/v1/registrations')
      .set(authHeader(user)).send({ eventId: Number(event.id) });

    expect(res.body.error.code).toBe('EVENT_CANCELLED');
  });

  test('virtual attendance is refused for an in-person-only event', async () => {
    const event = await makeEvent({ deliveryMode: 'OFFLINE' });
    const user = await participant();

    const res = await request(server).post('/api/v1/registrations')
      .set(authHeader(user)).send({ eventId: Number(event.id), attendanceMode: 'VIRTUAL' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MODE_UNAVAILABLE');
  });

  test('anonymous callers cannot register', async () => {
    const event = await makeEvent();
    expect((await request(server).post('/api/v1/registrations')
      .send({ eventId: Number(event.id) })).status).toBe(401);
  });
});

/**
 * The reason the event row is locked FOR UPDATE before capacity is counted.
 * Without it, concurrent requests all read "one seat left" and all succeed.
 */
describe('capacity under concurrency', () => {
  test('twenty simultaneous registrations for five seats fill exactly five', async () => {
    const event = await makeEvent({ capacity: 5, amountMinor: 0 });
    const users = await Promise.all(Array.from({ length: 20 }, () => participant()));

    const results = await Promise.allSettled(
      users.map((u) => registrationService.register({
        eventId: event.id, user: u, attendanceMode: 'IN_PERSON',
      })),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const full = results.filter((r) => r.status === 'rejected' && r.reason?.code === 'EVENT_FULL');

    expect(succeeded).toHaveLength(5);
    expect(full).toHaveLength(15);

    const confirmed = await Registration.count({
      where: { event_id: event.id, status: 'CONFIRMED' },
    });
    expect(confirmed).toBe(5);
  });

  test('a pending payment still occupies its seat', async () => {
    const event = await makeEvent({ capacity: 1, amountMinor: 5000 });
    const [first, second] = [await participant(), await participant()];

    await registrationService.register({ eventId: event.id, user: first });

    // The seat is held even though nothing has been paid yet.
    await expect(registrationService.register({ eventId: event.id, user: second }))
      .rejects.toMatchObject({ code: 'EVENT_FULL' });
  });

  test('an expired hold releases the seat', async () => {
    const event = await makeEvent({ capacity: 1, amountMinor: 5000 });
    const [first, second] = [await participant(), await participant()];

    const { registration } = await registrationService.register({ eventId: event.id, user: first });

    // Backdate the hold rather than waiting thirty minutes.
    await registration.update({ hold_expires_at: new Date(Date.now() - 1000) });

    const result = await registrationService.register({ eventId: event.id, user: second });
    expect(result.status).toBe('PENDING_PAYMENT');
  });

  test('in-person and virtual capacity are counted separately', async () => {
    const event = await makeEvent({ capacity: 1, virtualCapacity: 2, amountMinor: 0 });
    const users = await Promise.all([participant(), participant(), participant()]);

    await registrationService.register({ eventId: event.id, user: users[0], attendanceMode: 'IN_PERSON' });

    // In-person is full…
    await expect(registrationService.register({
      eventId: event.id, user: users[1], attendanceMode: 'IN_PERSON',
    })).rejects.toMatchObject({ code: 'EVENT_FULL' });

    // …but virtual places remain.
    const virtual = await registrationService.register({
      eventId: event.id, user: users[1], attendanceMode: 'VIRTUAL',
    });
    expect(virtual.status).toBe('CONFIRMED');
  });

  test('an unlimited event never fills', async () => {
    const event = await makeEvent({ capacity: null, amountMinor: 0 });
    const users = await Promise.all(Array.from({ length: 8 }, () => participant()));

    const results = await Promise.allSettled(
      users.map((u) => registrationService.register({ eventId: event.id, user: u })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(8);
  });
});

describe('waitlist', () => {
  test('registrations beyond capacity are waitlisted when enabled', async () => {
    const event = await makeEvent({ capacity: 1, allowWaitlist: true, amountMinor: 0 });
    const [a, b] = [await participant(), await participant()];

    expect((await registrationService.register({ eventId: event.id, user: a })).status).toBe('CONFIRMED');
    expect((await registrationService.register({ eventId: event.id, user: b })).status).toBe('WAITLISTED');
  });

  test('a cancellation promotes the next person in line', async () => {
    const event = await makeEvent({ capacity: 1, allowWaitlist: true, amountMinor: 0 });
    const [a, b] = [await participant(), await participant()];

    const first = await registrationService.register({ eventId: event.id, user: a });
    const second = await registrationService.register({ eventId: event.id, user: b });
    expect(second.status).toBe('WAITLISTED');

    await registrationService.cancel(first.registration.id, { actor: { id: a.id, email: a.email } });

    await second.registration.reload();
    expect(second.registration.status).toBe('CONFIRMED');
  });

  test('promotion is oldest-first', async () => {
    const event = await makeEvent({ capacity: 1, allowWaitlist: true, amountMinor: 0 });
    const holder = await participant();
    const first = await registrationService.register({ eventId: event.id, user: holder });

    const waiting = [];
    for (const _ of [1, 2, 3]) {
      // eslint-disable-next-line no-await-in-loop
      const u = await participant();
      // eslint-disable-next-line no-await-in-loop
      waiting.push(await registrationService.register({ eventId: event.id, user: u }));
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 15); });
    }

    await registrationService.cancel(first.registration.id, { actor: { id: holder.id, email: holder.email } });

    await Promise.all(waiting.map((w) => w.registration.reload()));
    expect(waiting.map((w) => w.registration.status)).toEqual(['CONFIRMED', 'WAITLISTED', 'WAITLISTED']);
  });
});

describe('the hold sweeper', () => {
  test('releases lapsed holds and promotes the waitlist', async () => {
    const event = await makeEvent({ capacity: 1, allowWaitlist: true, amountMinor: 5000 });
    const [a, b] = [await participant(), await participant()];

    const holder = await registrationService.register({ eventId: event.id, user: a });
    const waiter = await registrationService.register({ eventId: event.id, user: b });
    expect(waiter.status).toBe('WAITLISTED');

    await holder.registration.update({ hold_expires_at: new Date(Date.now() - 60_000) });

    const { released } = await registrationService.sweepExpiredHolds();
    expect(released).toBeGreaterThanOrEqual(1);

    await holder.registration.reload();
    await waiter.registration.reload();

    expect(holder.registration.status).toBe('CANCELLED');
    // Cancelled, not deleted — the participant can see what happened.
    expect(holder.registration.cancellation_reason).toMatch(/not completed/i);
    expect(waiter.registration.status).toBe('PENDING_PAYMENT');
  });

  test('leaves live holds alone', async () => {
    const event = await makeEvent({ amountMinor: 5000 });
    const user = await participant();
    const { registration } = await registrationService.register({ eventId: event.id, user });

    await registrationService.sweepExpiredHolds();
    await registration.reload();

    expect(registration.status).toBe('PENDING_PAYMENT');
  });
});

describe('dynamic registration questions', () => {
  async function withQuestions(questions) {
    const event = await makeEvent({ amountMinor: 0 });
    await RegistrationQuestion.bulkCreate(
      questions.map((q, i) => ({ event_id: event.id, sort_order: i * 10, ...q })),
    );
    return event;
  }

  test('a required question must be answered', async () => {
    const event = await withQuestions([
      { label: 'What is your organization?', type: 'TEXT', is_required: true },
    ]);
    const user = await participant();

    const res = await request(server).post('/api/v1/registrations')
      .set(authHeader(user)).send({ eventId: Number(event.id), answers: {} });

    expect(res.status).toBe(422);
    expect(res.body.error.details[0].message).toMatch(/is required/);
  });

  test('answers are stored and read back with their labels', async () => {
    const event = await withQuestions([
      { label: 'Dietary requirements', type: 'TEXT', is_required: false },
      { label: 'Years of experience', type: 'NUMBER', is_required: true },
    ]);
    const [dietary, years] = await RegistrationQuestion.findAll({
      where: { event_id: event.id }, order: [['sort_order', 'ASC']],
    });
    const user = await participant();

    const res = await request(server).post('/api/v1/registrations')
      .set(authHeader(user))
      .send({
        eventId: Number(event.id),
        answers: { [dietary.id]: 'Vegetarian', [years.id]: '7' },
      });
    expect(res.status).toBe(201);

    const detail = await request(server)
      .get(`/api/v1/registrations/${res.body.data.registration.reference}`)
      .set(authHeader(user));

    const answers = detail.body.data.answers;
    expect(answers).toHaveLength(2);
    expect(answers.find((a) => a.label === 'Dietary requirements').value).toBe('Vegetarian');
  });

  test('a value of the wrong type is rejected', async () => {
    const event = await withQuestions([{ label: 'Years', type: 'NUMBER', is_required: true }]);
    const [q] = await RegistrationQuestion.findAll({ where: { event_id: event.id } });
    const user = await participant();

    const res = await request(server).post('/api/v1/registrations')
      .set(authHeader(user))
      .send({ eventId: Number(event.id), answers: { [q.id]: 'not a number' } });

    expect(res.status).toBe(422);
    expect(res.body.error.details[0].message).toMatch(/must be a number/);
  });

  test('a choice outside the configured options is rejected', async () => {
    const event = await withQuestions([{
      label: 'T-shirt size', type: 'SELECT', is_required: true,
      options: [{ value: 'S', label: 'Small' }, { value: 'M', label: 'Medium' }],
    }]);
    const [q] = await RegistrationQuestion.findAll({ where: { event_id: event.id } });
    const user = await participant();

    const res = await request(server).post('/api/v1/registrations')
      .set(authHeader(user))
      .send({ eventId: Number(event.id), answers: { [q.id]: 'XXL' } });

    expect(res.status).toBe(422);
    expect(res.body.error.details[0].message).toMatch(/one of the available options/);
  });

  test('an answer to another event\'s question is rejected, not silently dropped', async () => {
    const other = await withQuestions([{ label: 'Foreign question', type: 'TEXT', is_required: false }]);
    const [foreign] = await RegistrationQuestion.findAll({ where: { event_id: other.id } });
    const event = await makeEvent({ amountMinor: 0 });
    const user = await participant();

    const res = await request(server).post('/api/v1/registrations')
      .set(authHeader(user))
      .send({ eventId: Number(event.id), answers: { [foreign.id]: 'sneaky' } });

    expect(res.status).toBe(422);
    expect(res.body.error.details[0].message).toMatch(/does not belong to this event/);
  });
});

describe('access to a registration', () => {
  test('a participant cannot read someone else\'s registration', async () => {
    const event = await makeEvent({ amountMinor: 0 });
    const owner = await participant();
    const stranger = await participant();

    const res = await request(server).post('/api/v1/registrations')
      .set(authHeader(owner)).send({ eventId: Number(event.id) });
    const reference = res.body.data.registration.reference;

    expect((await request(server).get(`/api/v1/registrations/${reference}`)
      .set(authHeader(stranger))).status).toBe(403);
    expect((await request(server).get(`/api/v1/registrations/${reference}`)
      .set(authHeader(owner))).status).toBe(200);
  });

  test('staff with the permission can, staff without it cannot', async () => {
    const event = await makeEvent({ amountMinor: 0 });
    const owner = await participant();
    const res = await request(server).post('/api/v1/registrations')
      .set(authHeader(owner)).send({ eventId: Number(event.id) });
    const reference = res.body.data.registration.reference;

    const manager = await makeUser({ roleKey: 'manager', isStaff: true });
    const itAdmin = await makeUser({ roleKey: 'it_admin', isStaff: true });

    expect((await request(server).get(`/api/v1/registrations/${reference}`)
      .set(authHeader(manager))).status).toBe(200);
    // IT administrators hold no participant-data permission.
    expect((await request(server).get(`/api/v1/registrations/${reference}`)
      .set(authHeader(itAdmin))).status).toBe(403);
  });

  test('the QR token is owner-only and never appears in a list', async () => {
    const event = await makeEvent({ amountMinor: 0 });
    const owner = await participant();
    const stranger = await participant();

    const res = await request(server).post('/api/v1/registrations')
      .set(authHeader(owner)).send({ eventId: Number(event.id) });
    const reference = res.body.data.registration.reference;

    expect(JSON.stringify(res.body)).not.toContain('qrToken');

    const mine = await request(server).get('/api/v1/registrations/mine').set(authHeader(owner));
    expect(JSON.stringify(mine.body)).not.toContain('qrToken');

    const qr = await request(server).get(`/api/v1/registrations/${reference}/qr`).set(authHeader(owner));
    expect(qr.status).toBe(200);
    expect(qr.body.data.qrToken).toHaveLength(32);

    expect((await request(server).get(`/api/v1/registrations/${reference}/qr`)
      .set(authHeader(stranger))).status).toBe(403);
  });
});

describe('waiving a fee', () => {
  const manager = () => makeUser({ roleKey: 'manager', isStaff: true });

  test('reducing to free confirms a pending registration', async () => {
    const event = await makeEvent({ amountMinor: 5000, currency: 'USD' });
    const user = await participant();
    const staff = await manager();

    const created = await request(server).post('/api/v1/registrations')
      .set(authHeader(user)).send({ eventId: Number(event.id) });
    const reference = created.body.data.registration.reference;
    expect(created.body.data.registration.status).toBe('PENDING_PAYMENT');

    const res = await request(server).post(`/api/v1/registrations/${reference}/waive`)
      .set(authHeader(staff)).send({ amount: '0', reason: 'Sponsored place' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CONFIRMED');
    expect(res.body.data.amount.amountMinor).toBe(0);
    expect(res.body.data.originalAmount.amountMinor).toBe(5000);
    expect(res.body.data.waiverReason).toBe('Sponsored place');
    expect(res.body.data.waivedBy.name).toContain(staff.first_name);
    expect(res.body.data.confirmedAt).toBeTruthy();

    const history = await models.RegistrationStatusHistory.findAll({
      where: { registration_id: created.body.data.registration.id },
      order: [['id', 'ASC']],
    });
    expect(history.map((h) => h.to_status)).toEqual(['PENDING_PAYMENT', 'CONFIRMED']);
  });

  test('a partial reduction leaves it pending payment for the smaller amount', async () => {
    const event = await makeEvent({ amountMinor: 10000, currency: 'USD' });
    const user = await participant();
    const staff = await manager();

    const created = await request(server).post('/api/v1/registrations')
      .set(authHeader(user)).send({ eventId: Number(event.id) });
    const reference = created.body.data.registration.reference;

    const res = await request(server).post(`/api/v1/registrations/${reference}/waive`)
      .set(authHeader(staff)).send({ amount: '40.00' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('PENDING_PAYMENT');
    expect(res.body.data.amount.formatted).toBe('40.00');
    expect(res.body.data.originalAmount.formatted).toBe('100.00');
  });

  test('cannot set the fee above what was originally quoted', async () => {
    const event = await makeEvent({ amountMinor: 5000, currency: 'USD' });
    const user = await participant();
    const staff = await manager();

    const created = await request(server).post('/api/v1/registrations')
      .set(authHeader(user)).send({ eventId: Number(event.id) });
    const reference = created.body.data.registration.reference;

    const res = await request(server).post(`/api/v1/registrations/${reference}/waive`)
      .set(authHeader(staff)).send({ amount: '9999.00' });

    expect(res.status).toBe(422);
    expect(res.body.error.details[0].field).toBe('amount');
  });

  test('a second waiver still measures against the original amount, not the last edit', async () => {
    const event = await makeEvent({ amountMinor: 10000, currency: 'USD' });
    const user = await participant();
    const staff = await manager();

    const created = await request(server).post('/api/v1/registrations')
      .set(authHeader(user)).send({ eventId: Number(event.id) });
    const reference = created.body.data.registration.reference;

    await request(server).post(`/api/v1/registrations/${reference}/waive`)
      .set(authHeader(staff)).send({ amount: '40.00' });

    // Restoring most of the way back up is allowed — up to the ORIGINAL
    // 100.00, not the 40.00 it was most recently set to.
    const restored = await request(server).post(`/api/v1/registrations/${reference}/waive`)
      .set(authHeader(staff)).send({ amount: '90.00' });

    expect(restored.status).toBe(200);
    expect(restored.body.data.amount.formatted).toBe('90.00');
    expect(restored.body.data.originalAmount.formatted).toBe('100.00');

    // But it can still never exceed that original ceiling.
    const overshoot = await request(server).post(`/api/v1/registrations/${reference}/waive`)
      .set(authHeader(staff)).send({ amount: '150.00' });
    expect(overshoot.status).toBe(422);
  });

  test('resubmitting the same amount is refused as a no-op', async () => {
    const event = await makeEvent({ amountMinor: 5000, currency: 'USD' });
    const user = await participant();
    const staff = await manager();

    const created = await request(server).post('/api/v1/registrations')
      .set(authHeader(user)).send({ eventId: Number(event.id) });
    const reference = created.body.data.registration.reference;

    const res = await request(server).post(`/api/v1/registrations/${reference}/waive`)
      .set(authHeader(staff)).send({ amount: '50.00' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_CHANGE');
  });

  test('a cancelled registration has nothing left to waive', async () => {
    const event = await makeEvent({ amountMinor: 5000, currency: 'USD' });
    const user = await participant();
    const staff = await manager();

    const created = await request(server).post('/api/v1/registrations')
      .set(authHeader(user)).send({ eventId: Number(event.id) });
    const reference = created.body.data.registration.reference;

    await request(server).post(`/api/v1/registrations/${reference}/cancel`)
      .set(authHeader(user)).send({});

    const res = await request(server).post(`/api/v1/registrations/${reference}/waive`)
      .set(authHeader(staff)).send({ amount: '0' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REGISTRATION_TERMINAL');
  });

  test('staff without the permission cannot waive, and a participant cannot waive their own fee', async () => {
    const event = await makeEvent({ amountMinor: 5000, currency: 'USD' });
    const user = await participant();
    const itAdmin = await makeUser({ roleKey: 'it_admin', isStaff: true });

    const created = await request(server).post('/api/v1/registrations')
      .set(authHeader(user)).send({ eventId: Number(event.id) });
    const reference = created.body.data.registration.reference;

    expect((await request(server).post(`/api/v1/registrations/${reference}/waive`)
      .set(authHeader(itAdmin)).send({ amount: '0' })).status).toBe(403);
    expect((await request(server).post(`/api/v1/registrations/${reference}/waive`)
      .set(authHeader(user)).send({ amount: '0' })).status).toBe(403);
  });

  test('who granted the waiver is visible to staff but not to the participant themselves', async () => {
    const event = await makeEvent({ amountMinor: 5000, currency: 'USD' });
    const user = await participant();
    const staff = await manager();

    const created = await request(server).post('/api/v1/registrations')
      .set(authHeader(user)).send({ eventId: Number(event.id) });
    const reference = created.body.data.registration.reference;

    await request(server).post(`/api/v1/registrations/${reference}/waive`)
      .set(authHeader(staff)).send({ amount: '0', reason: 'Hardship' });

    const asOwner = await request(server).get(`/api/v1/registrations/${reference}`)
      .set(authHeader(user));
    expect(asOwner.body.data.waiverReason).toBe('Hardship');
    expect(asOwner.body.data.waivedBy).toBeUndefined();

    const asStaff = await request(server).get(`/api/v1/registrations/${reference}`)
      .set(authHeader(staff));
    expect(asStaff.body.data.waivedBy.name).toContain(staff.first_name);
  });
});

describe('the notification outbox', () => {
  /** The dispatcher works in batches, so drain what earlier tests queued. */
  async function drainOutbox() {
    for (let i = 0; i < 30; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { processed } = await dispatchOnce({ limit: 100 });
      if (processed === 0) return;
    }
  }

  test('registering queues an email, and the dispatcher sends it', async () => {
    await drainOutbox();

    const event = await makeEvent({ amountMinor: 0 });
    const user = await participant();

    await request(server).post('/api/v1/registrations')
      .set(authHeader(user)).send({ eventId: Number(event.id) });

    const queued = await Notification.findOne({
      where: { user_id: user.id, template: 'registration_confirmed' },
    });
    expect(queued.status).toBe('PENDING');

    const result = await dispatchOnce();
    expect(result.sent).toBeGreaterThanOrEqual(1);

    await queued.reload();
    expect(queued.status).toBe('SENT');
    expect(queued.sent_at).toBeTruthy();
  });

  test('a delivery failure is retried with backoff, not lost', async () => {
    const user = await participant();
    const notification = await Notification.create({
      user_id: user.id,
      channel: 'EMAIL',
      template: 'registration_confirmed',
      to_address: null, // no recipient — delivery will throw
      subject: 'Broken',
      status: 'PENDING',
      next_attempt_at: new Date(),
    });

    await dispatchOnce({ limit: 100 });
    await notification.reload();

    expect(notification.status).toBe('PENDING'); // requeued, not failed
    expect(notification.attempts).toBe(1);
    expect(notification.last_error).toMatch(/recipient/i);
    expect(new Date(notification.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
  });

  test('gives up after the maximum attempts rather than retrying forever', async () => {
    const user = await participant();
    const notification = await Notification.create({
      user_id: user.id,
      channel: 'EMAIL',
      template: 'registration_confirmed',
      to_address: null,
      status: 'PENDING',
      attempts: 4, // one short of the limit
      next_attempt_at: new Date(),
    });

    await dispatchOnce({ limit: 100 });
    await notification.reload();

    expect(notification.status).toBe('FAILED');
    expect(notification.next_attempt_at).toBeNull();
  });

  /**
   * A worker that dies mid-batch leaves rows in SENDING, which the dispatcher
   * never queries. Without recovery those notifications are lost silently.
   */
  test('notifications stranded by a crashed worker are reclaimed', async () => {
    const user = await participant();
    const stranded = await Notification.create({
      user_id: user.id,
      channel: 'EMAIL',
      template: 'registration_confirmed',
      to_address: user.email,
      subject: 'Stranded',
      status: 'SENDING',
      next_attempt_at: new Date(),
    });

    // Backdate so it looks abandoned rather than in flight. Raw SQL because
    // Sequelize manages updated_at itself and would overwrite it.
    await sequelize.query(
      'UPDATE notifications SET updated_at = DATE_SUB(NOW(3), INTERVAL 20 MINUTE) WHERE id = :id',
      { replacements: { id: stranded.id } },
    );

    await dispatchOnce({ limit: 100 });
    await stranded.reload();

    expect(stranded.status).toBe('SENT');
  });

  test('a rolled-back registration sends nothing', async () => {
    const event = await makeEvent({ status: 'DRAFT' });
    const user = await participant();

    await request(server).post('/api/v1/registrations')
      .set(authHeader(user)).send({ eventId: Number(event.id) });

    // The transaction rolled back, so the outbox row went with it.
    expect(await Notification.count({
      where: { user_id: user.id, resource_type: 'registration' },
    })).toBe(0);
  });
});
