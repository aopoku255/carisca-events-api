import request from 'supertest';
import { jest } from '@jest/globals';
import {
  prepareDatabase, teardown, makeUser, authHeader, app, flushPermissionCache, models,
} from '../helpers/setup.js';
import * as registrationService from '../../src/core/registrations/registration.service.js';

jest.setTimeout(120_000);

const { Event, EventPrice, Notification } = models;

let server;
let manager;   // can create and edit, cannot publish
let director;  // can publish, cannot create
let admin;     // can do everything

beforeAll(async () => {
  await prepareDatabase();
  server = app();
  manager = await makeUser({ roleKey: 'manager', isStaff: true });
  director = await makeUser({ roleKey: 'director', isStaff: true });
  admin = await makeUser({ roleKey: 'super_admin', isStaff: true });
});
afterAll(teardown);
beforeEach(flushPermissionCache);

const future = (days) => new Date(Date.now() + days * 864e5).toISOString();

const draft = (overrides = {}) => ({
  title: 'Supply Chain Analytics for Decision-Making',
  shortDescription: 'A two-day practitioner workshop.',
  startAt: future(30),
  endAt: future(31),
  timezone: 'Africa/Accra',
  deliveryMode: 'OFFLINE',
  countryCode: 'GH',
  city: 'Kumasi',
  venue: 'KNUST School of Business',
  capacity: 40,
  ...overrides,
});

async function createDraft(overrides = {}, as = manager) {
  const res = await request(server).post('/api/v1/cpd/events').set(authHeader(as)).send(draft(overrides));
  expect(res.status).toBe(201);
  return res.body.data;
}

async function setPrices(eventId, prices, as = manager) {
  return request(server).put(`/api/v1/cpd/events/${eventId}/prices`).set(authHeader(as)).send({ prices });
}

const standard = [{ label: 'Standard', amount: '150.00', currency: 'USD', isDefault: true }];

describe('creating a CPD', () => {
  test('a manager creates it as a draft with a generated slug', async () => {
    const event = await createDraft();
    expect(event.status).toBe('DRAFT');
    expect(event.slug).toMatch(/^supply-chain-analytics-for-decision-making/);
    expect(event.type.key).toBe('cpd');
  });

  test('a director cannot create one', async () => {
    const res = await request(server).post('/api/v1/cpd/events').set(authHeader(director)).send(draft());
    expect(res.status).toBe(403);
  });

  test('an end date before the start date is rejected', async () => {
    const res = await request(server).post('/api/v1/cpd/events').set(authHeader(manager))
      .send(draft({ startAt: future(10), endAt: future(5) }));
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toMatch(/cannot end before it starts/);
  });

  test('CPD-specific detail is stored on the extension table', async () => {
    const event = await createDraft({
      cpd: {
        cpdCredits: 12.5,
        accreditingBody: 'CIPS',
        learningObjectives: ['Interpret supply chain data', 'Build a decision dashboard'],
        targetAudience: ['Supply chain managers'],
      },
    });
    expect(event.cpd.credits).toBe(12.5);
    expect(event.cpd.accreditingBody).toBe('CIPS');
    expect(event.cpd.learningObjectives).toHaveLength(2);
  });

  test('staff without any CPD permission are refused', async () => {
    const itAdmin = await makeUser({ roleKey: 'it_admin', isStaff: true });
    expect((await request(server).get('/api/v1/cpd/events').set(authHeader(itAdmin))).status).toBe(403);
  });

  test('participants cannot reach the admin routes at all', async () => {
    const participant = await makeUser({ roleKey: 'participant' });
    expect((await request(server).get('/api/v1/cpd/events').set(authHeader(participant))).status).toBe(403);
  });
});

