import request from 'supertest';
import { jest } from '@jest/globals';
import {
  prepareDatabase, teardown, makeUser, authHeader, app, flushPermissionCache, models,
} from '../helpers/setup.js';
import * as registrationService from '../../src/core/registrations/registration.service.js';
import * as attendance from '../../src/core/attendance/attendance.service.js';

jest.setTimeout(120_000);

const { Event, EventType, EventPrice, EventSession, Registration, AttendanceRecord } = models;

let server;
let cpdType;
let staff;   // event_staff — can mark attendance
let manager;

beforeAll(async () => {
  await prepareDatabase();
  server = app();
  cpdType = await EventType.findOne({ where: { key: 'cpd' } });
  manager = await makeUser({ roleKey: 'manager', isStaff: true });
  staff = await makeUser({ roleKey: 'event_staff', isStaff: true });
});
afterAll(teardown);
beforeEach(flushPermissionCache);

let n = 0;
async function makeEvent({ sessions = 0, requiredSessions = null } = {}) {
  n += 1;
  const event = await Event.create({
    event_type_id: cpdType.id,
    slug: `att-${Date.now()}-${n}`,
    title: `Attendance CPD ${n}`,
    start_at: new Date(Date.now() + 864e5),
    end_at: new Date(Date.now() + 864e5 + 6 * 3600e3),
    timezone: 'Africa/Accra',
    delivery_mode: 'HYBRID',
    country_code: 'GH',
    venue: 'KNUST',
    online_url: 'https://example.test/j',
    status: 'REGISTRATION_OPEN',
    attendance_rule: sessions ? 'SESSION_PERCENT' : 'CHECK_IN',
    min_attendance_percent: sessions ? 80 : null,
  });
  await EventPrice.create({
    event_id: event.id, tier: 'standard', label: 'Free',
    amount_minor: 0, currency: 'GHS', is_default: true,
  });

  const made = [];
  for (let i = 0; i < sessions; i += 1) {
    const required = requiredSessions === null ? true : i < requiredSessions;
    // eslint-disable-next-line no-await-in-loop
    made.push(await EventSession.create({
      event_id: event.id,
      title: `Session ${i + 1}`,
      start_at: new Date(Date.now() + 864e5 + i * 3600e3),
      end_at: new Date(Date.now() + 864e5 + (i + 1) * 3600e3),
      is_required_for_attendance: required,
      sort_order: (i + 1) * 10,
    }));
  }
  return { event, sessions: made };
}

async function attendee(event, overrides = {}) {
  const user = await makeUser({ roleKey: 'participant' });
  await user.update({ organization: 'KNUST', ...overrides });
  const { registration } = await registrationService.register({
    eventId: event.id, user, mediaConsent: true,
  });
  const withQr = await Registration.scope('withQr').findByPk(registration.id);
  return { user, registration: withQr };
}

