/* eslint-disable */
'use strict';

const path = require('path');
const registry = require(path.resolve(__dirname, '../../core/rbac/permissions.json'));

/**
 * Seeds permissions, the default roles and their grants from the shared
 * registry. Idempotent and additive: it inserts what is missing and rewrites
 * each system role's grants to match the registry exactly, so removing a
 * permission from a role in permissions.json actually removes it here too.
 *
 * Custom roles created by an administrator are never touched.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const ts = new Date();
    const { permissions, roles } = registry;

    await queryInterface.bulkInsert(
      'permissions',
      permissions.map((p) => ({
        key: p.key,
        module: p.module,
        resource: p.resource,
        action: p.action,
        description: p.description || null,
        created_at: ts,
        updated_at: ts,
      })),
      { updateOnDuplicate: ['module', 'resource', 'action', 'description', 'updated_at'] },
    );

    await queryInterface.bulkInsert(
      'roles',
      roles.map((r) => ({
        key: r.key,
        name: r.name,
        description: r.description || null,
        is_system: !!r.is_system,
        created_at: ts,
        updated_at: ts,
      })),
      { updateOnDuplicate: ['name', 'description', 'is_system', 'updated_at'] },
    );

    // Resolve keys to ids in one round trip each.
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
          throw new Error(
            `Role "${role.key}" grants unknown permission "${key}". ` +
            'Every granted key must exist in the permissions list.',
          );
        }
        grants.push({ role_id: rid, permission_id: pid, created_at: ts });
      }
    }

    // Rewrite system-role grants wholesale so the registry stays authoritative.
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

  async down(queryInterface, Sequelize) {
    const roleKeys = registry.roles.map((r) => r.key);
    const [roleRows] = await queryInterface.sequelize.query(
      'SELECT id FROM roles WHERE `key` IN (:keys)',
      { replacements: { keys: roleKeys } },
    );
    const ids = roleRows.map((r) => r.id);
    if (ids.length) {
      await queryInterface.bulkDelete('role_permissions', { role_id: { [Sequelize.Op.in]: ids } });
    }
    await queryInterface.bulkDelete('roles', { key: { [Sequelize.Op.in]: roleKeys } });
    await queryInterface.bulkDelete('permissions', {
      key: { [Sequelize.Op.in]: registry.permissions.map((p) => p.key) },
    });
  },
};