describe('publish validation', () => {
  test('an event with no price cannot be published', async () => {
    const event = await createDraft();
    const res = await request(server).post(`/api/v1/cpd/events/${event.id}/publish`)
      .set(authHeader(director)).send({});

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NOT_PUBLISHABLE');
    expect(res.body.error.details.problems.join(' ')).toMatch(/at least one price/);
  });

  test('an in-person event with no venue cannot be published', async () => {
    const event = await createDraft({ venue: undefined });
    await setPrices(event.id, standard);

    const res = await request(server).post(`/api/v1/cpd/events/${event.id}/publish`)
      .set(authHeader(director)).send({});
    expect(res.body.error.details.problems.join(' ')).toMatch(/needs a venue/);
  });

  test('an online event with no joining link cannot be published', async () => {
    const event = await createDraft({ deliveryMode: 'ONLINE', venue: undefined });
    await setPrices(event.id, standard);

    const res = await request(server).post(`/api/v1/cpd/events/${event.id}/publish`)
      .set(authHeader(director)).send({});
    expect(res.body.error.details.problems.join(' ')).toMatch(/joining link/);
  });

  test('a percentage attendance rule needs a percentage and required sessions', async () => {
    const event = await createDraft({ attendanceRule: 'SESSION_PERCENT' });
    await setPrices(event.id, standard);

    const res = await request(server).post(`/api/v1/cpd/events/${event.id}/publish`)
      .set(authHeader(director)).send({});
    const problems = res.body.error.details.problems.join(' ');
    expect(problems).toMatch(/minimum percentage/);
    expect(problems).toMatch(/at least one required session/);
  });

  test('registration closing after the event ends is rejected', async () => {
    const event = await createDraft({ registrationClosesAt: future(60) });
    await setPrices(event.id, standard);

    const res = await request(server).post(`/api/v1/cpd/events/${event.id}/publish`)
      .set(authHeader(director)).send({});
    expect(res.body.error.details.problems.join(' ')).toMatch(/after the event has finished/);
  });

  test('a fully configured event publishes', async () => {
    const event = await createDraft();
    await setPrices(event.id, standard);

    const res = await request(server).post(`/api/v1/cpd/events/${event.id}/publish`)
      .set(authHeader(director)).send({});

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('PUBLISHED');
    expect(res.body.data.publishedAt).toBeTruthy();
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

    expect((await request(server).post(`/api/v1/cpd/events/${event.id}/publish`)
      .set(authHeader(manager)).send({})).status).toBe(403);

    expect((await request(server).post(`/api/v1/cpd/events/${event.id}/publish`)
      .set(authHeader(director)).send({})).status).toBe(200);
  });

  test('the full happy path runs draft → archived', async () => {
    const event = await publishable();
    const step = (path, as = admin) => request(server)
      .post(`/api/v1/cpd/events/${event.id}/${path}`).set(authHeader(as)).send({});

    expect((await step('publish')).body.data.status).toBe('PUBLISHED');
    expect((await step('open-registration')).body.data.status).toBe('REGISTRATION_OPEN');
    expect((await step('close-registration')).body.data.status).toBe('REGISTRATION_CLOSED');
    expect((await step('start')).body.data.status).toBe('ONGOING');
    expect((await step('complete')).body.data.status).toBe('COMPLETED');
    expect((await step('archive')).body.data.status).toBe('ARCHIVED');
  });

  test('an out-of-order transition is refused with the allowed origins', async () => {
    const event = await publishable();

    const res = await request(server).post(`/api/v1/cpd/events/${event.id}/complete`)
      .set(authHeader(admin)).send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
    expect(res.body.error.details.current).toBe('DRAFT');
    expect(res.body.error.details.allowedFrom).toContain('ONGOING');
  });

  test('status cannot be forced through the update endpoint', async () => {
    const event = await publishable();

    await request(server).patch(`/api/v1/cpd/events/${event.id}`)
      .set(authHeader(manager)).send({ status: 'COMPLETED' });

    const after = await Event.findByPk(event.id);
    expect(after.status).toBe('DRAFT');
  });

  test('an archived event cannot be edited', async () => {
    const event = await publishable();
    for (const p of ['publish', 'start', 'complete', 'archive']) {
      // eslint-disable-next-line no-await-in-loop
      await request(server).post(`/api/v1/cpd/events/${event.id}/${p}`).set(authHeader(admin)).send({});
    }

    const res = await request(server).patch(`/api/v1/cpd/events/${event.id}`)
      .set(authHeader(manager)).send({ title: 'Renamed' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EVENT_ARCHIVED');
  });

  test('cancelling records the reason and emails everyone registered', async () => {
    const event = await publishable();
    await request(server).post(`/api/v1/cpd/events/${event.id}/publish`).set(authHeader(director)).send({});
    await request(server).post(`/api/v1/cpd/events/${event.id}/open-registration`).set(authHeader(admin)).send({});

    const participant = await makeUser({ roleKey: 'participant' });
    await registrationService.register({ eventId: event.id, user: participant });

    const res = await request(server).post(`/api/v1/cpd/events/${event.id}/cancel`)
      .set(authHeader(manager)).send({ reason: 'Facilitator unavailable' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
    expect(res.body.data.cancelledReason).toBe('Facilitator unavailable');

    const queued = await Notification.findOne({
      where: { user_id: participant.id, template: 'event_cancelled' },
    });
    expect(queued).toBeTruthy();
    expect(queued.payload.reason).toBe('Facilitator unavailable');
  });

  test('changing the date notifies confirmed registrants', async () => {
    const event = await publishable();
    await request(server).post(`/api/v1/cpd/events/${event.id}/publish`).set(authHeader(director)).send({});
    await request(server).post(`/api/v1/cpd/events/${event.id}/open-registration`).set(authHeader(admin)).send({});

    const participant = await makeUser({ roleKey: 'participant' });
    await registrationService.register({ eventId: event.id, user: participant });

    await request(server).patch(`/api/v1/cpd/events/${event.id}`)
      .set(authHeader(manager)).send({ startAt: future(45), endAt: future(46) });

    const queued = await Notification.findOne({
      where: { user_id: participant.id, template: 'event_updated' },
    });
    expect(queued).toBeTruthy();
    expect(queued.payload.changed).toEqual(expect.arrayContaining(['start_at']));
  });
});

describe('prices', () => {
  test('a decimal amount is converted to minor units server-side', async () => {
    const event = await createDraft();
    await setPrices(event.id, [
      { label: 'Virtual', attendanceMode: 'VIRTUAL', amount: '25.00', currency: 'USD', isDefault: true },
      { label: 'In-Person (Africa)', attendanceMode: 'IN_PERSON', audience: 'AFRICA', amount: '50.00', currency: 'USD' },
      { label: 'In-Person (Ghana)', attendanceMode: 'IN_PERSON', amount: '1500.00', currency: 'GHS' },
    ]);

    const rows = await EventPrice.findAll({ where: { event_id: event.id }, order: [['amount_minor', 'ASC']] });
    expect(rows.map((r) => Number(r.amount_minor))).toEqual([2500, 5000, 150000]);
  });

  test('a malformed amount is rejected rather than coerced', async () => {
    const event = await createDraft();
    const res = await setPrices(event.id, [{ label: 'Bad', amount: '15,00', currency: 'USD' }]);
    expect(res.status).toBe(422);
  });

  test('a currency people are registered at cannot be withdrawn', async () => {
    const event = await createDraft();
    await setPrices(event.id, standard);
    await request(server).post(`/api/v1/cpd/events/${event.id}/publish`).set(authHeader(director)).send({});
    await request(server).post(`/api/v1/cpd/events/${event.id}/open-registration`).set(authHeader(admin)).send({});

    const participant = await makeUser({ roleKey: 'participant' });
    await registrationService.register({ eventId: event.id, user: participant, preferredCurrency: 'USD' });

    const res = await setPrices(event.id, [{ label: 'Cedis only', amount: '1500.00', currency: 'GHS' }]);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CURRENCY_IN_USE');
    expect(res.body.error.details.inUse).toContain('USD');
  });

  test('prices can still be restructured within the same currency', async () => {
    const event = await createDraft();
    await setPrices(event.id, standard);
    await request(server).post(`/api/v1/cpd/events/${event.id}/publish`).set(authHeader(director)).send({});
    await request(server).post(`/api/v1/cpd/events/${event.id}/open-registration`).set(authHeader(admin)).send({});

    const participant = await makeUser({ roleKey: 'participant' });
    await registrationService.register({ eventId: event.id, user: participant, preferredCurrency: 'USD' });

    const res = await setPrices(event.id, [
      { label: 'Standard', amount: '175.00', currency: 'USD', isDefault: true },
      { label: 'Student', tier: 'student', amount: '40.00', currency: 'USD' },
    ]);
    expect(res.status).toBe(200);

    // The existing registration keeps the amount it was quoted.
    const held = await models.Registration.findOne({ where: { event_id: event.id, user_id: participant.id } });
    expect(Number(held.price_amount_minor)).toBe(15000);
  });
});

describe('registration questions', () => {
  test('a manager can define them and they appear on the public page', async () => {
    const event = await createDraft();
    await setPrices(event.id, standard);

    const res = await request(server).put(`/api/v1/cpd/events/${event.id}/questions`)
      .set(authHeader(manager))
      .send({
        questions: [
          { label: 'What is your organization?', type: 'TEXT', required: true },
          {
            label: 'Which sessions will you attend?',
            type: 'MULTISELECT',
            required: false,
            options: [{ value: 'day1', label: 'Day 1' }, { value: 'day2', label: 'Day 2' }],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.questions).toHaveLength(2);

    await request(server).post(`/api/v1/cpd/events/${event.id}/publish`).set(authHeader(director)).send({});
    const publicView = await request(server).get(`/api/v1/events/${res.body.data.slug}`);

    expect(publicView.status).toBe(200);
    expect(publicView.body.data.questions[0].label).toBe('What is your organization?');
    expect(publicView.body.data.questions[0].required).toBe(true);
  });

  test('a choice question with no options is rejected', async () => {
    const event = await createDraft();
    const res = await request(server).put(`/api/v1/cpd/events/${event.id}/questions`)
      .set(authHeader(manager))
      .send({ questions: [{ label: 'Pick one', type: 'SELECT', required: true }] });

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toMatch(/at least one option/);
  });

  test('a director cannot change the question set', async () => {
    const event = await createDraft();
    const res = await request(server).put(`/api/v1/cpd/events/${event.id}/questions`)
      .set(authHeader(director)).send({ questions: [] });
    expect(res.status).toBe(403);
  });
});

describe('public discovery', () => {
  test('drafts are invisible and published events are listed', async () => {
    // Unique titles and a search filter, so this cannot be knocked over by
    // whatever other suites happen to have created.
    const tag = `Zeta${Date.now()}`;
    const hidden = await createDraft({ title: `Unlisted planning day ${tag}` });
    const shown = await createDraft({ title: `Public masterclass ${tag}` });
    await setPrices(shown.id, standard);
    await request(server).post(`/api/v1/cpd/events/${shown.id}/publish`).set(authHeader(director)).send({});

    const res = await request(server).get(`/api/v1/events?limit=50&q=${tag}`);
    expect(res.status).toBe(200);

    const titles = res.body.data.map((e) => e.title);
    expect(titles).toContain(`Public masterclass ${tag}`);
    expect(titles).not.toContain(`Unlisted planning day ${tag}`);

    expect((await request(server).get(`/api/v1/events/${hidden.slug}`)).status).toBe(404);
  });

  test('the public view withholds the joining link and exact headcount', async () => {
    const event = await createDraft({ deliveryMode: 'HYBRID', onlineUrl: 'https://zoom.test/secret-room' });
    await setPrices(event.id, standard);
    await request(server).post(`/api/v1/cpd/events/${event.id}/publish`).set(authHeader(director)).send({});

    const res = await request(server).get(`/api/v1/events/${event.slug}`);
    const body = JSON.stringify(res.body);

    expect(body).not.toContain('secret-room');
    expect(body).not.toContain('createdBy');
    // Availability is a yes/no, not a headcount.
    expect(res.body.data.availability.inPerson).toEqual({ isFull: false });
  });

  test('reference data for the registration form is public', async () => {
    const res = await request(server).get('/api/v1/reference');

    expect(res.status).toBe(200);
    expect(res.body.data.positions).toHaveLength(16);
    expect(res.body.data.sectors).toHaveLength(6);
    expect(res.body.data.positions.find((p) => p.key === 'student').requiresStudentId).toBe(true);
    expect(res.body.data.countries.find((c) => c.code === 'GH')).toMatchObject({
      region: 'Africa', defaultCurrency: 'GHS',
    });
    // Offered as a suggestion the form can extend, not a locked enum.
    expect(res.body.data.genders).toContain('Prefer not to say');
  });

  test('past and upcoming events can be filtered apart', async () => {
    const past = await createDraft({ title: 'Last year workshop', startAt: future(-400), endAt: future(-399) });
    await setPrices(past.id, standard);
    await request(server).post(`/api/v1/cpd/events/${past.id}/publish`).set(authHeader(director)).send({});

    const upcoming = await request(server).get('/api/v1/events?when=upcoming&limit=50');
    expect(upcoming.body.data.map((e) => e.title)).not.toContain('Last year workshop');

    const before = await request(server).get('/api/v1/events?when=past&limit=50');
    expect(before.body.data.map((e) => e.title)).toContain('Last year workshop');
  });
});

describe('admin listing', () => {
  test('search, status filter and pagination work server-side', async () => {
    const unique = `Zephyr ${Date.now()}`;
    const event = await createDraft({ title: unique });
    await setPrices(event.id, standard);

    const found = await request(server).get(`/api/v1/cpd/events?q=${encodeURIComponent('Zephyr')}`)
      .set(authHeader(manager));
    expect(found.body.data.some((e) => e.title === unique)).toBe(true);

    const drafts = await request(server).get('/api/v1/cpd/events?status=DRAFT&limit=5')
      .set(authHeader(manager));
    expect(drafts.body.data.every((e) => e.status === 'DRAFT')).toBe(true);
    expect(drafts.body.meta).toMatchObject({ page: 1, limit: 5 });
    expect(drafts.body.meta.total).toBeGreaterThan(0);
  });

  test('the admin view does show occupancy', async () => {
    const event = await createDraft({ capacity: 10 });
    await setPrices(event.id, standard);

    const res = await request(server).get(`/api/v1/cpd/events/${event.id}`).set(authHeader(manager));
    expect(res.body.data.occupancy.inPerson).toMatchObject({ capacity: 10, taken: 0, isFull: false });
  });
});