describe('scanning someone in', () => {
  test('a valid QR check-in returns the participant so staff can greet them', async () => {
    const { event } = await makeEvent();
    const { registration } = await attendee(event);

    const res = await request(server).post('/api/v1/attendance/scan')
      .set(authHeader(staff))
      .send({ qrToken: registration.qr_token, deviceInfo: 'Pixel 7 / Chrome' });

    expect(res.status).toBe(200);
    expect(res.body.data.result).toBe('CHECKED_IN');
    expect(res.body.data.participant.reference).toBe(registration.reference);
    expect(res.body.data.participant.name).toBeTruthy();
    expect(res.body.data.checkedInAt).toBeTruthy();
  });

  test('scanning the same badge twice does not create a second record', async () => {
    const { event } = await makeEvent();
    const { registration } = await attendee(event);
    const body = { qrToken: registration.qr_token };

    const first = await request(server).post('/api/v1/attendance/scan').set(authHeader(staff)).send(body);
    const second = await request(server).post('/api/v1/attendance/scan').set(authHeader(staff)).send(body);

    expect(first.body.data.result).toBe('CHECKED_IN');
    // Not an error: the queue keeps moving and staff see what happened.
    expect(second.status).toBe(200);
    expect(second.body.data.result).toBe('ALREADY_CHECKED_IN');
    expect(second.body.data.checkedInAt).toBe(first.body.data.checkedInAt);

    expect(await AttendanceRecord.count({ where: { registration_id: registration.id } })).toBe(1);
  });

  test('ten simultaneous scans of one badge still produce one record', async () => {
    const { event } = await makeEvent();
    const { registration } = await attendee(event);

    // A flaky connection replaying the same request.
    await Promise.allSettled(Array.from({ length: 10 }, () => attendance.checkIn({
      qrToken: registration.qr_token, actor: { id: staff.id, email: staff.email },
    })));

    expect(await AttendanceRecord.count({ where: { registration_id: registration.id } })).toBe(1);
  });

  test('check-in works by reference when a QR code will not scan', async () => {
    const { event } = await makeEvent();
    const { registration } = await attendee(event);

    const res = await request(server).post('/api/v1/attendance/scan')
      .set(authHeader(staff))
      .send({ reference: registration.reference.toLowerCase() }); // case-insensitive

    expect(res.status).toBe(200);
    expect(res.body.data.result).toBe('CHECKED_IN');
  });

  test('an unknown code is a clear 404, not a crash', async () => {
    const res = await request(server).post('/api/v1/attendance/scan')
      .set(authHeader(staff)).send({ qrToken: 'f'.repeat(32) });
    expect(res.status).toBe(404);
  });

  test('sending no identifier is refused', async () => {
    const res = await request(server).post('/api/v1/attendance/scan')
      .set(authHeader(staff)).send({});
    expect(res.status).toBe(422);
  });
});

describe('who gets through the door', () => {
  test('a cancelled registration is refused with the reason', async () => {
    const { event } = await makeEvent();
    const { user, registration } = await attendee(event);
    await registrationService.cancel(registration.id, { actor: { id: user.id, email: user.email } });

    const res = await request(server).post('/api/v1/attendance/scan')
      .set(authHeader(staff)).send({ qrToken: registration.qr_token });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_ADMISSIBLE');
    expect(res.body.message).toMatch(/cancelled/i);
  });

  test('a waitlisted person is refused — they are not registered', async () => {
    const { event } = await makeEvent();
    await event.update({ capacity: 1, allow_waitlist: true });
    await attendee(event);
    const { registration } = await attendee(event);

    expect(registration.status).toBe('WAITLISTED');

    const res = await request(server).post('/api/v1/attendance/scan')
      .set(authHeader(staff)).send({ qrToken: registration.qr_token });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/waitlist/i);
  });

  /**
   * Deliberate product decision: an unpaid attendee is admitted and flagged.
   * Turning a real person away at the door over a payment the desk can settle
   * is the wrong trade — payment is enforced at the certificate instead.
   */
  test('an unpaid attendee is admitted but flagged for the desk', async () => {
    const { event } = await makeEvent();
    await EventPrice.update({ amount_minor: 5000, currency: 'USD' }, { where: { event_id: event.id } });

    const user = await makeUser({ roleKey: 'participant' });
    const { registration } = await registrationService.register({ eventId: event.id, user });
    expect(registration.status).toBe('PENDING_PAYMENT');

    const withQr = await Registration.scope('withQr').findByPk(registration.id);
    const res = await request(server).post('/api/v1/attendance/scan')
      .set(authHeader(staff)).send({ qrToken: withQr.qr_token });

    expect(res.status).toBe(200);
    expect(res.body.data.result).toBe('CHECKED_IN');
    expect(res.body.data.warnings.join(' ')).toMatch(/payment is outstanding/i);
  });

  test('an online registrant walking in is admitted with a warning', async () => {
    const { event } = await makeEvent();
    const user = await makeUser({ roleKey: 'participant' });
    const { registration } = await registrationService.register({
      eventId: event.id, user, attendanceMode: 'VIRTUAL',
    });
    const withQr = await Registration.scope('withQr').findByPk(registration.id);

    const res = await request(server).post('/api/v1/attendance/scan')
      .set(authHeader(staff)).send({ qrToken: withQr.qr_token });

    expect(res.status).toBe(200);
    expect(res.body.data.warnings.join(' ')).toMatch(/online/i);
  });
});

