/* eslint-disable */
'use strict';

/**
 * Notifications use an outbox: the row is written inside the same transaction
 * as the state change that caused it, and a worker dispatches it afterwards.
 * A rolled-back registration therefore cannot email anyone, and a crash after
 * commit cannot lose the message.
 *
 * The approvals tables are created now but left unused. Publishing checks for
 * a configured workflow and proceeds directly when none exists, so switching
 * approvals on later is a data change rather than a migration.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('notifications', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      user_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      channel: {
        type: Sequelize.ENUM('EMAIL', 'IN_APP', 'SMS'),
        allowNull: false,
        defaultValue: 'IN_APP',
      },
      template: { type: Sequelize.STRING(96), allowNull: false },
      subject: { type: Sequelize.STRING(255), allowNull: true },
      // Rendered at dispatch time from this payload, so a template fix applies
      // to anything still queued.
      payload: { type: Sequelize.JSON, allowNull: true },
      to_address: { type: Sequelize.STRING(255), allowNull: true },

      status: {
        type: Sequelize.ENUM('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED'),
        allowNull: false,
        defaultValue: 'PENDING',
      },
      attempts: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      last_error: { type: Sequelize.TEXT, allowNull: true },
      // Backoff marker: the dispatcher only picks up rows due now or earlier.
      next_attempt_at: { type: Sequelize.DATE(3), allowNull: true },
      sent_at: { type: Sequelize.DATE(3), allowNull: true },
      read_at: { type: Sequelize.DATE(3), allowNull: true },

      resource_type: { type: Sequelize.STRING(64), allowNull: true },
      resource_id: { type: Sequelize.STRING(64), allowNull: true },

      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.addIndex('notifications', ['status', 'next_attempt_at'], { name: 'idx_notifications_due' });
    await queryInterface.addIndex('notifications', ['user_id', 'channel', 'read_at'], { name: 'idx_notifications_inbox' });

    await queryInterface.createTable('approval_workflows', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      // e.g. resource_type 'event', action 'publish', module 'cpd'
      module: { type: Sequelize.STRING(48), allowNull: true },
      resource_type: { type: Sequelize.STRING(64), allowNull: false },
      action: { type: Sequelize.STRING(48), allowNull: false },
      name: { type: Sequelize.STRING(120), allowNull: false },
      is_enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.addConstraint('approval_workflows', {
      fields: ['module', 'resource_type', 'action'],
      type: 'unique',
      name: 'uq_workflow_scope',
    });

    await queryInterface.createTable('approval_steps', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      workflow_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'approval_workflows', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      step_order: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      name: { type: Sequelize.STRING(120), allowNull: false },
      // A step is satisfied by anyone holding this permission, or this role.
      required_permission: { type: Sequelize.STRING(96), allowNull: true },
      required_role_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'roles', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.addIndex('approval_steps', ['workflow_id', 'step_order'], { name: 'idx_steps_workflow' });

    await queryInterface.createTable('approval_requests', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      workflow_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'approval_workflows', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      resource_type: { type: Sequelize.STRING(64), allowNull: false },
      resource_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false },
      current_step: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      status: {
        type: Sequelize.ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'),
        allowNull: false,
        defaultValue: 'PENDING',
      },
      requested_by: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      completed_at: { type: Sequelize.DATE(3), allowNull: true },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.addIndex('approval_requests', ['resource_type', 'resource_id'], { name: 'idx_approval_resource' });
    await queryInterface.addIndex('approval_requests', ['status'], { name: 'idx_approval_status' });

    await queryInterface.createTable('approval_actions', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      request_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'approval_requests', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      step_order: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      decision: { type: Sequelize.ENUM('APPROVED', 'REJECTED', 'CHANGES_REQUESTED'), allowNull: false },
      comment: { type: Sequelize.STRING(1000), allowNull: true },
      actor_user_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.addIndex('approval_actions', ['request_id'], { name: 'idx_approval_actions_request' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('approval_actions');
    await queryInterface.dropTable('approval_requests');
    await queryInterface.dropTable('approval_steps');
    await queryInterface.dropTable('approval_workflows');
    await queryInterface.dropTable('notifications');
  },
};
