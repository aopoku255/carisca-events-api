import request from 'supertest';
import { jest } from '@jest/globals';
import {
  prepareDatabase, teardown, app, flushPermissionCache, models,
} from '../helpers/setup.js';

jest.setTimeout(120_000);

const {
  Event, EventType, EventPrice, Registration, User, Notification,
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
  amountMinor = 0, currency = 'USD', capacity = null, allowWaitlist = false,
} = {}) {
  seq += 1;
  const event = await Event.create({
    event_type_id: cpdType.id,
    slug: `guest-evt-${Date.now()}-${seq}`,
    title: `Guest Test CPD ${seq}`,
    start_at: new Date(Date.now() + 7 * 864e5),
    end_at: new Date(Date.now() + 8 * 864e5),
    timezone: 'Africa/Accra',
    delivery_mode: 'HYBRID',
    country_code: 'GH',
    venue: 'KNUST School of Business',
    online_url: 'https://example.test/join',
    capacity,
    allow_waitlist: allowWaitlist,
    status: 'REGISTRATION_OPEN',
  });
  await EventPrice.create({
    event_id: event.id, tier: 'standard', label: 'Standard',
    amount_minor: amountMinor, currency, is_default: true,
  });
  return event;
}

const email = () => `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

function guestPayload(overrides = {}) {
  return {
    firstName: 'Guest',
    lastName: 'Participant',
    email: email(),
    phone: '+233555000222',
    countryCode: 'GH',
    organization: 'Guest Org',
    jobTitle: 'Guest Role',
    positionKey: 'other_supply_chain',
    sectorKey: 'business',
    attendanceMode: 'IN_PERSON',
    mediaConsent: true,
    ...overrides,
  };
}

describe('registering as a guest', () => {
  test('creates an account, signs it in, and registers in one call', async () => {
    const event = await makeEvent({ amountMinor: 0 });
    const payload = guestPayload({ eventId: Number(event.id) });

    const res = await request(server).post('/api/v1/registrations/guest').send(payload);

    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe(payload.email);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.refreshToken).toEqual(expect.any(String));
    expect(res.body.data.registration.status).toBe('CONFIRMED');

    const user = await User.findOne({ where: { email: payload.email } });
    expect(user).not.toBeNull();
    expect(user.organization).toBe('Guest Org');
    expect(user.phone).toBe('+233555000222');

    const roles = await user.getRoles();
    expect(roles.map((r) => r.key)).toContain('participant');

    const registrations = await Registration.findAll({ where: { user_id: user.id, event_id: event.id } });
    expect(registrations).toHaveLength(1);

    const verificationEmail = await Notification.findOne({
      where: { user_id: user.id, template: 'email_verification' },
    });
    expect(verificationEmail).not.toBeNull();
  });

  test('an email that already has an account is refused, not reused', async () => {
    const event = await makeEvent({ amountMinor: 0 });
    const existingEmail = email();

    // A real, pre-existing account — created independently, not through the
    // guest path — so nothing here should be able to attach a registration
    // to it without proving ownership.
    await User.create({
      email: existingEmail,
      password_hash: 'x',
      first_name: 'Existing',
      last_name: 'User',
      status: 'ACTIVE',
      is_staff: false,
    });

    const res = await request(server).post('/api/v1/registrations/guest')
      .send(guestPayload({ eventId: Number(event.id), email: existingEmail }));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_HAS_ACCOUNT');

    const registrationCount = await Registration.count({ where: { event_id: event.id } });
    expect(registrationCount).toBe(0);
  });

  test('missing profile fields are rejected before any account is created', async () => {
    const event = await makeEvent({ amountMinor: 0 });
    const payload = guestPayload({ eventId: Number(event.id) });
    delete payload.positionKey;

    const res = await request(server).post('/api/v1/registrations/guest').send(payload);

    expect(res.status).toBe(422);
    expect(res.body.error.details.some((d) => d.field === 'positionKey')).toBe(true);

    const user = await User.findOne({ where: { email: payload.email } });
    expect(user).toBeNull();
  });

  test('a supplied password can sign in afterwards; an omitted one still creates a usable account', async () => {
    const event = await makeEvent({ amountMinor: 0 });
    const withPassword = guestPayload({ eventId: Number(event.id), password: 'a-real-password-123' });

    const res = await request(server).post('/api/v1/registrations/guest').send(withPassword);
    expect(res.status).toBe(201);

    const login = await request(server).post('/api/v1/auth/login')
      .send({ email: withPassword.email, password: 'a-real-password-123' });
    expect(login.status).toBe(200);

    const noPassword = guestPayload({ eventId: Number(event.id) });
    const res2 = await request(server).post('/api/v1/registrations/guest').send(noPassword);
    expect(res2.status).toBe(201);

    const user = await User.scope('withSecrets').findOne({ where: { email: noPassword.email } });
    expect(user.password_hash).toEqual(expect.any(String));
    expect(user.password_hash.length).toBeGreaterThan(0);
  });

  test('a full event waitlists a guest instead of failing outright', async () => {
    const event = await makeEvent({ amountMinor: 0, capacity: 0, allowWaitlist: true });
    const payload = guestPayload({ eventId: Number(event.id) });

    const res = await request(server).post('/api/v1/registrations/guest').send(payload);

    expect(res.status).toBe(201);
    expect(res.body.data.registration.status).toBe('WAITLISTED');
  });
});