describe('checking out', () => {
  test('records a departure, and re-scanning keeps the first time', async () => {
    const { event } = await makeEvent();
    const { registration } = await attendee(event);

    await request(server).post('/api/v1/attendance/scan')
      .set(authHeader(staff)).send({ qrToken: registration.qr_token });

    const out = await request(server).post('/api/v1/attendance/check-out')
      .set(authHeader(staff)).send({ qrToken: registration.qr_token });
    expect(out.body.data.result).toBe('CHECKED_OUT');

    const again = await request(server).post('/api/v1/attendance/check-out')
      .set(authHeader(staff)).send({ qrToken: registration.qr_token });
    expect(again.body.data.result).toBe('ALREADY_CHECKED_OUT');
    expect(again.body.data.checkedOutAt).toBe(out.body.data.checkedOutAt);
  });

  test('checking out someone who never checked in is refused', async () => {
    const { event } = await makeEvent();
    const { registration } = await attendee(event);

    const res = await request(server).post('/api/v1/attendance/check-out')
      .set(authHeader(staff)).send({ qrToken: registration.qr_token });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_CHECKED_IN');
  });
});

describe('per-session attendance', () => {
  test('each session is its own record', async () => {
    const { event, sessions } = await makeEvent({ sessions: 3 });
    const { registration } = await attendee(event);

    for (const s of sessions) {
      // eslint-disable-next-line no-await-in-loop
      await request(server).post('/api/v1/attendance/scan')
        .set(authHeader(staff)).send({ qrToken: registration.qr_token, sessionId: Number(s.id) });
    }

    expect(await AttendanceRecord.count({ where: { registration_id: registration.id } })).toBe(3);
  });

  test('a session from another event is rejected', async () => {
    const { event } = await makeEvent();
    const other = await makeEvent({ sessions: 1 });
    const { registration } = await attendee(event);

    const res = await request(server).post('/api/v1/attendance/scan')
      .set(authHeader(staff))
      .send({ qrToken: registration.qr_token, sessionId: Number(other.sessions[0].id) });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SESSION_MISMATCH');
  });

  test('the percentage counts only required sessions', async () => {
    // Four sessions, three required — attending the three required ones is 100%.
    const { event, sessions } = await makeEvent({ sessions: 4, requiredSessions: 3 });
    const { registration } = await attendee(event);

    for (const s of sessions.slice(0, 3)) {
      // eslint-disable-next-line no-await-in-loop
      await attendance.checkIn({
        registrationId: registration.id, sessionId: s.id, actor: { id: staff.id },
      });
    }

    const rate = await attendance.attendanceRate(registration.id);
    expect(rate.requiredSessions).toBe(3);
    expect(rate.percent).toBe(100);
  });

  test('missing sessions lowers the percentage', async () => {
    const { event, sessions } = await makeEvent({ sessions: 4 });
    const { registration } = await attendee(event);

    await attendance.checkIn({ registrationId: registration.id, sessionId: sessions[0].id });
    await attendance.checkIn({ registrationId: registration.id, sessionId: sessions[1].id });

    const rate = await attendance.attendanceRate(registration.id);
    expect(rate.percent).toBe(50); // 2 of 4
  });

  test('with no sessions configured, turning up is 100%', async () => {
    const { event } = await makeEvent();
    const { registration } = await attendee(event);

    expect((await attendance.attendanceRate(registration.id)).percent).toBe(0);
    await attendance.checkIn({ registrationId: registration.id });
    expect((await attendance.attendanceRate(registration.id)).percent).toBe(100);
  });
});

