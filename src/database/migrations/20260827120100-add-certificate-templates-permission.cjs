/* eslint-disable */
'use strict';

/**
 * `syncPermissions()` (runs at API boot) would insert this permission's row
 * on its own, but it never touches `role_permissions` — granting it to
 * director/manager in `permissions.json` alone would leave both roles unable
 * to actually use it in any already-seeded environment, the exact bug
 * `20260825120600-resync-system-role-permissions` fixed for the last batch
 * of new keys. Rather than assume boot order relative to this migration,
 * this inserts the permission row itself too, so it's correct regardless of
 * whether the API has booted with the updated `permissions.json` yet.
 */
module.exports = {
  async up(queryInterface) {
    const ts = new Date();

    const [existing] = await queryInterface.sequelize.query(
      "SELECT id FROM permissions WHERE `key` = 'certificate_templates.manage' LIMIT 1",
    );
    let permissionId = existing[0]?.id;

    if (!permissionId) {
      await queryInterface.bulkInsert('permissions', [{
        key: 'certificate_templates.manage',
        module: 'core',
        resource: 'certificate_template',
        action: 'manage',
        description: 'Add, edit and remove certificate second-signatory templates',
        created_at: ts,
        updated_at: ts,
      }]);
      const [row] = await queryInterface.sequelize.query(
        "SELECT id FROM permissions WHERE `key` = 'certificate_templates.manage' LIMIT 1",
      );
      permissionId = row[0].id;
    }

    const [roleRows] = await queryInterface.sequelize.query(
      "SELECT id, `key` FROM roles WHERE `key` IN ('director', 'manager')",
    );

    for (const role of roleRows) {
      const [grant] = await queryInterface.sequelize.query(
        'SELECT role_id FROM role_permissions WHERE role_id = :roleId AND permission_id = :permissionId LIMIT 1',
        { replacements: { roleId: role.id, permissionId } },
      );
      if (!grant.length) {
        await queryInterface.bulkInsert('role_permissions', [{
          role_id: role.id, permission_id: permissionId, created_at: ts,
        }]);
      }
    }
  },

  async down(queryInterface) {
    const [existing] = await queryInterface.sequelize.query(
      "SELECT id FROM permissions WHERE `key` = 'certificate_templates.manage' LIMIT 1",
    );
    if (existing[0]?.id) {
      await queryInterface.bulkDelete('role_permissions', { permission_id: existing[0].id });
      await queryInterface.bulkDelete('permissions', { id: existing[0].id });
    }
  },
};
