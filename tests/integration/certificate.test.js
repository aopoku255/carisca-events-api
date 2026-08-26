import request from 'supertest';
import { jest } from '@jest/globals';
import {
  prepareDatabase, teardown, makeUser, authHeader, app, flushPermissionCache, models,
} from '../helpers/setup.js';

jest.setTimeout(120_000);

const {
  Event, EventType, EventPrice, Certificate, Registration,
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
async function makeEvent({ amountMinor = 0, issuesCertificate = true } = {}) {
  seq += 1;
  const event = await Event.create({
    event_type_id: cpdType.id,
    slug: `cert-evt-${Date.now()}-${seq}`,
    title: `Certificate Test Event ${seq}`,
    start_at: new Date(Date.now() + 7 * 864e5),
    end_at: new Date(Date.now() + 7 * 864e5 + 3 * 3600e3),
    timezone: 'Africa/Accra',
    delivery_mode: 'HYBRID',
    country_code: 'GH',
    venue: 'KNUST School of Business',
    status: 'REGISTRATION_OPEN',
    issues_certificate: issuesCertificate,
  });
  await EventPrice.create({
    event_id: event.id, tier: 'standard', label: 'Standard',
    amount_minor: amountMinor, currency: 'USD', is_default: true,
  });
  return event;
}

const participant = () => makeUser({ roleKey: 'participant' });

async function confirmedRegistration({ event, user }) {
  const res = await request(server).post('/api/v1/registrations')
    .set(authHeader(user)).send({ eventId: Number(event.id), mediaConsent: true });
  expect(res.body.data.registration.status).toBe('CONFIRMED');
  return res.body.data.registration.reference;
}

describe('downloading a certificate', () => {
  test('a confirmed registration on a certificate-issuing event gets a PDF', async () => {
    const event = await makeEvent();
    const user = await participant();
    const reference = await confirmedRegistration({ event, user });

    const res = await request(server)
      .get(`/api/v1/registrations/${reference}/certificate`)
      .set(authHeader(user));

    expect(res.status).toBe(200);
    // No "; charset=utf-8" — this is a binary body, not text.
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain(`certificate-${reference}.pdf`);
    expect(Number(res.headers['content-length'])).toBeGreaterThan(1000);
  });

  test('format=png returns an image instead', async () => {
    const event = await makeEvent();
    const user = await participant();
    const reference = await confirmedRegistration({ event, user });

    const res = await request(server)
      .get(`/api/v1/registrations/${reference}/certificate`)
      .query({ format: 'png' })
      .set(authHeader(user));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Number(res.headers['content-length'])).toBeGreaterThan(1000);
  });

  test('the eligibility summary appears on the registration itself', async () => {
    const event = await makeEvent();
    const user = await participant();
    const reference = await confirmedRegistration({ event, user });

    const res = await request(server)
      .get(`/api/v1/registrations/${reference}`)
      .set(authHeader(user));

    expect(res.body.data.certificate).toEqual({ eligible: true });
  });

  test('an event that does not issue certificates refuses with a clear reason', async () => {
    const event = await makeEvent({ issuesCertificate: false });
    const user = await participant();
    const reference = await confirmedRegistration({ event, user });

    const res = await request(server)
      .get(`/api/v1/registrations/${reference}/certificate`)
      .set(authHeader(user));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CERTIFICATE_NOT_OFFERED');
  });

  test('a registration still pending payment is refused', async () => {
    const event = await makeEvent({ amountMinor: 5000 });
    const user = await participant();

    const created = await request(server).post('/api/v1/registrations')
      .set(authHeader(user)).send({ eventId: Number(event.id) });
    expect(created.body.data.registration.status).toBe('PENDING_PAYMENT');
    const reference = created.body.data.registration.reference;

    const res = await request(server)
      .get(`/api/v1/registrations/${reference}/certificate`)
      .set(authHeader(user));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REGISTRATION_NOT_CONFIRMED');
  });

  test('someone else cannot download it', async () => {
    const event = await makeEvent();
    const user = await participant();
    const stranger = await participant();
    const reference = await confirmedRegistration({ event, user });

    const res = await request(server)
      .get(`/api/v1/registrations/${reference}/certificate`)
      .set(authHeader(stranger));

    expect(res.status).toBe(403);
  });

  test('opting out of a certificate at registration is honoured', async () => {
    const event = await makeEvent();
    const user = await participant();

    const created = await request(server).post('/api/v1/registrations')
      .set(authHeader(user)).send({ eventId: Number(event.id), wantsCertificate: false, mediaConsent: true });
    const reference = created.body.data.registration.reference;
    expect(created.body.data.registration.status).toBe('CONFIRMED');

    const res = await request(server)
      .get(`/api/v1/registrations/${reference}/certificate`)
      .set(authHeader(user));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CERTIFICATE_OPTED_OUT');
  });
});