describe('the door list', () => {
  test('shows who has arrived and who has not', async () => {
    const { event } = await makeEvent();
    const here = await attendee(event, { organization: 'Ghana Health Service' });
    await attendee(event);

    await attendance.checkIn({ registrationId: here.registration.id });

    const all = await request(server)
      .get(`/api/v1/attendance/lookup?eventId=${event.id}`).set(authHeader(staff));
    expect(all.body.data).toHaveLength(2);

    const arrived = await request(server)
      .get(`/api/v1/attendance/lookup?eventId=${event.id}&status=checked_in`).set(authHeader(staff));
    expect(arrived.body.data).toHaveLength(1);
    expect(arrived.body.data[0].checkedIn).toBe(true);

    const waiting = await request(server)
      .get(`/api/v1/attendance/lookup?eventId=${event.id}&status=not_arrived`).set(authHeader(staff));
    expect(waiting.body.data).toHaveLength(1);
  });

  test('search finds someone by name when their badge fails', async () => {
    const { event } = await makeEvent();
    const { user } = await attendee(event);

    const res = await request(server)
      .get(`/api/v1/attendance/lookup?eventId=${event.id}&q=${encodeURIComponent(user.last_name)}`)
      .set(authHeader(staff));

    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data[0].name).toContain(user.last_name);
  });

  test('the summary counts arrivals', async () => {
    const { event } = await makeEvent();
    const a = await attendee(event);
    await attendee(event);
    await attendance.checkIn({ registrationId: a.registration.id });

    const res = await request(server)
      .get(`/api/v1/attendance/summary?eventId=${event.id}`).set(authHeader(staff));

    expect(res.body.data).toMatchObject({ expected: 2, arrived: 1, notArrived: 1, arrivalRate: 50 });
  });
});

describe('finalising', () => {
  test('marks no-shows absent and is safe to run twice', async () => {
    const { event } = await makeEvent();
    const present = await attendee(event);
    await attendee(event);
    await attendance.checkIn({ registrationId: present.registration.id });

    const first = await request(server).post('/api/v1/attendance/finalise')
      .set(authHeader(manager)).send({ eventId: Number(event.id) });

    expect(first.body.data).toMatchObject({ present: 1, markedAbsent: 1 });

    const second = await request(server).post('/api/v1/attendance/finalise')
      .set(authHeader(manager)).send({ eventId: Number(event.id) });
    expect(second.body.data.markedAbsent).toBe(0);
  });
});

describe('permissions', () => {
  test('a participant cannot mark attendance', async () => {
    const { event } = await makeEvent();
    const { registration } = await attendee(event);
    const outsider = await makeUser({ roleKey: 'participant' });

    expect((await request(server).post('/api/v1/attendance/scan')
      .set(authHeader(outsider)).send({ qrToken: registration.qr_token })).status).toBe(403);
  });

  test('IT admin holds no attendance permission', async () => {
    const { event } = await makeEvent();
    const itAdmin = await makeUser({ roleKey: 'it_admin', isStaff: true });

    expect((await request(server).get(`/api/v1/attendance/lookup?eventId=${event.id}`)
      .set(authHeader(itAdmin))).status).toBe(403);
  });

  test('event staff can mark and view but not export the list', async () => {
    const { event } = await makeEvent();

    expect((await request(server).get(`/api/v1/attendance/lookup?eventId=${event.id}`)
      .set(authHeader(staff))).status).toBe(200);
    expect((await request(server).get(`/api/v1/attendance/export?eventId=${event.id}`)
      .set(authHeader(staff))).status).toBe(403);
  });

  test('the export is audited', async () => {
    const { event } = await makeEvent();
    await attendee(event);

    const res = await request(server)
      .get(`/api/v1/attendance/export?eventId=${event.id}`).set(authHeader(manager));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('Checked in at');

    const entry = await models.AuditLog.findOne({
      where: { action: 'attendance.exported' }, order: [['id', 'DESC']],
    });
    expect(entry).toBeTruthy();
  });
});
