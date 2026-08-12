import request from 'supertest';
import { jest } from '@jest/globals';
import {
  prepareDatabase, teardown, makeUser, authHeader, app, flushPermissionCache, models,
} from '../helpers/setup.js';
import * as registrationService from '../../src/core/registrations/registration.service.js';
import { escapeCell, toCsv } from '../../src/lib/csv.js';

jest.setTimeout(120_000);

const { Event, EventType, EventPrice, RegistrationQuestion, User } = models;

let server;
let cpdType;
let manager;
let event;
let question;

beforeAll(async () => {
  await prepareDatabase();
  server = app();
  cpdType = await EventType.findOne({ where: { key: 'cpd' } });
  manager = await makeUser({ roleKey: 'manager', isStaff: true });

  event = await Event.create({
    event_type_id: cpdType.id,
    slug: `export-${Date.now()}`,
    title: 'Export fixture',
    start_at: new Date(Date.now() + 7 * 864e5),
    end_at: new Date(Date.now() + 8 * 864e5),
    timezone: 'Africa/Accra',
    delivery_mode: 'HYBRID',
    country_code: 'GH',
    venue: 'KNUST',
    online_url: 'https://example.test/j',
    status: 'REGISTRATION_OPEN',
  });
  await EventPrice.create({
    event_id: event.id, tier: 'standard', label: 'Free',
    amount_minor: 0, currency: 'GHS', is_default: true,
  });
  question = await RegistrationQuestion.create({
    event_id: event.id, label: 'What is your organization?',
    type: 'TEXT', is_required: false, sort_order: 10,
  });
});
afterAll(teardown);
beforeEach(flushPermissionCache);

