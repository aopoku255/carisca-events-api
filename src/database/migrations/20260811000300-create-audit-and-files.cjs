/* eslint-disable */
'use strict';

/**
 * Audit logs are append-only. The application never issues UPDATE or DELETE
 * against this table, and the triggers below make that structural rather than
 * a matter of discipline — an admin with raw SQL access still cannot rewrite
 * history through the app's connection.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('audit_logs', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      actor_user_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        // Never CASCADE: deleting a user must not erase what they did.
        onDelete: 'SET NULL',
      },
      actor_email: { type: Sequelize.STRING(190), allowNull: true },
      action: { type: Sequelize.STRING(96), allowNull: false },
      resource_type: { type: Sequelize.STRING(64), allowNull: false },
      resource_id: { type: Sequelize.STRING(64), allowNull: true },
      before: { type: Sequelize.JSON, allowNull: true },
      after: { type: Sequelize.JSON, allowNull: true },
      metadata: { type: Sequelize.JSON, allowNull: true },
      ip: { type: Sequelize.STRING(45), allowNull: true },
      user_agent: { type: Sequelize.STRING(255), allowNull: true },
      request_id: { type: Sequelize.CHAR(26), allowNull: true },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.addIndex('audit_logs', ['resource_type', 'resource_id'], { name: 'idx_audit_resource' });
    await queryInterface.addIndex('audit_logs', ['actor_user_id', 'created_at'], { name: 'idx_audit_actor' });
    await queryInterface.addIndex('audit_logs', ['action', 'created_at'], { name: 'idx_audit_action' });

    await queryInterface.sequelize.query(`
      CREATE TRIGGER trg_audit_logs_no_update
      BEFORE UPDATE ON audit_logs
      FOR EACH ROW
      SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'audit_logs is append-only: UPDATE is not permitted';
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER trg_audit_logs_no_delete
      BEFORE DELETE ON audit_logs
      FOR EACH ROW
      SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'audit_logs is append-only: DELETE is not permitted';
    `);

    await queryInterface.createTable('files', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      storage_provider: {
        type: Sequelize.ENUM('local', 's3', 'gcs'),
        allowNull: false,
        defaultValue: 'local',
      },
      // Random, never derived from a filename or a sequential id, so no
      // stored object is guessable from another.
      storage_key: { type: Sequelize.STRING(255), allowNull: false, unique: true },
      original_name: { type: Sequelize.STRING(255), allowNull: false },
      mime_type: { type: Sequelize.STRING(128), allowNull: false },
      size_bytes: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false },
      checksum: { type: Sequelize.CHAR(64), allowNull: true },
      visibility: {
        type: Sequelize.ENUM('PUBLIC', 'PRIVATE'),
        allowNull: false,
        defaultValue: 'PRIVATE',
      },
      // What the file is for. Drives retention and access rules.
      purpose: { type: Sequelize.STRING(48), allowNull: false, defaultValue: 'GENERAL' },
      uploaded_by: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
      deleted_at: { type: Sequelize.DATE(3), allowNull: true },
    });

    await queryInterface.addIndex('files', ['purpose'], { name: 'idx_files_purpose' });
    await queryInterface.addIndex('files', ['uploaded_by'], { name: 'idx_files_uploader' });

    await queryInterface.createTable('system_settings', {
      key: { type: Sequelize.STRING(96), primaryKey: true, allowNull: false },
      value: { type: Sequelize.JSON, allowNull: true },
      description: { type: Sequelize.STRING(255), allowNull: true },
      // Secrets stay in environment variables; this table is for operational
      // configuration an administrator is allowed to change at runtime.
      is_public: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      updated_by: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TRIGGER IF EXISTS trg_audit_logs_no_update');
    await queryInterface.sequelize.query('DROP TRIGGER IF EXISTS trg_audit_logs_no_delete');
    await queryInterface.dropTable('system_settings');
    await queryInterface.dropTable('files');
    await queryInterface.dropTable('audit_logs');
  },
};
