import request from 'supertest';
import { jest } from '@jest/globals';
import {
  prepareDatabase, teardown, makeUser, authHeader, app, flushPermissionCache, models,
} from '../helpers/setup.js';

jest.setTimeout(120_000);

const { EventType, Event } = models;

let server;
let manager;
let director;
let researcher;
let stranger;

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]);

beforeAll(async () => {
  await prepareDatabase();
  server = app();
  manager = await makeUser({ roleKey: 'manager', isStaff: true });
  director = await makeUser({ roleKey: 'director', isStaff: true });
  researcher = await makeUser({ roleKey: 'participant' });
  stranger = await makeUser({ roleKey: 'participant' });
});
afterAll(teardown);
beforeEach(flushPermissionCache);

const future = (days) => new Date(Date.now() + days * 864e5).toISOString();
const past = (days) => new Date(Date.now() - days * 864e5).toISOString();

async function makeSummit(summitOverrides = {}) {
  const res = await request(server).post('/api/v1/summit/events').set(authHeader(manager)).send({
    title: `Summit ${Date.now()}`,
    startAt: future(60),
    endAt: future(62),
    timezone: 'Africa/Accra',
    deliveryMode: 'OFFLINE',
    countryCode: 'GH',
    city: 'Kumasi',
    venue: 'KNUST School of Business',
    summit: summitOverrides,
  });
  expect(res.status).toBe(201);
  return res.body.data;
}

const proposal = (eventId, overrides = {}) => ({
  eventId: Number(eventId),
  title: 'Digitising Last-Mile Logistics in West Africa',
  abstractText: 'This paper examines how digital tools reshape last-mile delivery across West African cities.',
  ...overrides,
});

describe('submitting an abstract', () => {
  test('a signed-in researcher can submit to a Summit', async () => {
    const event = await makeSummit();
    const res = await request(server).post('/api/v1/summit/abstracts')
      .set(authHeader(researcher)).send(proposal(event.id));

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('SUBMITTED');
    expect(res.body.data.reference).toMatch(/^CAR-ABS-\d{2}-/);
    expect(res.body.data.title).toBe('Digitising Last-Mile Logistics in West Africa');
  });

  test('an anonymous caller cannot submit', async () => {
    const event = await makeSummit();
    const res = await request(server).post('/api/v1/summit/abstracts').send(proposal(event.id));
    expect(res.status).toBe(401);
  });

  test('submitting to a non-existent event is a clean 404', async () => {
    const res = await request(server).post('/api/v1/summit/abstracts')
      .set(authHeader(researcher)).send(proposal(999999));
    expect(res.status).toBe(404);
  });

  test('past the call-for-papers deadline, submission is refused', async () => {
    const event = await makeSummit({ callForPapersOpensAt: past(30), callForPapersClosesAt: past(1) });
    const res = await request(server).post('/api/v1/summit/abstracts')
      .set(authHeader(researcher)).send(proposal(event.id));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CALL_FOR_PAPERS_CLOSED');
  });

  test('with no deadline set, the call stays open indefinitely', async () => {
    const event = await makeSummit();
    const res = await request(server).post('/api/v1/summit/abstracts')
      .set(authHeader(researcher)).send(proposal(event.id));
    expect(res.status).toBe(201);
  });

  test('a track can be requested at submission and is reflected back', async () => {
    const event = await makeSummit();
    const tracksRes = await request(server).put(`/api/v1/summit/events/${event.id}/tracks`)
      .set(authHeader(manager)).send({ tracks: [{ name: 'Track A' }] });
    const trackId = tracksRes.body.data.tracks[0].id;

    const res = await request(server).post('/api/v1/summit/abstracts')
      .set(authHeader(researcher)).send(proposal(event.id, { trackId }));

    expect(res.status).toBe(201);
    expect(res.body.data.track.id).toBe(String(trackId));
  });

  test('a paper can be attached — uploaded on the researcher\'s behalf, the same pattern registration evidence already uses', async () => {
    const event = await makeSummit();
    const upload = await request(server).post('/api/v1/files/upload')
      .set(authHeader(manager))
      .field('purpose', 'abstract_paper')
      .attach('file', PDF, { filename: 'paper.pdf', contentType: 'application/pdf' });
    expect(upload.status).toBe(201);

    const res = await request(server).post('/api/v1/summit/abstracts')
      .set(authHeader(researcher)).send(proposal(event.id, { paperFileId: Number(upload.body.data.id) }));

    expect(res.status).toBe(201);
    expect(res.body.data.paper).toBeTruthy();
  });
});

