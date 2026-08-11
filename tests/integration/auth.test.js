import request from 'supertest';
import { jest } from '@jest/globals';
import {
  prepareDatabase, teardown, makeUser, app, flushPermissionCache, models, TEST_PASSWORD,
} from '../helpers/setup.js';

jest.setTimeout(60_000);

let server;

beforeAll(async () => {
  await prepareDatabase();
  server = app();
});
afterAll(teardown);
beforeEach(flushPermissionCache);

const validRegistration = (overrides = {}) => ({
  email: `participant-${Math.random().toString(36).slice(2, 10)}@example.test`,
  password: 'a-perfectly-fine-passphrase',
  firstName: 'Ama',
  lastName: 'Mensah',
  countryCode: 'GH',
  organization: 'KNUST School of Business',
  jobTitle: 'Supply Chain Analyst',
  ...overrides,
});

describe('registration', () => {
  test('creates an unverified participant and queues a verification email', async () => {
    const payload = validRegistration();
    const res = await request(server).post('/api/v1/auth/register').send(payload);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email).toBe(payload.email);
    expect(res.body.data.user.emailVerified).toBe(false);
    expect(res.body.data.user.isStaff).toBe(false);
    // The password hash must never appear in a response.
    expect(JSON.stringify(res.body)).not.toContain('password_hash');

    const notification = await models.Notification.findOne({
      where: { to_address: payload.email, template: 'email_verification' },
    });
    expect(notification).not.toBeNull();
    expect(notification.status).toBe('PENDING');
  });

  test('assigns the participant role, which grants nothing', async () => {
    const payload = validRegistration();
    await request(server).post('/api/v1/auth/register').send(payload);

    const user = await models.User.findOne({
      where: { email: payload.email },
      include: [{ model: models.Role, as: 'roles' }],
    });
    expect(user.roles.map((r) => r.key)).toEqual(['participant']);
  });

  test('rejects a duplicate email address', async () => {
    const payload = validRegistration();
    await request(server).post('/api/v1/auth/register').send(payload);
    const res = await request(server).post('/api/v1/auth/register').send(payload);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  test('email casing cannot be used to create a second account', async () => {
    const payload = validRegistration({ email: 'Case.Test@Example.Test' });
    const first = await request(server).post('/api/v1/auth/register').send(payload);
    expect(first.status).toBe(201);
    expect(first.body.data.user.email).toBe('case.test@example.test');

    const second = await request(server)
      .post('/api/v1/auth/register')
      .send({ ...payload, email: 'CASE.TEST@example.test' });
    expect(second.status).toBe(409);
  });

  test('rejects a short password with a field-level message', async () => {
    const res = await request(server)
      .post('/api/v1/auth/register')
      .send(validRegistration({ password: 'short' }));

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.some((d) => d.field === 'password')).toBe(true);
  });

  test('strips unexpected fields rather than trusting them', async () => {
    const payload = { ...validRegistration(), isStaff: true, status: 'ACTIVE', tokenVersion: 99 };
    const res = await request(server).post('/api/v1/auth/register').send(payload);

    expect(res.status).toBe(201);
    // Privilege escalation via mass assignment must not be possible.
    expect(res.body.data.user.isStaff).toBe(false);

    const user = await models.User.findOne({ where: { email: payload.email } });
    expect(user.is_staff).toBe(false);
    expect(user.token_version).toBe(1);
  });
});

describe('email verification', () => {
  test('confirms the address with the issued token', async () => {
    const payload = validRegistration();
    const registered = await request(server).post('/api/v1/auth/register').send(payload);
    const token = registered.body.data.verificationToken;
    expect(token).toBeTruthy();

    const res = await request(server).post('/api/v1/auth/verify-email').send({ token });
    expect(res.status).toBe(200);
    expect(res.body.data.user.emailVerified).toBe(true);
  });

  test('a verification token cannot be replayed', async () => {
    const payload = validRegistration();
    const registered = await request(server).post('/api/v1/auth/register').send(payload);
    const token = registered.body.data.verificationToken;

    await request(server).post('/api/v1/auth/verify-email').send({ token });
    const replay = await request(server).post('/api/v1/auth/verify-email').send({ token });

    expect(replay.status).toBe(422);
  });

  test('rejects a fabricated token', async () => {
    const res = await request(server)
      .post('/api/v1/auth/verify-email')
      .send({ token: 'not-a-real-token' });
    expect(res.status).toBe(422);
  });
});

