import request from 'supertest';
import { jest } from '@jest/globals';
import {
  prepareDatabase, teardown, makeUser, authHeader, app, flushPermissionCache, models,
} from '../helpers/setup.js';

jest.setTimeout(120_000);

let server;
let manager;   // can create and edit, cannot publish
let director;  // can publish, cannot create

beforeAll(async () => {
  await prepareDatabase();
  server = app();
  manager = await makeUser({ roleKey: 'manager', isStaff: true });
  director = await makeUser({ roleKey: 'director', isStaff: true });
});
afterAll(teardown);
beforeEach(flushPermissionCache);

const future = (days) => new Date(Date.now() + days * 864e5).toISOString();

const draft = (overrides = {}) => ({
  title: 'CARISCA Supply Chain Summit',
  shortDescription: 'The annual gathering of supply chain researchers.',
  startAt: future(60),
  endAt: future(62),
  timezone: 'Africa/Accra',
  deliveryMode: 'OFFLINE',
  countryCode: 'GH',
  city: 'Kumasi',
  venue: 'KNUST School of Business',
  capacity: 300,
  ...overrides,
});

async function createDraft(overrides = {}, as = manager) {
  const res = await request(server).post('/api/v1/summit/events').set(authHeader(as)).send(draft(overrides));
  expect(res.status).toBe(201);
  return res.body.data;
}

async function setPrices(eventId, prices, as = manager) {
  return request(server).put(`/api/v1/summit/events/${eventId}/prices`).set(authHeader(as)).send({ prices });
}

const standard = [{ label: 'Standard', amount: '150.00', currency: 'USD', isDefault: true }];

describe('creating a Summit', () => {
  test('a manager creates it as a draft with a generated slug', async () => {
    const event = await createDraft();
    expect(event.status).toBe('DRAFT');
    expect(event.slug).toMatch(/^carisca-supply-chain-summit/);
    expect(event.type.key).toBe('summit');
  });

  test('a director cannot create one', async () => {
    const res = await request(server).post('/api/v1/summit/events').set(authHeader(director)).send(draft());
    expect(res.status).toBe(403);
  });

  test('Summit-specific detail is stored on its own extension table', async () => {
    const event = await createDraft({
      summit: {
        theme: 'Resilient Supply Chains for Africa',
        callForPapersOpensAt: future(1),
        callForPapersClosesAt: future(20),
        keynoteCount: 4,
      },
    });
    expect(event.summit.theme).toBe('Resilient Supply Chains for Africa');
    expect(event.summit.keynoteCount).toBe(4);
    // CPD-only fields never appear on a Summit event.
    expect(event.cpd).toBeUndefined();
  });

  test('staff without any Summit permission are refused', async () => {
    const itAdmin = await makeUser({ roleKey: 'it_admin', isStaff: true });
    const res = await request(server).post('/api/v1/summit/events').set(authHeader(itAdmin)).send(draft());
    expect(res.status).toBe(403);
  });
});

