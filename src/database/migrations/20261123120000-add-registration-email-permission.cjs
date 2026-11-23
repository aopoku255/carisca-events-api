/* eslint-disable */
'use strict';

/**
 * `registration.email` — emailing an event's participants. Inserts the
 * permission row itself and grants it to the manager role, because
 * `syncPermissions()` adds rows at boot but never touches `role_permissions`
 * (super_admin holds everything through its wildcard already).
 */
const KEY = 'registration.email';

module.exports = {
  async up(queryInterface) {
    const ts = new Date();
    const find = () => queryInterface.sequelize.query(
      'SELECT id FROM permissions WHERE `key` = :key LIMIT 1', { replacements: { key: KEY } },
    );

    let [existing] = await find();
    if (!existing[0]) {
      await queryInterface.bulkInsert('permissions', [{
        key: KEY,
        module: 'core',
        resource: 'registration',
        action: 'email',
        description: "Email an event's participants, individually or in bulk",
        created_at: ts,
        updated_at: ts,
      }]);
      [existing] = await find();
    }
    const permissionId = existing[0].id;

    const [roles] = await queryInterface.sequelize.query(
      "SELECT id FROM roles WHERE `key` = 'manager'",
    );
    for (const role of roles) {
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
      'SELECT id FROM permissions WHERE `key` = :key LIMIT 1', { replacements: { key: KEY } },
    );
    if (existing[0]?.id) {
      await queryInterface.bulkDelete('role_permissions', { permission_id: existing[0].id });
      await queryInterface.bulkDelete('permissions', { id: existing[0].id });
    }
  },
};
