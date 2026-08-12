/**
 * Creates one staff user per role for local testing of the admin console.
 * Development only — refuses to run against production.
 *
 *   node scripts/make-staff.js
 */
import argon2 from 'argon2';
import { connect, disconnect, models } from '../src/database/models/index.js';
import env from '../src/config/env.js';

const PASSWORD = 'CariscaStaff!2026';
const ROLES = ['manager', 'director', 'monitoring_evaluation', 'finance', 'it_admin', 'event_staff'];

async function main() {
  if (env.isProduction) throw new Error('Refusing to create test staff in production.');
  await connect();

  const { User, Role, UserRole } = models;
  const password_hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const now = new Date();

  for (const key of ROLES) {
    const role = await Role.findOne({ where: { key } });
    if (!role) { process.stdout.write(`  no such role: ${key}\n`); continue; }

    const email = `${key.replace(/_/g, '.')}@carisca.test`;
    const [user] = await User.findOrCreate({
      where: { email },
      defaults: {
        email,
        password_hash,
        first_name: key.split('_')[0].replace(/^\w/, (c) => c.toUpperCase()),
        last_name: 'Staff',
        status: 'ACTIVE',
        is_staff: true,
        email_verified_at: now,
        country_code: 'GH',
      },
    });

    await user.update({ password_hash, is_staff: true, email_verified_at: now });
    await UserRole.destroy({ where: { user_id: user.id } });
    await UserRole.create({ user_id: user.id, role_id: role.id });

    process.stdout.write(`  ${email.padEnd(34)} ${key}\n`);
  }

  process.stdout.write(`\n  Password for all: ${PASSWORD}\n\n`);
  await disconnect();
}

main().catch(async (err) => {
  process.stderr.write(`${err.stack}\n`);
  await disconnect().catch(() => {});
  process.exit(1);
});
