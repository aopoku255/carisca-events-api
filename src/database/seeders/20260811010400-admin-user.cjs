/* eslint-disable */
'use strict';

const argon2 = require('argon2');

/**
 * The first Super Administrator. Credentials come from the environment so no
 * password is ever committed; in development a random one is generated and
 * printed once.
 *
 * Refuses to run in production without an explicit SEED_ADMIN_PASSWORD, so a
 * known default can never reach a live system.
 */
module.exports = {
  async up(queryInterface) {
    const ts = new Date();
    const email = (process.env.SEED_ADMIN_EMAIL || 'admin@carisca.knust.edu.gh').toLowerCase();
    let password = process.env.SEED_ADMIN_PASSWORD;
    let generated = false;

    if (!password) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('SEED_ADMIN_PASSWORD must be set when seeding in production.');
      }
      password = `Carisca!${require('crypto').randomBytes(9).toString('base64url')}`;
      generated = true;
    }

    const [existing] = await queryInterface.sequelize.query(
      'SELECT id FROM users WHERE email = :email LIMIT 1',
      { replacements: { email } },
    );
    if (existing.length) {
      console.log(`\n  Admin user ${email} already exists — skipping.\n`);
      return;
    }

    const password_hash = await argon2.hash(password, { type: argon2.argon2id });

    const [deptRows] = await queryInterface.sequelize.query(
      "SELECT id FROM departments WHERE code = 'IT' LIMIT 1",
    );

    await queryInterface.bulkInsert('users', [{
      email,
      password_hash,
      first_name: 'System',
      last_name: 'Administrator',
      status: 'ACTIVE',
      is_staff: true,
      department_id: deptRows.length ? deptRows[0].id : null,
      country_code: 'GH',
      timezone: 'Africa/Accra',
      email_verified_at: ts,
      token_version: 1,
      created_at: ts,
      updated_at: ts,
    }]);

    const [userRows] = await queryInterface.sequelize.query(
      'SELECT id FROM users WHERE email = :email LIMIT 1',
      { replacements: { email } },
    );
    const [roleRows] = await queryInterface.sequelize.query(
      "SELECT id FROM roles WHERE `key` = 'super_admin' LIMIT 1",
    );
    if (!roleRows.length) {
      throw new Error('super_admin role not found — run the RBAC seeder first.');
    }

    await queryInterface.bulkInsert('user_roles', [{
      user_id: userRows[0].id,
      role_id: roleRows[0].id,
      scope_type: null,
      scope_id: null,
      granted_by: null,
      created_at: ts,
    }]);

    if (generated) {
      console.log(
        `\n  ┌─────────────────────────────────────────────────────────────\n` +
        `  │  Super Administrator created\n` +
        `  │    email:    ${email}\n` +
        `  │    password: ${password}\n` +
        `  │  This is shown once. Change it after first sign-in.\n` +
        `  └─────────────────────────────────────────────────────────────\n`,
      );
    } else {
      console.log(`\n  Super Administrator created: ${email} (password from SEED_ADMIN_PASSWORD)\n`);
    }
  },

  async down(queryInterface) {
    const email = (process.env.SEED_ADMIN_EMAIL || 'admin@carisca.knust.edu.gh').toLowerCase();
    await queryInterface.bulkDelete('users', { email });
  },
};
