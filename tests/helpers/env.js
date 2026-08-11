// Loaded before any test module. Guarantees the suite can never point at a
// development or production database, whatever the local .env happens to say.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.MAIL_DRIVER = 'log';

// Deterministic secrets so tokens are reproducible across runs.
process.env.JWT_ACCESS_SECRET ||= 'test-access-secret-that-is-long-enough-1234567890';
process.env.JWT_REFRESH_SECRET ||= 'test-refresh-secret-that-is-long-enough-0987654321';

// Seeded admin credentials must be explicit so the seeder never prints a
// random password during a test run.
process.env.SEED_ADMIN_EMAIL ||= 'admin@carisca.test';
process.env.SEED_ADMIN_PASSWORD ||= 'test-admin-password-not-for-real-use';
