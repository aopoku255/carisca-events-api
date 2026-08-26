/* eslint-disable */
'use strict';

const path = require('path');
const registry = require(path.resolve(__dirname, '../../core/rbac/permissions.json'));

/**
 * `permissions.json`'s own comment claims role grants are kept in sync with
 * it, but that sync only actually happens inside a Sequelize *seeder*
 * (`20260811010200-rbac.cjs`) — and seeders are recorded as run once and
 * never re-execute automatically. Every environment seeded before this
 * change resolved `super_admin`'s `"*"` (and every other system role's
 * explicit list) against whatever `permissions.json` looked like at seed
 * time, and never again — so the new `summit.*`/`abstract.*` keys, and
 * `manager`/`director`/etc.'s new grants of them, exist in `permissions`
 * but were never actually inserted into `role_permissions`.
 *
 * This runs the seeder's own sync logic (wholesale delete + reinsert of
 * every system role's grants from the registry) as a migration instead, so
 * it actually executes on every environment that already ran the original
 * seed — including this one. Non-system (custom, administrator-created)
 * roles are untouched, matching the seeder's own scope.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const ts = new Date();
    const { permissions, roles } = registry;

    const [permRows] = await queryInterface.sequelize.query('SELECT id, `key` FROM permissions');
    const [roleRows] = await queryInterface.sequelize.query('SELECT id, `key` FROM roles');
    const permId = new Map(permRows.map((r) => [r.key, r.id]));
    const roleId = new Map(roleRows.map((r) => [r.key, r.id]));

    const grants = [];
    for (const role of roles) {
      const rid = roleId.get(role.key);
      if (!rid) continue;

      const keys = role.permissions === '*'
        ? permissions.map((p) => p.key)
        : role.permissions;

      for (const key of keys) {
        const pid = permId.get(key);
        if (!pid) {
          throw new Error(`Role "${role.key}" grants unknown permission "${key}".`);
        }
        grants.push({ role_id: rid, permission_id: pid, created_at: ts });
      }
    }

    const systemRoleIds = roles.filter((r) => r.is_system).map((r) => roleId.get(r.key)).filter(Boolean);
    if (systemRoleIds.length) {
      await queryInterface.bulkDelete('role_permissions', {
        role_id: { [Sequelize.Op.in]: systemRoleIds },
      });
    }
    if (grants.length) {
      await queryInterface.bulkInsert('role_permissions', grants);
    }
  },

  async down() {
    // Deliberately a no-op: reversing this would mean re-deriving the
    // pre-migration grant set, which nothing records. The forward direction
    // is idempotent and safe to re-run, which is what actually matters here.
  },
};
