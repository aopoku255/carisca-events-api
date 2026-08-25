import request from 'supertest';
import {
  prepareDatabase, teardown, makeUser, authHeader, app, flushPermissionCache, models,
} from '../helpers/setup.js';

const { Notification } = models;

let server;

beforeAll(async () => {
  await prepareDatabase();
  server = app();
});
afterAll(teardown);
beforeEach(flushPermissionCache);

const admin = () => makeUser({ roleKey: 'super_admin', isStaff: true });

function newEmail() {
  return `admin-created-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

describe('the welcome email an administrator-created account gets', () => {
  test('creating staff reports the email as sent and does not queue it', async () => {
    const actor = await admin();
    const email = newEmail();

    const res = await request(server).post('/api/v1/admin/users')
      .set(authHeader(actor))
      .send({
        email, password: 'a-long-enough-password-1', firstName: 'New', lastName: 'Staff',
        isStaff: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.welcomeEmailSent).toBe(true);

    // The whole point of sending it directly rather than through notify() is
    // that the password never lands in a table — confirm nothing was queued
    // for this account at all, on any template.
    const queued = await Notification.count({ where: { user_id: res.body.data.id } });
    expect(queued).toBe(0);
  });

  test('creating a participant gets the same treatment', async () => {
    const actor = await admin();
    const email = newEmail();

    const res = await request(server).post('/api/v1/admin/users')
      .set(authHeader(actor))
      .send({
        email, password: 'a-long-enough-password-1', firstName: 'New', lastName: 'Participant',
        isStaff: false, roleKeys: ['participant'],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.welcomeEmailSent).toBe(true);
    expect(await Notification.count({ where: { user_id: res.body.data.id } })).toBe(0);
  });

  test('the plaintext password never appears in the audit trail for the account', async () => {
    const actor = await admin();
    const email = newEmail();
    const password = 'a-very-specific-password-99';

    const created = await request(server).post('/api/v1/admin/users')
      .set(authHeader(actor))
      .send({ email, password, firstName: 'New', lastName: 'Staff', isStaff: true });

    const auditRes = await request(server).get('/api/v1/admin/audit-logs')
      .set(authHeader(actor))
      .query({ resourceType: 'user', q: created.body.data.id });

    const entry = auditRes.body.data.find((e) => e.resourceId === created.body.data.id);
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry)).not.toContain(password);
  });

  test('a duplicate email is still refused before any of this runs', async () => {
    const actor = await admin();
    const email = newEmail();

    await request(server).post('/api/v1/admin/users').set(authHeader(actor))
      .send({ email, password: 'a-long-enough-password-1', firstName: 'A', lastName: 'B', isStaff: false });

    const second = await request(server).post('/api/v1/admin/users').set(authHeader(actor))
      .send({ email, password: 'a-long-enough-password-2', firstName: 'C', lastName: 'D', isStaff: false });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('EMAIL_TAKEN');
  });
});
