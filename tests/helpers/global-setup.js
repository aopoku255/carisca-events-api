import { execSync } from 'node:child_process';

/**
 * Runs once before the whole suite: drop, create, migrate, seed.
 *
 * Doing this per test file meant four full rebuilds of the same database and
 * left a window where one file's teardown raced another's setup. Once, here,
 * is both faster and deterministic. Individual files create their own users
 * with unique addresses rather than relying on a pristine database.
 */
export default async function globalSetup() {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SEED_ADMIN_EMAIL: process.env.SEED_ADMIN_EMAIL || 'admin@carisca.test',
    SEED_ADMIN_PASSWORD: process.env.SEED_ADMIN_PASSWORD || 'test-admin-password-not-for-real-use',
  };
  const opts = { stdio: 'pipe', env, cwd: process.cwd() };
  const cli = 'npx sequelize-cli --config src/database/cli-config.cjs'
    + ' --migrations-path src/database/migrations --seeders-path src/database/seeders';

  try { execSync(`${cli} db:drop`, opts); } catch { /* nothing to drop on a first run */ }
  execSync(`${cli} db:create`, opts);
  execSync(`${cli} db:migrate`, opts);
  execSync(`${cli} db:seed:all`, opts);
}