describe('lifecycle transitions', () => {
  async function publishable(overrides = {}) {
    const event = await createDraft(overrides);
    await setPrices(event.id, standard);
    return event;
  }

  test('a manager cannot publish; a director can', async () => {
    const event = await publishable();

    const asManager = await request(server).post(`/api/v1/summit/events/${event.id}/publish`)
      .set(authHeader(manager)).send({});
    expect(asManager.status).toBe(403);

    const asDirector = await request(server).post(`/api/v1/summit/events/${event.id}/publish`)
      .set(authHeader(director)).send({});
    expect(asDirector.status).toBe(200);
    expect(asDirector.body.data.status).toBe('PUBLISHED');
  });

  test('publish validation is still enforced — the shared rules were not bypassed', async () => {
    const event = await createDraft();
    const res = await request(server).post(`/api/v1/summit/events/${event.id}/publish`)
      .set(authHeader(director)).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NOT_PUBLISHABLE');
    expect(res.body.error.details.problems.join(' ')).toMatch(/at least one price/);
  });

  test('a manager can cancel and archive; publish/cancel/archive each need their own permission', async () => {
    const event = await publishable();
    await request(server).post(`/api/v1/summit/events/${event.id}/publish`).set(authHeader(director)).send({});

    const cancelled = await request(server).post(`/api/v1/summit/events/${event.id}/cancel`)
      .set(authHeader(manager)).send({ reason: 'Venue unavailable' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');

    const archived = await request(server).post(`/api/v1/summit/events/${event.id}/archive`)
      .set(authHeader(manager)).send({});
    expect(archived.status).toBe(200);
    expect(archived.body.data.status).toBe('ARCHIVED');
  });
});

describe('tracks', () => {
  test('a manager sets the whole track list and it is returned in order', async () => {
    const event = await createDraft();

    const res = await request(server).put(`/api/v1/summit/events/${event.id}/tracks`)
      .set(authHeader(manager))
      .send({
        tracks: [
          { name: 'Track A: Digital Supply Chains', sortOrder: 10 },
          { name: 'Track B: Policy and Governance', sortOrder: 20 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.tracks).toHaveLength(2);
    expect(res.body.data.tracks.map((t) => t.name)).toEqual([
      'Track A: Digital Supply Chains',
      'Track B: Policy and Governance',
    ]);
  });

  test('a session can be assigned to a track, and grouping survives a re-fetch', async () => {
    const event = await createDraft();
    const tracksRes = await request(server).put(`/api/v1/summit/events/${event.id}/tracks`)
      .set(authHeader(manager)).send({ tracks: [{ name: 'Track A' }] });
    const trackId = tracksRes.body.data.tracks[0].id;

    const sessionsRes = await request(server).put(`/api/v1/summit/events/${event.id}/sessions`)
      .set(authHeader(manager))
      .send({
        sessions: [
          {
            title: 'Opening keynote', startAt: future(60), endAt: future(60), trackId,
          },
          {
            title: 'Untracked plenary', startAt: future(60), endAt: future(60),
          },
        ],
      });

    expect(sessionsRes.status).toBe(200);
    const [keynote, plenary] = sessionsRes.body.data.sessions;
    expect(keynote.trackId).toBe(trackId);
    expect(plenary.trackId).toBeNull();
  });

  test('a session with no track still serialises fine — the untouched CPD path', async () => {
    const event = await createDraft();
    const res = await request(server).put(`/api/v1/summit/events/${event.id}/sessions`)
      .set(authHeader(manager))
      .send({ sessions: [{ title: 'Plenary', startAt: future(60), endAt: future(60) }] });

    expect(res.status).toBe(200);
    expect(res.body.data.sessions[0].trackId).toBeNull();
  });
});

describe('sponsorship tiers', () => {
  test('a manager sets tiers and a partner can be assigned to one', async () => {
    const event = await createDraft();

    const tiersRes = await request(server).put(`/api/v1/summit/events/${event.id}/sponsorship-tiers`)
      .set(authHeader(manager))
      .send({
        tiers: [
          { name: 'Platinum', benefits: 'Logo on stage backdrop', price: '5000.00', currency: 'USD' },
          { name: 'Gold', benefits: 'Logo on programme' },
        ],
      });
    expect(tiersRes.status).toBe(200);
    expect(tiersRes.body.data.sponsorshipTiers).toHaveLength(2);
    const platinum = tiersRes.body.data.sponsorshipTiers.find((t) => t.name === 'Platinum');
    expect(platinum.money.amountMinor).toBe(500000);

    const partnerRes = await request(server).post('/api/v1/partners')
      .set(authHeader(manager)).send({ name: 'Kuhne Foundation' });
    const partnerId = partnerRes.body.data.id;

    const assignRes = await request(server).put(`/api/v1/summit/events/${event.id}/partners`)
      .set(authHeader(manager))
      .send({ partners: [{ partnerId, role: 'SPONSOR', sponsorshipTierId: platinum.id }] });

    expect(assignRes.status).toBe(200);
    expect(assignRes.body.data.partners[0].sponsorshipTierId).toBe(platinum.id);
  });

  test('an ordinary sponsor with no tier is still valid', async () => {
    const event = await createDraft();
    const partnerRes = await request(server).post('/api/v1/partners')
      .set(authHeader(manager)).send({ name: 'ASU' });
    const partnerId = partnerRes.body.data.id;

    const res = await request(server).put(`/api/v1/summit/events/${event.id}/partners`)
      .set(authHeader(manager))
      .send({ partners: [{ partnerId, role: 'SPONSOR' }] });

    expect(res.status).toBe(200);
    expect(res.body.data.partners[0].sponsorshipTierId).toBeNull();
  });
});

describe('public discovery', () => {
  test('a published Summit is listed alongside CPD events, filterable by type', async () => {
    const event = await createDraft();
    await setPrices(event.id, standard);
    await request(server).post(`/api/v1/summit/events/${event.id}/publish`).set(authHeader(director)).send({});

    const res = await request(server).get('/api/v1/events').query({ type: 'summit' });
    expect(res.status).toBe(200);
    expect(res.body.data.some((e) => e.id === event.id)).toBe(true);
    expect(res.body.data.every((e) => e.type.key === 'summit')).toBe(true);
  });
});

describe('registering for a Summit', () => {
  /*
   * The reference prefix used to be a hardcoded "event_type_id === 1 ? CPD
   * : EVT" check — meaning every non-CPD module, Summit included, got the
   * generic "CAR-EVT-..." rather than anything naming itself. Fixed to
   * derive the prefix from the event's own type key instead.
   */
  test('the reference names the module, not a generic fallback', async () => {
    const event = await createDraft();
    await setPrices(event.id, [{ label: 'Standard', amount: '0.00', currency: 'USD', isDefault: true }]);
    await request(server).post(`/api/v1/summit/events/${event.id}/publish`).set(authHeader(director)).send({});
    await request(server).post(`/api/v1/summit/events/${event.id}/open-registration`).set(authHeader(director)).send({});

    const participant = await makeUser({ roleKey: 'participant' });
    const res = await request(server).post('/api/v1/registrations')
      .set(authHeader(participant)).send({ eventId: Number(event.id), mediaConsent: true });

    expect(res.status).toBe(201);
    expect(res.body.data.registration.reference).toMatch(/^CAR-SUMMIT-\d{2}-[A-Z0-9]{6}$/);
  });
});
