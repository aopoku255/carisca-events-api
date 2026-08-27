import { models, sequelize } from '../../src/database/models/index.js';
import { loadCurrencyExponents } from '../../src/lib/money.js';
import { hashPassword } from '../../src/core/auth/auth.service.js';
import { signAccessToken } from '../../src/core/auth/token.service.js';
import { getRedis, closeRedis } from '../../src/config/redis.js';
import { closeBrowser } from '../../src/core/certificates/browser.js';
import { createApp } from '../../src/app.js';

const {
  User, Role, Department, Position, Sector,
} = models;

let defaultProfileIdsPromise = null;
/**
 * Registration now requires a complete profile (phone, country, org, job
 * title, position, sector) — resolved once and cached so every `makeUser()`
 * call doesn't re-query the two lookup tables.
 */
function defaultProfileIds() {
  if (!defaultProfileIdsPromise) {
    defaultProfileIdsPromise = Promise.all([
      Position.findOne({ where: { key: 'other_supply_chain' } }),
      Sector.findOne({ where: { key: 'business' } }),
    ]).then(([position, sector]) => ({ positionId: position.id, sectorId: sector.id }));
  }
  return defaultProfileIdsPromise;
}

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
  // A rendered certificate leaves a Chromium process running behind the
  // module-level singleton. Without this Jest never exits, whether or not the
  // file being torn down was the one that started it.
  await closeBrowser().catch(() => {});
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

/**
 * Creates a user, optionally staff, optionally holding a role. Defaults to a
 * complete profile — phone/country/organization/jobTitle/position/sector all
 * set — since registering for an event now requires one; pass any of those
 * as `null` explicitly to get an incomplete profile for testing that gate
 * itself.
 */
export async function makeUser({
  email,
  roleKey = null,
  isStaff = false,
  status = 'ACTIVE',
  firstName = 'Test',
  lastName = 'User',
  phone = '+233555000111',
  countryCode = 'GH',
  organization = 'Test Organization',
  jobTitle = 'Test Role',
  positionId,
  sectorId,
} = {}) {
  const address = email || `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

  if (positionId === undefined || sectorId === undefined) {
    const defaults = await defaultProfileIds();
    if (positionId === undefined) positionId = defaults.positionId;
    if (sectorId === undefined) sectorId = defaults.sectorId;
  }

  const user = await User.create({
    email: address,
    password_hash: await hashPassword(TEST_PASSWORD),
    first_name: firstName,
    last_name: lastName,
    status,
    is_staff: isStaff,
    email_verified_at: new Date(),
    phone,
    country_code: countryCode,
    organization,
    job_title: jobTitle,
    position_id: positionId,
    sector_id: sectorId,
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
