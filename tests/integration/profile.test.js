import request from 'supertest';
import { jest } from '@jest/globals';
import {
  prepareDatabase, teardown, makeUser, authHeader, app, flushPermissionCache, models,
} from '../helpers/setup.js';

jest.setTimeout(60_000);

let server;
let user;

beforeAll(async () => {
  await prepareDatabase();
  server = app();
});
afterAll(teardown);
beforeEach(async () => {
  await flushPermissionCache();
  user = await makeUser({ roleKey: 'participant' });
});

describe('self-service profile', () => {
  test('a participant reads their own record', async () => {
    const res = await request(server).get('/api/v1/users/me').set(authHeader(user));
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(user.email);
    expect(res.body.data).not.toHaveProperty('password_hash');
  });

  test('demographics are saved and echoed back', async () => {
    const res = await request(server).patch('/api/v1/users/me').set(authHeader(user))
      .send({
        prefix: 'Dr.',
        middleName: 'Kwabena',
        gender: 'Prefer not to say',
        organization: 'Ghana Health Service',
        positionKey: 'doctor',
        sectorKey: 'healthcare',
        countryCode: 'GH',
        city: 'Kumasi',
        stateProvince: 'Ashanti',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.position).toMatchObject({ key: 'doctor', label: 'Doctor' });
    expect(res.body.data.sector).toMatchObject({ key: 'healthcare' });
    // Continent comes from the country, so it cannot contradict it.
    expect(res.body.data.country).toMatchObject({ code: 'GH', region: 'Africa' });
    expect(res.body.data.displayName).toContain('Dr.');
  });

  test('an unknown vocabulary key is rejected, not silently nulled', async () => {
    const res = await request(server).patch('/api/v1/users/me').set(authHeader(user))
      .send({ positionKey: 'supreme-overlord' });

    expect(res.status).toBe(422);
    expect(res.body.error.details[0].field).toBe('positionKey');
  });

  test('an unknown country is rejected', async () => {
    const res = await request(server).patch('/api/v1/users/me').set(authHeader(user))
      .send({ countryCode: 'ZZ' });
    expect(res.status).toBe(422);
  });

  test('the mailing-list choice is timestamped as evidence', async () => {
    await request(server).patch('/api/v1/users/me').set(authHeader(user))
      .send({ emailOptOut: true });

    const row = await models.User.findByPk(user.id);
    expect(row.email_opt_out).toBe(true);
    expect(row.email_preference_set_at).toBeTruthy();
  });

  test('email cannot be changed here — that needs re-verification', async () => {
    const res = await request(server).patch('/api/v1/users/me').set(authHeader(user))
      .send({ email: 'someone.else@example.test' });

    expect(res.status).toBe(422);
    const row = await models.User.findByPk(user.id);
    expect(row.email).toBe(user.email);
  });

  test('role and staff status cannot be self-assigned', async () => {
    const res = await request(server).patch('/api/v1/users/me').set(authHeader(user))
      .send({ isStaff: true, status: 'ACTIVE', roles: ['super_admin'] });

    expect(res.status).toBe(422); // strict schema refuses unknown keys outright
    const row = await models.User.findByPk(user.id);
    expect(row.is_staff).toBe(false);
  });

  test('the profile edit is audited', async () => {
    await request(server).patch('/api/v1/users/me').set(authHeader(user))
      .send({ organization: 'KNUST' });

    const entry = await models.AuditLog.findOne({
      where: { actor_user_id: user.id, action: 'user.profile_updated' },
      order: [['id', 'DESC']],
    });
    expect(entry).toBeTruthy();
    expect(entry.after.organization).toBe('KNUST');
  });

  test('anonymous callers are refused', async () => {
    expect((await request(server).get('/api/v1/users/me')).status).toBe(401);
    expect((await request(server).patch('/api/v1/users/me').send({ city: 'Accra' })).status).toBe(401);
  });

  test('one user cannot reach another through this route', async () => {
    const other = await makeUser({ roleKey: 'participant' });
    await request(server).patch('/api/v1/users/me').set(authHeader(user)).send({ city: 'Kumasi' });

    // There is no id in the path, so the only record reachable is the caller's.
    const row = await models.User.findByPk(other.id);
    expect(row.city).toBeNull();
  });
});
