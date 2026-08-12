import request from 'supertest';
import { jest } from '@jest/globals';
import {
  prepareDatabase, teardown, makeUser, authHeader, app, flushPermissionCache, models,
} from '../helpers/setup.js';

jest.setTimeout(120_000);

const { Event, EventType, EventPrice, Partner, EventPartner } = models;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let server;
let manager;
let director;

beforeAll(async () => {
  await prepareDatabase();
  server = app();
  manager = await makeUser({ roleKey: 'manager', isStaff: true });
  director = await makeUser({ roleKey: 'director', isStaff: true });
});
afterAll(teardown);
beforeEach(flushPermissionCache);

const makePartner = (user, body) => request(server)
  .post('/api/v1/partners').set(authHeader(user)).send(body);

async function makeEvent() {
  const type = await EventType.findOne({ where: { key: 'cpd' } });
  const event = await Event.create({
    event_type_id: type.id,
    slug: `partner-evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: 'Partnered CPD',
    start_at: new Date(Date.now() + 20 * 864e5),
    end_at: new Date(Date.now() + 21 * 864e5),
    timezone: 'Africa/Accra',
    delivery_mode: 'OFFLINE',
    country_code: 'GH',
    venue: 'KNUST',
    status: 'DRAFT',
  });
  await EventPrice.create({
    event_id: event.id, tier: 'standard', label: 'Free',
    amount_minor: 0, currency: 'GHS', is_default: true,
  });
  return event;
}

describe('the partner library', () => {
  test('a manager adds a partner and gets a slug', async () => {
    const res = await makePartner(manager, {
      name: 'Ghana Institute of Supply Chain Management',
      shortName: 'GISCM',
      websiteUrl: 'https://example.test',
      countryCode: 'GH',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.slug).toMatch(/^ghana-institute-of-supply-chain-management/);
    expect(res.body.data.shortName).toBe('GISCM');
    expect(res.body.data.country).toMatchObject({ code: 'GH' });
  });

  test('two partners with the same name get distinct slugs', async () => {
    const a = await makePartner(manager, { name: 'Duplicate Institute' });
    const b = await makePartner(manager, { name: 'Duplicate Institute' });

    // slugify already appends a random suffix, so both are readable and
    // distinct without a counter.
    expect(a.body.data.slug).not.toBe(b.body.data.slug);
    for (const res of [a, b]) {
      expect(res.body.data.slug).toMatch(/^duplicate-institute/);
    }
  });

  test('a logo is attached and comes back as a URL', async () => {
    const upload = await request(server).post('/api/v1/files/upload')
      .set(authHeader(manager))
      .field('purpose', 'organization_logo')
      .attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' });

    const res = await makePartner(manager, {
      name: 'Logo Partner',
      logoFileId: Number(upload.body.data.id),
    });

    expect(res.body.data.logo.url).toBe(`/files/${upload.body.data.id}`);
    // Logos are public — they appear on pages that need no account.
    expect((await request(server).get(`/api/v1${res.body.data.logo.url}`)).status).toBe(200);
  });

  test('the library is searchable', async () => {
    await makePartner(manager, { name: 'Findable Foundation', shortName: 'FF' });

    const res = await request(server).get('/api/v1/partners?q=Findable').set(authHeader(manager));
    expect(res.body.data.some((p) => p.name === 'Findable Foundation')).toBe(true);
  });

  test('a partner can be edited and deactivated', async () => {
    const made = await makePartner(manager, { name: 'Editable Org' });

    const res = await request(server).patch(`/api/v1/partners/${made.body.data.id}`)
      .set(authHeader(manager))
      .send({ shortName: 'EO', isActive: false });

    expect(res.body.data.shortName).toBe('EO');
    expect(res.body.data.isActive).toBe(false);
    // The slug is referenced in saved links, so renaming leaves it alone.
    expect(res.body.data.slug).toBe(made.body.data.slug);
  });
});

describe('attaching partners to an event', () => {
  test('they appear on the event with their role, in order', async () => {
    const event = await makeEvent();
    const host = await makePartner(manager, { name: 'Host University' });
    const funder = await makePartner(manager, { name: 'Funding Body' });

    const res = await request(server).put(`/api/v1/cpd/events/${event.id}/partners`)
      .set(authHeader(manager))
      .send({
        partners: [
          { partnerId: Number(funder.body.data.id), role: 'FUNDER', sortOrder: 20 },
          { partnerId: Number(host.body.data.id), role: 'HOST', sortOrder: 10 },
        ],
      });

    expect(res.status).toBe(200);
    const names = res.body.data.partners.map((p) => p.name);
    expect(names).toEqual(['Host University', 'Funding Body']); // by sortOrder
    expect(res.body.data.partners[0].role).toBe('HOST');
  });

  test('replacing the set removes the ones left out', async () => {
    const event = await makeEvent();
    const a = await makePartner(manager, { name: 'Stays On' });
    const b = await makePartner(manager, { name: 'Gets Removed' });

    await request(server).put(`/api/v1/cpd/events/${event.id}/partners`)
      .set(authHeader(manager))
      .send({ partners: [{ partnerId: Number(a.body.data.id) }, { partnerId: Number(b.body.data.id) }] });

    const res = await request(server).put(`/api/v1/cpd/events/${event.id}/partners`)
      .set(authHeader(manager))
      .send({ partners: [{ partnerId: Number(a.body.data.id) }] });

    expect(res.body.data.partners.map((p) => p.name)).toEqual(['Stays On']);
    expect(await EventPartner.count({ where: { event_id: event.id } })).toBe(1);
  });

  test('the same partner cannot be added twice to one event', async () => {
    const event = await makeEvent();
    const p = await makePartner(manager, { name: 'Once Only' });

    const res = await request(server).put(`/api/v1/cpd/events/${event.id}/partners`)
      .set(authHeader(manager))
      .send({
        partners: [
          { partnerId: Number(p.body.data.id), role: 'HOST' },
          { partnerId: Number(p.body.data.id), role: 'SPONSOR' },
        ],
      });

    // The unique constraint refuses it rather than silently keeping one.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test('one institution can hold different roles on different events', async () => {
    const [first, second] = [await makeEvent(), await makeEvent()];
    const p = await makePartner(manager, { name: 'Versatile Institute' });
    const id = Number(p.body.data.id);

    await request(server).put(`/api/v1/cpd/events/${first.id}/partners`)
      .set(authHeader(manager)).send({ partners: [{ partnerId: id, role: 'HOST' }] });
    await request(server).put(`/api/v1/cpd/events/${second.id}/partners`)
      .set(authHeader(manager)).send({ partners: [{ partnerId: id, role: 'SPONSOR' }] });

    const a = await request(server).get(`/api/v1/cpd/events/${first.id}`).set(authHeader(manager));
    const b = await request(server).get(`/api/v1/cpd/events/${second.id}`).set(authHeader(manager));

    expect(a.body.data.partners[0].role).toBe('HOST');
    expect(b.body.data.partners[0].role).toBe('SPONSOR');
  });

  test('a partner credited on an event cannot be deleted', async () => {
    const event = await makeEvent();
    const p = await makePartner(manager, { name: 'Credited Partner' });

    await request(server).put(`/api/v1/cpd/events/${event.id}/partners`)
      .set(authHeader(manager)).send({ partners: [{ partnerId: Number(p.body.data.id) }] });

    const res = await request(server).delete(`/api/v1/partners/${p.body.data.id}`)
      .set(authHeader(manager));

    // Deleting would rewrite the record of who ran the event.
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PARTNER_IN_USE');
    expect(res.body.message).toMatch(/inactive instead/);
  });

  test('an unattached partner can be deleted', async () => {
    const p = await makePartner(manager, { name: 'Unused Partner' });
    expect((await request(server).delete(`/api/v1/partners/${p.body.data.id}`)
      .set(authHeader(manager))).status).toBe(200);
  });
});

describe('what participants see', () => {
  test('partners and their logos appear on the public event page', async () => {
    const event = await makeEvent();
    const upload = await request(server).post('/api/v1/files/upload')
      .set(authHeader(manager))
      .field('purpose', 'organization_logo')
      .attach('file', PNG, { filename: 'partner.png', contentType: 'image/png' });

    const partner = await makePartner(manager, {
      name: 'Visible Partner',
      websiteUrl: 'https://partner.example',
      logoFileId: Number(upload.body.data.id),
    });

    await request(server).put(`/api/v1/cpd/events/${event.id}/partners`)
      .set(authHeader(manager))
      .send({ partners: [{ partnerId: Number(partner.body.data.id), role: 'HOST' }] });
    await request(server).post(`/api/v1/cpd/events/${event.id}/publish`)
      .set(authHeader(director)).send({});

    const publicView = await request(server).get(`/api/v1/events/${event.slug}`);

    expect(publicView.status).toBe(200);
    expect(publicView.body.data.partners).toHaveLength(1);
    expect(publicView.body.data.partners[0]).toMatchObject({
      name: 'Visible Partner',
      role: 'HOST',
      websiteUrl: 'https://partner.example',
    });
    expect(publicView.body.data.partners[0].logo.url).toBe(`/files/${upload.body.data.id}`);
  });
});

describe('permissions', () => {
  test('a director can read the library but not change it', async () => {
    expect((await request(server).get('/api/v1/partners').set(authHeader(director))).status).toBe(200);
    expect((await makePartner(director, { name: 'Director Attempt' })).status).toBe(403);
  });

  test('IT administrators hold no partner permission at all', async () => {
    const itAdmin = await makeUser({ roleKey: 'it_admin', isStaff: true });
    expect((await request(server).get('/api/v1/partners').set(authHeader(itAdmin))).status).toBe(403);
  });

  test('participants cannot reach the library', async () => {
    const participant = await makeUser({ roleKey: 'participant' });
    expect((await request(server).get('/api/v1/partners').set(authHeader(participant))).status).toBe(403);
  });

  test('changes are audited', async () => {
    const res = await makePartner(manager, { name: 'Audited Partner' });
    const entry = await models.AuditLog.findOne({
      where: { action: 'partner.created', resource_id: String(res.body.data.id) },
    });
    expect(entry).toBeTruthy();
    expect(entry.after.name).toBe('Audited Partner');
  });
});