describe('a researcher managing their own submissions', () => {
  test('mine lists only what they submitted', async () => {
    const event = await makeSummit();
    // A fresh author here, not the shared `researcher` — that account
    // submits in several other tests in this file, and "mine" is meant to
    // prove isolation from EVERYONE else's submissions, not just this one.
    const author = await makeUser({ roleKey: 'participant' });
    await request(server).post('/api/v1/summit/abstracts').set(authHeader(author)).send(proposal(event.id));
    await request(server).post('/api/v1/summit/abstracts').set(authHeader(stranger))
      .send(proposal(event.id, { title: 'Someone else\'s paper' }));

    const res = await request(server).get('/api/v1/summit/abstracts/mine').set(authHeader(author));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].title).toBe('Digitising Last-Mile Logistics in West Africa');
  });

  test('someone else\'s submission is invisible, not merely forbidden', async () => {
    const event = await makeSummit();
    const created = await request(server).post('/api/v1/summit/abstracts')
      .set(authHeader(researcher)).send(proposal(event.id));

    const res = await request(server).get(`/api/v1/summit/abstracts/mine/${created.body.data.id}`)
      .set(authHeader(stranger));
    expect(res.status).toBe(404);
  });

  test('a submission can be edited while it is still SUBMITTED', async () => {
    const event = await makeSummit();
    const created = await request(server).post('/api/v1/summit/abstracts')
      .set(authHeader(researcher)).send(proposal(event.id));

    const res = await request(server).patch(`/api/v1/summit/abstracts/mine/${created.body.data.id}`)
      .set(authHeader(researcher)).send({ title: 'A revised title' });

    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('A revised title');
  });

  test('a submission can be withdrawn, and a withdrawn one cannot be edited again', async () => {
    const event = await makeSummit();
    const created = await request(server).post('/api/v1/summit/abstracts')
      .set(authHeader(researcher)).send(proposal(event.id));

    const withdrawn = await request(server).post(`/api/v1/summit/abstracts/mine/${created.body.data.id}/withdraw`)
      .set(authHeader(researcher));
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.data.status).toBe('WITHDRAWN');

    const edit = await request(server).patch(`/api/v1/summit/abstracts/mine/${created.body.data.id}`)
      .set(authHeader(researcher)).send({ title: 'Too late' });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('SUBMISSION_NOT_EDITABLE');
  });

  test('a decided submission can no longer be edited or withdrawn', async () => {
    const event = await makeSummit();
    const created = await request(server).post('/api/v1/summit/abstracts')
      .set(authHeader(researcher)).send(proposal(event.id));
    const id = created.body.data.id;

    await request(server).post(`/api/v1/summit/events/${event.id}/abstracts/${id}/decide`)
      .set(authHeader(director)).send({ decision: 'ACCEPTED' });

    const edit = await request(server).patch(`/api/v1/summit/abstracts/mine/${id}`)
      .set(authHeader(researcher)).send({ title: 'Too late' });
    expect(edit.status).toBe(409);

    const withdraw = await request(server).post(`/api/v1/summit/abstracts/mine/${id}/withdraw`)
      .set(authHeader(researcher));
    expect(withdraw.status).toBe(409);
  });
});

