/* eslint-disable */
'use strict';

/**
 * Identity and access. Roles and permissions are rows, never constants, so a
 * new role can be created without a deploy. `users.token_version` is the kill
 * switch: bumping it invalidates every outstanding token for that user at once.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('departments', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      name: { type: Sequelize.STRING(120), allowNull: false, unique: true },
      code: { type: Sequelize.STRING(32), allowNull: false, unique: true },
      description: { type: Sequelize.STRING(255), allowNull: true },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
      deleted_at: { type: Sequelize.DATE(3), allowNull: true },
    });

    await queryInterface.createTable('users', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      email: { type: Sequelize.STRING(190), allowNull: false, unique: true },
      password_hash: { type: Sequelize.STRING(255), allowNull: false },
      first_name: { type: Sequelize.STRING(80), allowNull: false },
      last_name: { type: Sequelize.STRING(80), allowNull: false },
      phone: { type: Sequelize.STRING(32), allowNull: true },
      country_code: {
        type: Sequelize.CHAR(2),
        allowNull: true,
        references: { model: 'countries', key: 'iso2' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      organization: { type: Sequelize.STRING(160), allowNull: true },
      job_title: { type: Sequelize.STRING(160), allowNull: true },
      timezone: { type: Sequelize.STRING(64), allowNull: true },
      status: {
        type: Sequelize.ENUM('ACTIVE', 'INACTIVE', 'SUSPENDED'),
        allowNull: false,
        defaultValue: 'ACTIVE',
      },
      // Staff reach the admin console; public participants never do.
      is_staff: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      department_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'departments', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      email_verified_at: { type: Sequelize.DATE(3), allowNull: true },
      last_login_at: { type: Sequelize.DATE(3), allowNull: true },
      // Bumped on deactivation, role change or password reset. Any token
      // carrying a lower value is refused on its next request.
      token_version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
      deleted_at: { type: Sequelize.DATE(3), allowNull: true },
    });

    await queryInterface.addIndex('users', ['status', 'is_staff'], { name: 'idx_users_status_staff' });
    await queryInterface.addIndex('users', ['country_code'], { name: 'idx_users_country' });
    await queryInterface.addIndex('users', ['last_name', 'first_name'], { name: 'idx_users_name' });

    await queryInterface.createTable('roles', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      key: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      name: { type: Sequelize.STRING(120), allowNull: false },
      description: { type: Sequelize.STRING(255), allowNull: true },
      // System roles are seeded and cannot be deleted through the admin UI.
      is_system: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
      deleted_at: { type: Sequelize.DATE(3), allowNull: true },
    });

    await queryInterface.createTable('permissions', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      key: { type: Sequelize.STRING(96), allowNull: false, unique: true },
      module: { type: Sequelize.STRING(48), allowNull: false },
      resource: { type: Sequelize.STRING(48), allowNull: false },
      action: { type: Sequelize.STRING(48), allowNull: false },
      description: { type: Sequelize.STRING(255), allowNull: true },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.addIndex('permissions', ['module', 'resource'], { name: 'idx_permissions_module_resource' });

    await queryInterface.createTable('role_permissions', {
      role_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        primaryKey: true,
        references: { model: 'roles', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      permission_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        primaryKey: true,
        references: { model: 'permissions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.createTable('user_roles', {
      user_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        primaryKey: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      role_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        primaryKey: true,
        references: { model: 'roles', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      // Reserved for future event- or department-scoped grants. NULL means the
      // grant is global, which is the only behaviour v1 implements.
      scope_type: { type: Sequelize.STRING(32), allowNull: true },
      scope_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: true },
      granted_by: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.createTable('refresh_tokens', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      user_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      // The raw token is never stored, only its SHA-256 digest.
      token_hash: { type: Sequelize.CHAR(64), allowNull: false, unique: true },
      // Rotation chain. Presenting an already-rotated token revokes the whole
      // family, which is how token theft is detected.
      family_id: { type: Sequelize.CHAR(26), allowNull: false },
      user_agent: { type: Sequelize.STRING(255), allowNull: true },
      ip: { type: Sequelize.STRING(45), allowNull: true },
      revoked_at: { type: Sequelize.DATE(3), allowNull: true },
      revoked_reason: { type: Sequelize.STRING(64), allowNull: true },
      expires_at: { type: Sequelize.DATE(3), allowNull: false },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.addIndex('refresh_tokens', ['user_id', 'revoked_at'], { name: 'idx_refresh_user_revoked' });
    await queryInterface.addIndex('refresh_tokens', ['family_id'], { name: 'idx_refresh_family' });
    await queryInterface.addIndex('refresh_tokens', ['expires_at'], { name: 'idx_refresh_expires' });

    // Single-use tokens for email verification and password reset. Kept apart
    // from refresh tokens because their lifecycle and blast radius differ.
    await queryInterface.createTable('user_tokens', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      user_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      type: { type: Sequelize.ENUM('EMAIL_VERIFICATION', 'PASSWORD_RESET'), allowNull: false },
      token_hash: { type: Sequelize.CHAR(64), allowNull: false, unique: true },
      consumed_at: { type: Sequelize.DATE(3), allowNull: true },
      expires_at: { type: Sequelize.DATE(3), allowNull: false },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.addIndex('user_tokens', ['user_id', 'type', 'consumed_at'], { name: 'idx_user_tokens_lookup' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('user_tokens');
    await queryInterface.dropTable('refresh_tokens');
    await queryInterface.dropTable('user_roles');
    await queryInterface.dropTable('role_permissions');
    await queryInterface.dropTable('permissions');
    await queryInterface.dropTable('roles');
    await queryInterface.dropTable('users');
    await queryInterface.dropTable('departments');
  },
};
