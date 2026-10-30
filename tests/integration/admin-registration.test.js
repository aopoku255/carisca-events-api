import request from 'supertest';
import { jest } from '@jest/globals';
import {
  prepareDatabase, teardown, makeUser, authHeader, app, flushPermissionCache, models,
} from '../helpers/setup.js';

jest.setTimeout(120_000);

const {
  Event, EventType, EventPrice, Registration, User, Notification, AttendanceRecord,
} = models;

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
  amountMinor = 0, status = 'REGISTRATION_OPEN', issuesCertificate = true,
  startAt = new Date(Date.now() + 7 * 864e5), endAt = new Date(Date.now() + 8 * 864e5),
} = {}) {
  seq += 1;
  const event = await Event.create({
    event_type_id: cpdType.id,
    slug: `admin-reg-${Date.now()}-${seq}`,
    title: `Admin Registration Test ${seq}`,
    start_at: startAt,
    end_at: endAt,
    timezone: 'Africa/Accra',
    delivery_mode: 'HYBRID',
    country_code: 'GH',
    venue: 'KNUST School of Business',
    status,
    issues_certificate: issuesCertificate,
  });
  await EventPrice.create({
    event_id: event.id, tier: 'standard', label: 'Standard',
    amount_minor: amountMinor, currency: 'USD', is_default: true,
  });
  return event;
}

const manager = () => makeUser({ roleKey: 'manager', isStaff: true });
const email = () => `added-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

const newParticipant = (overrides = {}) => ({
  firstName: 'Ama', lastName: 'Mensah', email: email(), gender: 'Female', ...overrides,
});

const addTo = (admin, body) => request(server).post('/api/v1/registrations/admin')
  .set(authHeader(admin)).send(body);

describe('an administrator adding a participant to an event', () => {
  test('creates the account, registers them and emails both the sign-in details and the registration', async () => {
    const event = await makeEvent();
    const admin = await manager();
    const participant = newParticipant();

    const res = await addTo(admin, {
      eventId: Number(event.id), attendanceMode: 'IN_PERSON', participant,
    });

    expect(res.status).toBe(201);
    expect(res.body.data.accountCreated).toBe(true);
    expect(res.body.data.credentialsEmailSent).toBe(true);
    expect(res.body.data.registration.status).toBe('CONFIRMED');

    const user = await User.findOne({ where: { email: participant.email } });
    expect(user.gender).toBe('Female');
    // Not even a position or sector was given: an administrator vouches for the details.
    expect(await Registration.count({ where: { user_id: user.id, event_id: event.id } })).toBe(1);

    const queued = await Notification.findOne({
      where: { user_id: user.id, template: 'registration_confirmed' },
    });
    expect(queued).not.toBeNull();
  });

  test('uses the existing account when the email already has one', async () => {
    const event = await makeEvent();
    const admin = await manager();
    const existing = await makeUser({ roleKey: 'participant' });

    const res = await addTo(admin, {
      eventId: Number(event.id), participant: newParticipant({ email: existing.email }),
    });

    expect(res.status).toBe(201);
    expect(res.body.data.accountCreated).toBe(false);
    expect(res.body.data.participant.id).toBe(String(existing.id));
  });

  test('can pick an existing participant by id', async () => {
    const event = await makeEvent();
    const admin = await manager();
    const existing = await makeUser({ roleKey: 'participant' });

    const res = await addTo(admin, { eventId: Number(event.id), userId: Number(existing.id) });

    expect(res.status).toBe(201);
    expect(res.body.data.accountCreated).toBe(false);
  });

  test('works after the public registration window has closed', async () => {
    const event = await makeEvent({ status: 'REGISTRATION_CLOSED' });
    const admin = await manager();

    const res = await addTo(admin, { eventId: Number(event.id), participant: newParticipant() });
    expect(res.status).toBe(201);
  });

  test('is refused for a cancelled event', async () => {
    const event = await makeEvent({ status: 'CANCELLED' });
    const admin = await manager();

    const res = await addTo(admin, { eventId: Number(event.id), participant: newParticipant() });
    expect(res.status).toBe(409);
  });

  test('a paid event holds the place pending payment, unless the fee is waived', async () => {
    const event = await makeEvent({ amountMinor: 5000 });
    const admin = await manager();

    const held = await addTo(admin, { eventId: Number(event.id), participant: newParticipant() });
    expect(held.body.data.registration.status).toBe('PENDING_PAYMENT');

    const waived = await addTo(admin, {
      eventId: Number(event.id), participant: newParticipant(), waiveFee: true,
    });
    expect(waived.status).toBe(201);
    const registration = await Registration.findOne({
      where: { reference: waived.body.data.registration.reference },
    });
    expect(registration.status).toBe('CONFIRMED');
  });

  test('registering the same person twice is refused', async () => {
    const event = await makeEvent();
    const admin = await manager();
    const participant = newParticipant();

    await addTo(admin, { eventId: Number(event.id), participant });
    const again = await addTo(admin, { eventId: Number(event.id), participant });

    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_REGISTERED');
  });

  test('a participant cannot add people', async () => {
    const event = await makeEvent();
    const someone = await makeUser({ roleKey: 'participant' });

    const res = await addTo(someone, { eventId: Number(event.id), participant: newParticipant() });
    expect(res.status).toBe(403);
  });
});

describe('an administrator marking attendance and issuing a certificate', () => {
  async function registered({ event, admin }) {
    const res = await addTo(admin, { eventId: Number(event.id), participant: newParticipant() });
    return res.body.data.registration.reference;
  }

  test('the registration shows whether they were admitted, and can be marked attended by hand', async () => {
    const event = await makeEvent();
    const admin = await manager();
    const reference = await registered({ event, admin });

    const before = await request(server).get(`/api/v1/registrations/${reference}`).set(authHeader(admin));
    expect(before.body.data.attendance).toBeNull();

    const mark = await request(server).post('/api/v1/attendance/scan')
      .set(authHeader(admin)).send({ reference });
    expect(mark.status).toBe(200);
    expect(mark.body.data.result).toBe('CHECKED_IN');

    const after = await request(server).get(`/api/v1/registrations/${reference}`).set(authHeader(admin));
    expect(after.body.data.attendance.status).toBe('CHECKED_IN');

    const record = await AttendanceRecord.findOne({ where: { method: 'MANUAL' } });
    expect(record).not.toBeNull();
  });

  test('an administrator can issue a certificate before the event ends; the participant cannot', async () => {
    const event = await makeEvent(); // still in the future
    const admin = await manager();
    const reference = await registered({ event, admin });

    const detail = await request(server).get(`/api/v1/registrations/${reference}`).set(authHeader(admin));
    expect(detail.body.data.certificate.eligible).toBe(false);
    expect(detail.body.data.adminCertificate.eligible).toBe(true);

    const res = await request(server).get(`/api/v1/registrations/${reference}/certificate?format=pdf`)
      .set(authHeader(admin)).buffer(true).parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
  });

  test('an unconfirmed registration cannot be issued a certificate even by an administrator', async () => {
    const event = await makeEvent({ amountMinor: 5000 });
    const admin = await manager();
    const reference = await registered({ event, admin }); // PENDING_PAYMENT

    const res = await request(server).get(`/api/v1/registrations/${reference}/certificate?format=pdf`)
      .set(authHeader(admin));
    expect(res.status).toBe(409);
  });
});