describe('sign-in', () => {
  test('returns a token pair and the caller\'s permissions', async () => {
    const user = await makeUser({ roleKey: 'finance', isStaff: true });

    const res = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBeTruthy();
    expect(res.body.data.user.permissions).toContain('payment.refund');
    expect(res.body.data.user.permissions).not.toContain('system.settings');
  });

  test('gives the same answer for a wrong password and an unknown address', async () => {
    const user = await makeUser();

    const wrongPassword = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'definitely-not-the-password' });

    const unknownUser = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody-here@example.test', password: 'definitely-not-the-password' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe(unknownUser.body.error.code);
    expect(wrongPassword.body.message).toBe(unknownUser.body.message);
  });

  test('refuses a suspended account with a distinct reason', async () => {
    const user = await makeUser({ status: 'SUSPENDED' });
    const res = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('refresh token rotation', () => {
  async function signIn() {
    const user = await makeUser();
    const res = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD });
    // Name the tokens explicitly: spreading res.body.data would shadow `user`
    // with the serialised plain object and lose the model instance.
    return { user, accessToken: res.body.data.accessToken, refreshToken: res.body.data.refreshToken };
  }

  test('rotates: the old token stops working, the new one works', async () => {
    const { refreshToken } = await signIn();

    const first = await request(server).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(first.status).toBe(200);
    expect(first.body.data.refreshToken).not.toBe(refreshToken);

    const second = await request(server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.body.data.refreshToken });
    expect(second.status).toBe(200);
  });

  test('replaying a rotated token kills the whole family', async () => {
    const { refreshToken } = await signIn();

    const rotated = await request(server).post('/api/v1/auth/refresh').send({ refreshToken });
    const current = rotated.body.data.refreshToken;

    // An attacker replays the token they stole before the legitimate rotation.
    const replay = await request(server).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_REUSED');

    // The legitimate holder is signed out too — we cannot tell them apart.
    const legitimate = await request(server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: current });
    expect(legitimate.status).toBe(401);
  });

  test('logout revokes the presented token', async () => {
    const { refreshToken } = await signIn();

    await request(server).post('/api/v1/auth/logout').send({ refreshToken });
    const res = await request(server).post('/api/v1/auth/refresh').send({ refreshToken });

    expect(res.status).toBe(401);
  });

  test('a deactivated account cannot refresh', async () => {
    const { user, refreshToken } = await signIn();

    user.status = 'INACTIVE';
    await user.save();

    const res = await request(server).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
  });
});

describe('password reset', () => {
  test('does not reveal whether an address is registered', async () => {
    const user = await makeUser();

    const known = await request(server).post('/api/v1/auth/forgot-password').send({ email: user.email });
    const unknown = await request(server)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'no-such-person@example.test' });

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body.message).toBe(unknown.body.message);
  });

  test('resets the password, invalidates old sessions, and allows the new password', async () => {
    const user = await makeUser();
    const signedIn = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD });
    const oldRefresh = signedIn.body.data.refreshToken;

    await request(server).post('/api/v1/auth/forgot-password').send({ email: user.email });

    // The raw token only exists in the queued notification.
    const notification = await models.Notification.findOne({
      where: { user_id: user.id, template: 'password_reset' },
      order: [['id', 'DESC']],
    });
    const resetUrl = notification.payload.resetUrl;
    const token = new URL(resetUrl).searchParams.get('token');

    const reset = await request(server)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'an-entirely-new-passphrase' });
    expect(reset.status).toBe(200);

    // Old sessions are gone.
    expect((await request(server).post('/api/v1/auth/refresh').send({ refreshToken: oldRefresh })).status).toBe(401);

    // Old password rejected, new password accepted.
    expect((await request(server).post('/api/v1/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD })).status).toBe(401);
    expect((await request(server).post('/api/v1/auth/login')
      .send({ email: user.email, password: 'an-entirely-new-passphrase' })).status).toBe(200);
  });

  test('a reset token cannot be used twice', async () => {
    const user = await makeUser();
    await request(server).post('/api/v1/auth/forgot-password').send({ email: user.email });

    const notification = await models.Notification.findOne({
      where: { user_id: user.id, template: 'password_reset' },
      order: [['id', 'DESC']],
    });
    const token = new URL(notification.payload.resetUrl).searchParams.get('token');

    expect((await request(server).post('/api/v1/auth/reset-password')
      .send({ token, password: 'first-new-passphrase-here' })).status).toBe(200);
    expect((await request(server).post('/api/v1/auth/reset-password')
      .send({ token, password: 'second-new-passphrase-x' })).status).toBe(422);
  });

  test('requesting a new reset link voids the previous one', async () => {
    const user = await makeUser();

    await request(server).post('/api/v1/auth/forgot-password').send({ email: user.email });
    const first = await models.Notification.findOne({
      where: { user_id: user.id, template: 'password_reset' }, order: [['id', 'DESC']],
    });
    const firstToken = new URL(first.payload.resetUrl).searchParams.get('token');

    await request(server).post('/api/v1/auth/forgot-password').send({ email: user.email });

    const res = await request(server)
      .post('/api/v1/auth/reset-password')
      .send({ token: firstToken, password: 'should-not-work-passphrase' });
    expect(res.status).toBe(422);
  });
});

describe('GET /auth/me', () => {
  test('returns the caller with their resolved permissions', async () => {
    const user = await makeUser({ roleKey: 'monitoring_evaluation', isStaff: true });
    const signedIn = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD });

    const res = await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${signedIn.body.data.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user.permissions).toContain('evaluation.manage');
    expect(res.body.data.user.permissions).not.toContain('payment.view');
  });

  test('rejects a missing or malformed token', async () => {
    expect((await request(server).get('/api/v1/auth/me')).status).toBe(401);
    expect((await request(server).get('/api/v1/auth/me').set('Authorization', 'Bearer nonsense')).status).toBe(401);
    expect((await request(server).get('/api/v1/auth/me').set('Authorization', 'Basic abc')).status).toBe(401);
  });
});
