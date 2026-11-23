import request from 'supertest';
import { jest } from '@jest/globals';
import {
  prepareDatabase, teardown, makeUser, authHeader, app, flushPermissionCache, models,
} from '../helpers/setup.js';
import { render } from '../../src/core/notifications/templates/index.js';

jest.setTimeout(120_000);

const {
  Event, EventType, EventPrice, Registration, Notification, AuditLog,
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
async function makeEvent() {
  seq += 1;
  const event = await Event.create({
    event_type_id: cpdType.id,
    slug: `msg-evt-${Date.now()}-${seq}`,
    title: `Messaging Test ${seq}`,
    start_at: new Date(Date.now() + 7 * 864e5),
    end_at: new Date(Date.now() + 8 * 864e5),
    timezone: 'Africa/Accra',
    delivery_mode: 'HYBRID',
    country_code: 'GH',
    venue: 'KNUST School of Business',
    status: 'REGISTRATION_OPEN',
  });
  await EventPrice.create({
    event_id: event.id, tier: 'standard', label: 'Standard',
    amount_minor: 0, currency: 'USD', is_default: true,
  });
  return event;
}

const manager = () => makeUser({ roleKey: 'manager', isStaff: true });

async function register(event, { mode = 'IN_PERSON' } = {}) {
  const user = await makeUser({ roleKey: 'participant' });
  const res = await request(server).post('/api/v1/registrations').set(authHeader(user))
    .send({ eventId: Number(event.id), attendanceMode: mode, mediaConsent: true });
  expect(res.status).toBe(201);
  return { user, reference: res.body.data.registration.reference };
}

const send = (admin, body) => request(server).post('/api/v1/registrations/email')
  .set(authHeader(admin)).send(body);

const queued = async (event) => (await Notification.findAll({ where: { template: 'admin_message' } }))
  .filter((n) => n.payload?.eventTitle === event.title);

describe('emailing an event\'s participants', () => {
  test('bulk: queues one message per registrant, with their own name and link', async () => {
    const event = await makeEvent();
    const admin = await manager();
    const a = await register(event);
    await register(event);

    const res = await send(admin, {
      eventId: Number(event.id), subject: 'Venue change', message: 'We have moved to Hall B.\n\nSee you there.',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.queued).toBe(2);

    const rows = await queued(event);
    expect(rows).toHaveLength(2);
    const mine = rows.find((n) => n.payload.reference === a.reference);
    expect(mine.subject).toBe('Venue change');
    expect(mine.to_address).toBe(a.user.email);

    const { html } = render('admin_message', mine.payload);
    expect(html).toContain('Hall B');
    expect(html).toContain(`/dashboard/registrations/${a.reference}`);
  });

  test('individual: only the chosen registration is emailed', async () => {
    const event = await makeEvent();
    const admin = await manager();
    const target = await register(event);
    await register(event);

    const res = await send(admin, {
      eventId: Number(event.id), references: [target.reference], subject: 'Hello', message: 'Just you.',
    });

    expect(res.body.data.queued).toBe(1);
    const rows = await queued(event);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.reference).toBe(target.reference);
  });

  test('filters by attendance mode, and cancelled registrations are never emailed', async () => {
    const event = await makeEvent();
    const admin = await manager();
    await register(event, { mode: 'VIRTUAL' });
    await register(event, { mode: 'IN_PERSON' });
    const cancelled = await register(event, { mode: 'VIRTUAL' });
    await Registration.update({ status: 'CANCELLED' }, { where: { reference: cancelled.reference } });

    const res = await send(admin, {
      eventId: Number(event.id), attendanceMode: 'VIRTUAL', subject: 'Link', message: 'Join here.',
    });

    expect(res.body.data.queued).toBe(1);
  });

  test('a dry run reports the count and queues nothing', async () => {
    const event = await makeEvent();
    const admin = await manager();
    await register(event);
    await register(event);

    const res = await send(admin, { eventId: Number(event.id), dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.data.recipients).toBe(2);
    expect(await queued(event)).toHaveLength(0);
  });

  test('a subject and message are required, and an empty audience is refused', async () => {
    const event = await makeEvent();
    const admin = await manager();

    const missing = await send(admin, { eventId: Number(event.id) });
    expect(missing.status).toBe(422);

    const nobody = await send(admin, { eventId: Number(event.id), subject: 'Hi', message: 'Anyone?' });
    expect(nobody.status).toBe(422);
  });

  test('the send is written to the audit log', async () => {
    const event = await makeEvent();
    const admin = await manager();
    await register(event);

    await send(admin, { eventId: Number(event.id), subject: 'Audit me', message: 'Body.' });

    const entry = await AuditLog.findOne({
      where: { action: 'registration.emailed', resource_id: String(event.id) },
    });
    expect(entry).not.toBeNull();
  });

  test('a participant cannot email anyone', async () => {
    const event = await makeEvent();
    const someone = await makeUser({ roleKey: 'participant' });

    const res = await send(someone, { eventId: Number(event.id), subject: 'x', message: 'y' });
    expect(res.status).toBe(403);
  });

  test('markup in the message is escaped, not rendered', () => {
    const { html } = render('admin_message', {
      firstName: 'Ama', eventTitle: 'E', subject: 'S', message: '<script>alert(1)</script>\nline two',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('line two');
  });
});