describe('verifying a certificate', () => {
  test('downloading one issues a verification code that the public endpoint confirms', async () => {
    const event = await makeEvent();
    const user = await participant();
    const reference = await confirmedRegistration({ event, user });

    const download = await request(server)
      .get(`/api/v1/registrations/${reference}/certificate`)
      .set(authHeader(user));
    expect(download.status).toBe(200);

    const registration = await Registration.findOne({ where: { reference } });
    const certificate = await Certificate.findOne({ where: { registration_id: registration.id } });
    expect(certificate.verification_code).toMatch(/^CARISCA-CPD-\d{4}-\d{6}-[A-Z0-9]{4}$/);

    // The public endpoint needs no session — it's reached from the QR code
    // printed on the certificate, by whoever is holding it.
    const verify = await request(server)
      .get(`/api/v1/certificates/verify/${certificate.verification_code}`);

    expect(verify.status).toBe(200);
    expect(verify.body.data).toMatchObject({
      valid: true,
      status: 'ISSUED',
      eventTitle: event.title,
      venue: event.venue,
    });
    expect(verify.body.data.participantName).toContain(user.first_name);
  });

  test('a second download reuses the same code rather than minting a new one', async () => {
    const event = await makeEvent();
    const user = await participant();
    const reference = await confirmedRegistration({ event, user });

    await request(server).get(`/api/v1/registrations/${reference}/certificate`).set(authHeader(user));
    await request(server).get(`/api/v1/registrations/${reference}/certificate`)
      .query({ format: 'png' }).set(authHeader(user));

    const registration = await Registration.findOne({ where: { reference } });
    const count = await Certificate.count({ where: { registration_id: registration.id } });
    expect(count).toBe(1);

    const certificate = await Certificate.findOne({ where: { registration_id: registration.id } });
    expect(certificate.download_count).toBe(2);
  });

  test('an unknown code is not found, not an error about who is asking', async () => {
    const res = await request(server).get('/api/v1/certificates/verify/NOT-A-REAL-CODE');
    expect(res.status).toBe(404);
  });

  test('a revoked certificate reports as invalid, with the reason', async () => {
    const event = await makeEvent();
    const user = await participant();
    const reference = await confirmedRegistration({ event, user });

    await request(server).get(`/api/v1/registrations/${reference}/certificate`).set(authHeader(user));
    const registration = await Registration.findOne({ where: { reference } });
    const certificate = await Certificate.findOne({ where: { registration_id: registration.id } });
    await certificate.update({
      status: 'REVOKED', revoked_at: new Date(), revoked_reason: 'Issued in error',
    });

    const verify = await request(server)
      .get(`/api/v1/certificates/verify/${certificate.verification_code}`);

    expect(verify.body.data.valid).toBe(false);
    expect(verify.body.data.status).toBe('REVOKED');
    expect(verify.body.data.revokedReason).toBe('Issued in error');
  });
});
