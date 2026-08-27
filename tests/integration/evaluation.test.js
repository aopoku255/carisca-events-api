import request from 'supertest';
import { jest } from '@jest/globals';
import {
  prepareDatabase, teardown, makeUser, authHeader, app, flushPermissionCache, models,
} from '../helpers/setup.js';

jest.setTimeout(120_000);

const {
  Event, EventType, EventPrice, EvaluationResponse,
} = models;

let server;
let cpdType;
let manager; // cpd.update etc, evaluation.view only — not .manage/.export
let mne; // monitoring_evaluation: evaluation.view/.manage/.export

beforeAll(async () => {
  await prepareDatabase();
  server = app();
  cpdType = await EventType.findOne({ where: { key: 'cpd' } });
  manager = await makeUser({ roleKey: 'manager', isStaff: true });
  mne = await makeUser({ roleKey: 'monitoring_evaluation', isStaff: true });
});
afterAll(teardown);
beforeEach(flushPermissionCache);

let seq = 0;
/** Finished by default (`end_at` in the past), same convention certificate.test.js already uses. */
async function makeEvent({
  issuesCertificate = true,
  certificateRequiresEvaluation = false,
  startAt = new Date(Date.now() - 7 * 864e5),
  endAt = new Date(Date.now() - 7 * 864e5 + 3 * 3600e3),
} = {}) {
  seq += 1;
  const event = await Event.create({
    event_type_id: cpdType.id,
    slug: `eval-evt-${Date.now()}-${seq}`,
    title: `Evaluation Test Event ${seq}`,
    start_at: startAt,
    end_at: endAt,
    timezone: 'Africa/Accra',
    delivery_mode: 'HYBRID',
    country_code: 'GH',
    venue: 'KNUST School of Business',
    status: 'REGISTRATION_OPEN',
    issues_certificate: issuesCertificate,
    certificate_requires_evaluation: certificateRequiresEvaluation,
  });
  await EventPrice.create({
    event_id: event.id, tier: 'standard', label: 'Standard', amount_minor: 0, currency: 'USD', is_default: true,
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

const saveQuestions = (eventId, questions, as = mne) => request(server)
  .put(`/api/v1/cpd/events/${eventId}/evaluation-questions`)
  .set(authHeader(as)).send({ questions });

const RATING_Q = { label: 'How was the workshop?', type: 'RATING', required: true, sortOrder: 10 };
const NPS_Q = { label: 'How likely are you to recommend this?', type: 'NPS', required: false, sortOrder: 20 };

describe('admin: saving survey questions', () => {
  test('a manager (view only) cannot save them', async () => {
    const event = await makeEvent();
    const res = await saveQuestions(event.id, [RATING_Q], manager);
    expect(res.status).toBe(403);
  });

  test('monitoring & evaluation can save, and they ride along on the event', async () => {
    const event = await makeEvent();
    const save = await saveQuestions(event.id, [RATING_Q, NPS_Q]);
    expect(save.status).toBe(200);
    expect(save.body.data.evaluationQuestions).toHaveLength(2);
    expect(save.body.data.evaluationQuestions.map((q) => q.type)).toEqual(['RATING', 'NPS']);

    const get = await request(server).get(`/api/v1/cpd/events/${event.id}`).set(authHeader(mne));
    expect(get.body.data.evaluationQuestions).toHaveLength(2);
  });

  test('re-saving replaces the set rather than appending to it', async () => {
    const event = await makeEvent();
    await saveQuestions(event.id, [RATING_Q, NPS_Q]);
    const second = await saveQuestions(event.id, [RATING_Q]);
    expect(second.body.data.evaluationQuestions).toHaveLength(1);
  });
});

describe('submitting the survey', () => {
  test('is refused before the event has finished', async () => {
    const event = await makeEvent({
      startAt: new Date(Date.now() + 7 * 864e5), endAt: new Date(Date.now() + 7 * 864e5 + 3 * 3600e3),
    });
    await saveQuestions(event.id, [RATING_Q]);
    const user = await participant();
    const reference = await confirmedRegistration({ event, user });

    const res = await request(server).post(`/api/v1/registrations/${reference}/evaluation`)
      .set(authHeader(user)).send({ answers: { } });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EVENT_NOT_FINISHED');
  });

  test('a missing required rating is rejected', async () => {
    const event = await makeEvent();
    await saveQuestions(event.id, [RATING_Q]);
    const user = await participant();
    const reference = await confirmedRegistration({ event, user });

    const res = await request(server).post(`/api/v1/registrations/${reference}/evaluation`)
      .set(authHeader(user)).send({ answers: {} });

    expect(res.status).toBe(422);

    const count = await EvaluationResponse.count();
    expect(count).toBe(0);
  });

  test('an out-of-range rating is rejected', async () => {
    const event = await makeEvent();
    const saved = await saveQuestions(event.id, [RATING_Q]);
    const questionId = saved.body.data.evaluationQuestions[0].id;
    const user = await participant();
    const reference = await confirmedRegistration({ event, user });

    const res = await request(server).post(`/api/v1/registrations/${reference}/evaluation`)
      .set(authHeader(user)).send({ answers: { [questionId]: '7' } });

    expect(res.status).toBe(422);
  });

  test('a valid submission succeeds, and resubmitting replaces rather than duplicates', async () => {
    const event = await makeEvent();
    const saved = await saveQuestions(event.id, [RATING_Q, NPS_Q]);
    const [ratingId, npsId] = saved.body.data.evaluationQuestions.map((q) => q.id);
    const user = await participant();
    const reference = await confirmedRegistration({ event, user });

    const first = await request(server).post(`/api/v1/registrations/${reference}/evaluation`)
      .set(authHeader(user)).send({ answers: { [ratingId]: '4', [npsId]: '9' } });
    expect(first.status).toBe(200);

    const second = await request(server).post(`/api/v1/registrations/${reference}/evaluation`)
      .set(authHeader(user)).send({ answers: { [ratingId]: '5', [npsId]: '10' } });
    expect(second.status).toBe(200);

    const responses = await EvaluationResponse.findAll();
    expect(responses).toHaveLength(2); // not 4 — the resubmission replaced, not appended
    const rating = responses.find((r) => Number(r.question_id) === Number(ratingId));
    expect(Number(rating.numeric_value)).toBe(5);

    const view = await request(server).get(`/api/v1/registrations/${reference}/evaluation`).set(authHeader(user));
    expect(view.body.data.answers[String(ratingId)]).toBe('5');
  });
});

describe('the certificate gate', () => {
  test('an event that does not require evaluation is never blocked, even with no survey at all', async () => {
    const event = await makeEvent({ certificateRequiresEvaluation: false });
    const user = await participant();
    const reference = await confirmedRegistration({ event, user });

    const res = await request(server).get(`/api/v1/registrations/${reference}/certificate`).set(authHeader(user));
    expect(res.status).toBe(200);
  });

  test('requiring evaluation with no questions ever configured does not block either', async () => {
    const event = await makeEvent({ certificateRequiresEvaluation: true });
    const user = await participant();
    const reference = await confirmedRegistration({ event, user });

    const res = await request(server).get(`/api/v1/registrations/${reference}/certificate`).set(authHeader(user));
    expect(res.status).toBe(200);
  });

  test('an unanswered required survey blocks the certificate; answering it unblocks', async () => {
    const event = await makeEvent({ certificateRequiresEvaluation: true });
    const saved = await saveQuestions(event.id, [RATING_Q]);
    const questionId = saved.body.data.evaluationQuestions[0].id;
    const user = await participant();
    const reference = await confirmedRegistration({ event, user });

    const blocked = await request(server).get(`/api/v1/registrations/${reference}/certificate`).set(authHeader(user));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('EVALUATION_REQUIRED');

    const summary = await request(server).get(`/api/v1/registrations/${reference}`).set(authHeader(user));
    expect(summary.body.data.certificate).toEqual({
      eligible: false, code: 'EVALUATION_REQUIRED', reason: expect.any(String),
    });

    await request(server).post(`/api/v1/registrations/${reference}/evaluation`)
      .set(authHeader(user)).send({ answers: { [questionId]: '4' } });

    const allowed = await request(server).get(`/api/v1/registrations/${reference}/certificate`).set(authHeader(user));
    expect(allowed.status).toBe(200);
  });
});

describe('permissions on the responses summary and export', () => {
  test('a manager (view only) can see the summary but cannot export', async () => {
    const event = await makeEvent();
    const view = await request(server).get(`/api/v1/cpd/events/${event.id}/evaluation-responses`).set(authHeader(manager));
    expect(view.status).toBe(200);

    const exportRes = await request(server).get(`/api/v1/cpd/events/${event.id}/evaluation-responses/export`).set(authHeader(manager));
    expect(exportRes.status).toBe(403);
  });

  test('monitoring & evaluation can export a CSV of submitted responses', async () => {
    const event = await makeEvent();
    const saved = await saveQuestions(event.id, [RATING_Q]);
    const questionId = saved.body.data.evaluationQuestions[0].id;
    const user = await participant();
    const reference = await confirmedRegistration({ event, user });
    await request(server).post(`/api/v1/registrations/${reference}/evaluation`)
      .set(authHeader(user)).send({ answers: { [questionId]: '5' } });

    const res = await request(server).get(`/api/v1/cpd/events/${event.id}/evaluation-responses/export`).set(authHeader(mne));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain(reference);
  });
});
