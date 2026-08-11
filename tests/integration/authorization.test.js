import request from 'supertest';
import { jest } from '@jest/globals';
import {
  prepareDatabase, teardown, makeUser, authHeader, app, flushPermissionCache,
  models, TEST_PASSWORD,
} from '../helpers/setup.js';
import { loadPermissionsFromDb, registry } from '../../src/core/rbac/rbac.service.js';

jest.setTimeout(60_000);

/**
 * THE GATE for the foundation phase.
 *
 * Two things are proven here, and both must keep passing for the life of the
 * platform:
 *
 *   1. Each seeded role resolves to exactly the permission set the blueprint's
 *      RBAC matrix specifies — no more, no less.
 *   2. Those permissions are actually enforced over HTTP, not merely stored.
 *
 * A role gaining a permission it should not have is a silent privilege
 * escalation. This suite is the thing that catches it.
 */

let server;

beforeAll(async () => {
  await prepareDatabase();
  server = app();
});

afterAll(teardown);
beforeEach(flushPermissionCache);

describe('seeded role → permission matrix', () => {
  const expected = Object.fromEntries(
    registry.roles.map((r) => [
      r.key,
      r.permissions === '*' ? registry.permissions.map((p) => p.key) : r.permissions,
    ]),
  );

  test.each(Object.keys(expected))('%s resolves to exactly its declared permissions', async (roleKey) => {
    const user = await makeUser({ roleKey, isStaff: roleKey !== 'participant' });
    const resolved = (await loadPermissionsFromDb(user.id)).sort();

    expect(resolved).toEqual([...expected[roleKey]].sort());
  });

  test('participant holds no permissions at all', async () => {
    const user = await makeUser({ roleKey: 'participant' });
    expect(await loadPermissionsFromDb(user.id)).toEqual([]);
  });

  test('a user with no role holds no permissions', async () => {
    const user = await makeUser();
    expect(await loadPermissionsFromDb(user.id)).toEqual([]);
  });
});

describe('the two separations the brief demanded', () => {
  test('finance cannot reach system settings', async () => {
    const perms = await loadPermissionsFromDb((await makeUser({ roleKey: 'finance', isStaff: true })).id);
    expect(perms.filter((p) => p.startsWith('system.'))).toEqual([]);
    expect(perms.filter((p) => p.startsWith('rbac.'))).toEqual([]);
  });

  test('IT administrators cannot reach payments or participant exports', async () => {
    const perms = await loadPermissionsFromDb((await makeUser({ roleKey: 'it_admin', isStaff: true })).id);
    expect(perms.filter((p) => p.startsWith('payment.'))).toEqual([]);
    expect(perms.filter((p) => p.endsWith('.export'))).toEqual([]);
  });

  test('event staff can mark attendance but cannot export participants', async () => {
    const perms = await loadPermissionsFromDb((await makeUser({ roleKey: 'event_staff', isStaff: true })).id);
    expect(perms).toContain('attendance.mark');
    expect(perms).not.toContain('cpd.registration.export');
    expect(perms).not.toContain('payment.view');
  });

  test('managers cannot publish unilaterally, directors can', async () => {
    const manager = await loadPermissionsFromDb((await makeUser({ roleKey: 'manager', isStaff: true })).id);
    const director = await loadPermissionsFromDb((await makeUser({ roleKey: 'director', isStaff: true })).id);

    expect(manager).not.toContain('cpd.publish');
    expect(manager).toContain('cpd.create');
    expect(director).toContain('cpd.publish');
    expect(director).toContain('cpd.approve');
    expect(director).not.toContain('cpd.create');
  });
});

describe('enforcement over HTTP', () => {
  // route → the permission it requires
  const ROUTES = {
    '/api/v1/admin/users': 'users.view',
    '/api/v1/admin/roles': 'rbac.view',
    '/api/v1/admin/permissions': 'rbac.view',
    '/api/v1/admin/audit-logs': 'audit.view',
  };

  test('every admin route rejects an anonymous caller', async () => {
    for (const path of Object.keys(ROUTES)) {
      const res = await request(server).get(path);
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    }
  });

  test('every admin route rejects a participant', async () => {
    const participant = await makeUser({ roleKey: 'participant' });
    for (const path of Object.keys(ROUTES)) {
      const res = await request(server).get(path).set(authHeader(participant));
      // Participants are not staff, so they are stopped at the console gate.
      expect(res.status).toBe(403);
    }
  });

  test.each(registry.roles.filter((r) => r.key !== 'participant').map((r) => r.key))(
    'role %s reaches exactly the admin routes its permissions allow',
    async (roleKey) => {
      const user = await makeUser({ roleKey, isStaff: true });
      const granted = new Set(await loadPermissionsFromDb(user.id));

      for (const [path, permission] of Object.entries(ROUTES)) {
        const res = await request(server).get(path).set(authHeader(user));
        const shouldPass = granted.has(permission);

        expect({ path, role: roleKey, status: res.status })
          .toEqual({ path, role: roleKey, status: shouldPass ? 200 : 403 });
      }
    },
  );

  test('a staff account without any role is refused everywhere', async () => {
    const user = await makeUser({ isStaff: true });
    for (const path of Object.keys(ROUTES)) {
      const res = await request(server).get(path).set(authHeader(user));
      expect(res.status).toBe(403);
    }
  });
});

describe('revocation takes effect without waiting for the token to expire', () => {
  test('removing a role denies access on the next request', async () => {
    const user = await makeUser({ roleKey: 'it_admin', isStaff: true });
    const headers = authHeader(user);

    expect((await request(server).get('/api/v1/admin/users').set(headers)).status).toBe(200);

    const role = await models.Role.findOne({ where: { key: 'it_admin' } });
    await user.removeRole(role);
    await flushPermissionCache();

    // Same token, no re-issue. Permissions are resolved per request.
    expect((await request(server).get('/api/v1/admin/users').set(headers)).status).toBe(403);
  });

  test('deactivating an account rejects its existing token', async () => {
    const user = await makeUser({ roleKey: 'it_admin', isStaff: true });
    const headers = authHeader(user);

    expect((await request(server).get('/api/v1/admin/users').set(headers)).status).toBe(200);

    user.status = 'SUSPENDED';
    await user.save();

    const res = await request(server).get('/api/v1/admin/users').set(headers);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
  });

  test('bumping token_version invalidates tokens minted before it', async () => {
    const user = await makeUser({ roleKey: 'it_admin', isStaff: true });
    const headers = authHeader(user);

    expect((await request(server).get('/api/v1/admin/users').set(headers)).status).toBe(200);

    user.token_version += 1;
    await user.save();

    const res = await request(server).get('/api/v1/admin/users').set(headers);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_STALE');
  });

  test('a password change signs every other session out', async () => {
    const user = await makeUser({ roleKey: 'it_admin', isStaff: true });
    const headers = authHeader(user);

    const changed = await request(server)
      .post('/api/v1/auth/change-password')
      .set(headers)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'a-brand-new-passphrase-here' });
    expect(changed.status).toBe(200);

    // The token used to make the change is itself now stale.
    const after = await request(server).get('/api/v1/admin/users').set(headers);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('TOKEN_STALE');
  });
});