describe('staff review', () => {
  async function submitted(event = null) {
    const summit = event ?? await makeSummit();
    const res = await request(server).post('/api/v1/summit/abstracts')
      .set(authHeader(researcher)).send(proposal(summit.id));
    return { event: summit, submission: res.body.data };
  }

  test('the review queue needs abstract.view', async () => {
    const { event } = await submitted();
    const itAdmin = await makeUser({ roleKey: 'it_admin', isStaff: true });

    const denied = await request(server).get(`/api/v1/summit/events/${event.id}/abstracts`)
      .set(authHeader(itAdmin));
    expect(denied.status).toBe(403);

    const allowed = await request(server).get(`/api/v1/summit/events/${event.id}/abstracts`)
      .set(authHeader(manager));
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.length).toBeGreaterThan(0);
  });

  test('claiming for review needs abstract.review, not just abstract.view', async () => {
    const { event, submission } = await submitted();
    const monitoringEvaluation = await makeUser({ roleKey: 'monitoring_evaluation', isStaff: true });

    // M&E holds abstract.view + abstract.export but not abstract.review.
    const denied = await request(server)
      .post(`/api/v1/summit/events/${event.id}/abstracts/${submission.id}/claim`)
      .set(authHeader(monitoringEvaluation)).send({});
    expect(denied.status).toBe(403);

    const allowed = await request(server)
      .post(`/api/v1/summit/events/${event.id}/abstracts/${submission.id}/claim`)
      .set(authHeader(manager)).send({ notes: 'Looks promising, checking the methodology.' });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.status).toBe('UNDER_REVIEW');
    expect(allowed.body.data.reviewNotes).toMatch(/methodology/);
  });

  test('deciding needs abstract.decide — monitoring & evaluation cannot, a manager who runs the programme can', async () => {
    const { event, submission } = await submitted();
    // M&E holds abstract.view and abstract.export but not abstract.decide —
    // reading the pipeline and reporting on it is not the same authority as
    // making the call.
    const monitoringEvaluation = await makeUser({ roleKey: 'monitoring_evaluation', isStaff: true });

    const denied = await request(server)
      .post(`/api/v1/summit/events/${event.id}/abstracts/${submission.id}/decide`)
      .set(authHeader(monitoringEvaluation)).send({ decision: 'ACCEPTED' });
    expect(denied.status).toBe(403);

    const directorAttempt = await request(server)
      .post(`/api/v1/summit/events/${event.id}/abstracts/${submission.id}/decide`)
      .set(authHeader(director)).send({ decision: 'ACCEPTED', notes: 'Strong methodology.' });
    expect(directorAttempt.status).toBe(200);
    expect(directorAttempt.body.data.status).toBe('ACCEPTED');
    expect(directorAttempt.body.data.decidedBy.id).toBe(String(director.id));
  });

  test('an already-decided submission cannot be decided again', async () => {
    const { event, submission } = await submitted();
    await request(server).post(`/api/v1/summit/events/${event.id}/abstracts/${submission.id}/decide`)
      .set(authHeader(director)).send({ decision: 'REJECTED' });

    const again = await request(server)
      .post(`/api/v1/summit/events/${event.id}/abstracts/${submission.id}/decide`)
      .set(authHeader(director)).send({ decision: 'ACCEPTED' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SUBMISSION_ALREADY_DECIDED');
  });

  test('review notes never leak to the participant-facing view', async () => {
    const { event, submission } = await submitted();
    await request(server).post(`/api/v1/summit/events/${event.id}/abstracts/${submission.id}/claim`)
      .set(authHeader(manager)).send({ notes: 'Internal-only comment about weak sample size.' });

    const mine = await request(server).get(`/api/v1/summit/abstracts/mine/${submission.id}`)
      .set(authHeader(researcher));
    expect(mine.body.data.reviewNotes).toBeUndefined();
  });

  test('export needs abstract.export', async () => {
    const { event } = await submitted();
    const itAdmin = await makeUser({ roleKey: 'it_admin', isStaff: true });

    const denied = await request(server).get(`/api/v1/summit/events/${event.id}/abstracts/export`)
      .set(authHeader(itAdmin));
    expect(denied.status).toBe(403);

    const allowed = await request(server).get(`/api/v1/summit/events/${event.id}/abstracts/export`)
      .set(authHeader(manager));
    expect(allowed.status).toBe(200);
    expect(allowed.headers['content-type']).toMatch(/text\/csv/);
    expect(allowed.text).toMatch(/Digitising Last-Mile Logistics/);
  });
});