describe('CSV safety', () => {
  test('a formula is neutralised so opening the file cannot execute it', () => {
    // A participant can type this into any free-text answer.
    expect(escapeCell('=HYPERLINK("http://evil.test","clickme")'))
      .toBe(`"'=HYPERLINK(""http://evil.test"",""clickme"")"`);
    expect(escapeCell('+1234')).toBe("'+1234");
    expect(escapeCell('-1234')).toBe("'-1234");
    expect(escapeCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  test('ordinary values are left alone', () => {
    expect(escapeCell('Ama Mensah')).toBe('Ama Mensah');
    expect(escapeCell('Kumasi, Ghana')).toBe('"Kumasi, Ghana"');
    expect(escapeCell('She said "hello"')).toBe('"She said ""hello"""');
    expect(escapeCell(null)).toBe('');
  });

  test('the file carries a UTF-8 BOM so Excel does not mangle accents', () => {
    const csv = toCsv([{ header: 'Name', map: (r) => r.name }], [{ name: 'Adjei-Bræmpong' }]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('Adjei-Bræmpong');
  });
});

describe('the participant export', () => {
  async function registerSomeone(overrides = {}) {
    const user = await makeUser({ roleKey: 'participant' });
    await user.update({ organization: 'Ghana Health Service', country_code: 'GH', ...overrides });
    return registrationService.register({
      eventId: event.id,
      user,
      answers: { [question.id]: 'KNUST School of Business' },
      mediaConsent: true,
    });
  }

  test('returns a downloadable CSV with the event questions as columns', async () => {
    await registerSomeone();

    const res = await request(server)
      .get(`/api/v1/registrations/export?eventId=${event.id}`)
      .set(authHeader(manager));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename=".*\.csv"/);
    // Personal data must not be cached by a proxy.
    expect(res.headers['cache-control']).toMatch(/no-store/);

    const [header] = res.text.split('\r\n');
    expect(header).toContain('Reference');
    expect(header).toContain('Email');
    expect(header).toContain('Region');
    // The event's configured question became a column.
    expect(header).toContain('What is your organization?');
    expect(res.text).toContain('KNUST School of Business');
  });

  test('a formula typed into an answer is neutralised in the file', async () => {
    const user = await makeUser({ roleKey: 'participant' });
    await registrationService.register({
      eventId: event.id,
      user,
      answers: { [question.id]: '=cmd|"/c calc"!A1' },
      mediaConsent: true,
    });

    const res = await request(server)
      .get(`/api/v1/registrations/export?eventId=${event.id}`)
      .set(authHeader(manager));

    expect(res.text).toContain(`"'=cmd|""/c calc""!A1"`);
    // The raw formula must never appear at the start of a field.
    expect(res.text).not.toMatch(/,=cmd/);
  });

  test('it can be filtered by status', async () => {
    const res = await request(server)
      .get(`/api/v1/registrations/export?eventId=${event.id}&status=CANCELLED`)
      .set(authHeader(manager));

    const lines = res.text.trim().split('\r\n');
    expect(lines).toHaveLength(1); // header only
  });

  test('exporting is audited — who took a copy of what', async () => {
    await request(server)
      .get(`/api/v1/registrations/export?eventId=${event.id}`)
      .set(authHeader(manager));

    const entry = await models.AuditLog.findOne({
      where: { action: 'registration.exported', actor_user_id: manager.id },
      order: [['id', 'DESC']],
    });

    expect(entry).toBeTruthy();
    expect(entry.resource_id).toBe(String(event.id));
    expect(entry.metadata.rows).toBeGreaterThan(0);
  });

  test('export needs its own permission, separate from viewing', async () => {
    // Event staff can view registrations at the door but may not walk out
    // with the whole participant list.
    const staff = await makeUser({ roleKey: 'event_staff', isStaff: true });
    expect((await request(server).get(`/api/v1/registrations/export?eventId=${event.id}`)
      .set(authHeader(staff))).status).toBe(403);

    const itAdmin = await makeUser({ roleKey: 'it_admin', isStaff: true });
    expect((await request(server).get(`/api/v1/registrations/export?eventId=${event.id}`)
      .set(authHeader(itAdmin))).status).toBe(403);

    const me = await makeUser({ roleKey: 'monitoring_evaluation', isStaff: true });
    expect((await request(server).get(`/api/v1/registrations/export?eventId=${event.id}`)
      .set(authHeader(me))).status).toBe(200);
  });

  test('a participant cannot export', async () => {
    const user = await makeUser({ roleKey: 'participant' });
    expect((await request(server).get(`/api/v1/registrations/export?eventId=${event.id}`)
      .set(authHeader(user))).status).toBe(403);
  });
});

describe('the event summary', () => {
  test('reports totals, capacity and the M&E breakdowns', async () => {
    const res = await request(server)
      .get(`/api/v1/cpd/events/${event.id}/summary`)
      .set(authHeader(manager));

    expect(res.status).toBe(200);
    const d = res.body.data;

    expect(d.totals.all).toBeGreaterThan(0);
    expect(d.totals.confirmed).toBeGreaterThan(0);
    expect(d.byAttendanceMode.IN_PERSON).toBeGreaterThan(0);
    expect(d.capacity.inPerson).toHaveProperty('isFull');
    expect(Array.isArray(d.topCountries)).toBe(true);
    expect(Array.isArray(d.registrationsPerDay)).toBe(true);
    expect(d.distinctOrganizations).toBeGreaterThanOrEqual(1);
  });

  test('missing demographics are labelled rather than dropped', async () => {
    const bare = await makeUser({ roleKey: 'participant' });
    await bare.update({ organization: null, country_code: null });
    await registrationService.register({ eventId: event.id, user: bare, mediaConsent: true });

    const res = await request(server)
      .get(`/api/v1/cpd/events/${event.id}/summary`)
      .set(authHeader(manager));

    const orgs = res.body.data.topOrganizations.map((o) => o.name);
    expect(orgs).toContain('Not given');
  });

  test('it respects the registration-view permission', async () => {
    const itAdmin = await makeUser({ roleKey: 'it_admin', isStaff: true });
    expect((await request(server).get(`/api/v1/cpd/events/${event.id}/summary`)
      .set(authHeader(itAdmin))).status).toBe(403);
  });
});
