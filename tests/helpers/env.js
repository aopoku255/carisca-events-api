// Loaded before any test module. Guarantees the suite can never point at a
// development or production database, whatever the local .env happens to say.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

// Providers are pinned, never inherited from the local .env: a test run must
// not send real email or write to real cloud storage because of how someone's
// development machine happens to be configured.
process.env.MAIL_DRIVER = 'log';
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_LOCAL_PATH = './storage/test';

/**
 * Blanked so no real cloud credential can reach a test. Assigned rather than
 * deleted on purpose: config/env.js calls dotenv.config() when it loads, and
 * dotenv fills in any key that is *absent* from process.env — so deleting
 * these would hand the tests whatever is in the developer's .env, while an
 * empty value stands.
 */
for (const key of [
  'R2_ENDPOINT', 'R2_ACCOUNT_ID', 'R2_BUCKET',
  'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_FORCE_PATH_STYLE',
  'GOOGLE_DRIVE_FOLDER_ID', 'GOOGLE_DRIVE_IMPERSONATE_USER',
  'GOOGLE_SERVICE_ACCOUNT_KEY_JSON',
]) {
  process.env[key] = '';
}

// Deterministic secrets so tokens are reproducible across runs.
process.env.JWT_ACCESS_SECRET ||= 'test-access-secret-that-is-long-enough-1234567890';
process.env.JWT_REFRESH_SECRET ||= 'test-refresh-secret-that-is-long-enough-0987654321';

// Seeded admin credentials must be explicit so the seeder never prints a
// random password during a test run.
process.env.SEED_ADMIN_EMAIL ||= 'admin@carisca.test';
process.env.SEED_ADMIN_PASSWORD ||= 'test-admin-password-not-for-real-use';
