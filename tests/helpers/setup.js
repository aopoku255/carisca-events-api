import { models, sequelize } from '../../src/database/models/index.js';
import { loadCurrencyExponents } from '../../src/lib/money.js';
import { hashPassword } from '../../src/core/auth/auth.service.js';
import { signAccessToken } from '../../src/core/auth/token.service.js';
import { getRedis, closeRedis } from '../../src/config/redis.js';
import { createApp } from '../../src/app.js';

const { User, Role, Department } = models;

/**
 * Tests run against a real MySQL database (carisca_dev_test), migrated and
 * seeded from the same files production uses. Mocking the database would only
 * prove the mocks agree with themselves — and the constraints being verified
 * here (unique indexes, FK actions, the audit triggers) live in the schema.
 */
/**
 * The schema is built once by tests/helpers/global-setup.js. Each file only
 * needs a live connection and the currency table loaded.
 */
export async function prepareDatabase() {
  await sequelize.authenticate();
  await loadCurrencyExponents(sequelize);
}

export async function teardown() {
  await sequelize.close().catch(() => {});
  await closeRedis().catch(() => {});
}

/** Permission caching would otherwise leak state between tests. */
export async function flushPermissionCache() {
  try {
    const redis = getRedis();
    const keys = await redis.keys('perm:v1:*');
    if (keys.length) await redis.del(...keys);
  } catch { /* redis optional in tests */ }
}

export const TEST_PASSWORD = 'correct-horse-battery-staple';

/** Creates a user, optionally staff, optionally holding a role. */
export async function makeUser({
  email,
  roleKey = null,
  isStaff = false,
  status = 'ACTIVE',
  firstName = 'Test',
  lastName = 'User',
} = {}) {
  const address = email || `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

  const user = await User.create({
    email: address,
    password_hash: await hashPassword(TEST_PASSWORD),
    first_name: firstName,
    last_name: lastName,
    status,
    is_staff: isStaff,
    email_verified_at: new Date(),
  });

  if (roleKey) {
    const role = await Role.findOne({ where: { key: roleKey } });
    if (!role) throw new Error(`Seeded role "${roleKey}" not found.`);
    await user.addRole(role);
  }

  await flushPermissionCache();
  return user;
}

export function tokenFor(user) {
  return signAccessToken(user);
}

export function authHeader(user) {
  return { Authorization: `Bearer ${tokenFor(user)}` };
}

export async function findDepartment(code) {
  return Department.findOne({ where: { code } });
}

export function app() {
  return createApp();
}

export { models, sequelize };
