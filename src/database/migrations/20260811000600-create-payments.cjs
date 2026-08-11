/* eslint-disable */
'use strict';

/**
 * Payments. Three rules are enforced structurally rather than by convention:
 *
 *   1. Money is always BIGINT minor units plus an explicit currency.
 *   2. `payment_events.provider_event_id` is UNIQUE, so a replayed webhook
 *      cannot be processed twice.
 *   3. Routing lives in a table, so no country or provider is named in code.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('payment_providers', {
      key: { type: Sequelize.STRING(32), primaryKey: true, allowNull: false },
      name: { type: Sequelize.STRING(80), allowNull: false },
      is_enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      // Flipped by the health check; routing skips a provider that is down.
      is_healthy: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      last_health_check_at: { type: Sequelize.DATE(3), allowNull: true },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.createTable('payment_routing_rules', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      currency: {
        type: Sequelize.CHAR(3),
        allowNull: false,
        references: { model: 'currencies', key: 'code' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      // NULL means "any country" — the fallback rule for that currency.
      country_code: {
        type: Sequelize.CHAR(2),
        allowNull: true,
        references: { model: 'countries', key: 'iso2' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      provider: {
        type: Sequelize.STRING(32),
        allowNull: false,
        references: { model: 'payment_providers', key: 'key' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      priority: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 100 },
      is_enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.addIndex('payment_routing_rules', ['currency', 'country_code', 'priority'], {
      name: 'idx_routing_lookup',
    });

    await queryInterface.createTable('payments', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      registration_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'registrations', key: 'id' },
        onUpdate: 'CASCADE',
        // Money received is never deleted along with a registration.
        onDelete: 'RESTRICT',
      },
      event_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'events', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      user_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },

      // Our reference, generated before the provider is even chosen. This is
      // the idempotency anchor for the whole transaction.
      reference: { type: Sequelize.STRING(48), allowNull: false, unique: true },
      provider: {
        type: Sequelize.STRING(32),
        allowNull: false,
        references: { model: 'payment_providers', key: 'key' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      provider_reference: { type: Sequelize.STRING(191), allowNull: true },

      amount_minor: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false },
      currency: {
        type: Sequelize.CHAR(3),
        allowNull: false,
        references: { model: 'currencies', key: 'code' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      amount_refunded_minor: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },

      status: {
        type: Sequelize.ENUM(
          'PENDING', 'PROCESSING', 'SUCCESSFUL', 'FAILED',
          'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED',
        ),
        allowNull: false,
        defaultValue: 'PENDING',
      },
      failure_reason: { type: Sequelize.STRING(500), allowNull: true },

      checkout_url: { type: Sequelize.STRING(1000), allowNull: true },
      paid_at: { type: Sequelize.DATE(3), allowNull: true },
      // Set by the reconciliation sweep so a stuck payment is only polled once
      // per interval rather than on every pass.
      last_verified_at: { type: Sequelize.DATE(3), allowNull: true },
      provider_metadata: { type: Sequelize.JSON, allowNull: true },

      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.addConstraint('payments', {
      fields: ['provider', 'provider_reference'],
      type: 'unique',
      name: 'uq_payment_provider_reference',
    });
    await queryInterface.addIndex('payments', ['status', 'created_at'], { name: 'idx_payments_status_created' });
    await queryInterface.addIndex('payments', ['registration_id'], { name: 'idx_payments_registration' });
    await queryInterface.addIndex('payments', ['user_id'], { name: 'idx_payments_user' });
    await queryInterface.addIndex('payments', ['event_id', 'status'], { name: 'idx_payments_event_status' });

    await queryInterface.createTable('payment_events', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      payment_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'payments', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      provider: { type: Sequelize.STRING(32), allowNull: false },
      // The dedupe key. A webhook replay fails this unique insert and is
      // acknowledged without being processed a second time.
      provider_event_id: { type: Sequelize.STRING(191), allowNull: false, unique: true },
      event_type: { type: Sequelize.STRING(96), allowNull: false },
      raw_payload: { type: Sequelize.JSON, allowNull: true },
      signature_valid: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      processing_status: {
        type: Sequelize.ENUM('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED'),
        allowNull: false,
        defaultValue: 'RECEIVED',
      },
      processing_error: { type: Sequelize.TEXT, allowNull: true },
      attempts: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      received_at: { type: Sequelize.DATE(3), allowNull: false },
      processed_at: { type: Sequelize.DATE(3), allowNull: true },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.addIndex('payment_events', ['payment_id'], { name: 'idx_payment_events_payment' });
    await queryInterface.addIndex('payment_events', ['processing_status', 'received_at'], {
      name: 'idx_payment_events_status',
    });

    await queryInterface.createTable('payment_refunds', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      payment_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'payments', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      amount_minor: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false },
      status: {
        type: Sequelize.ENUM('PENDING', 'SUCCESSFUL', 'FAILED'),
        allowNull: false,
        defaultValue: 'PENDING',
      },
      reason: { type: Sequelize.STRING(500), allowNull: true },
      provider_refund_id: { type: Sequelize.STRING(191), allowNull: true },
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

    await queryInterface.addIndex('payment_refunds', ['payment_id'], { name: 'idx_refunds_payment' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('payment_refunds');
    await queryInterface.dropTable('payment_events');
    await queryInterface.dropTable('payments');
    await queryInterface.dropTable('payment_routing_rules');
    await queryInterface.dropTable('payment_providers');
  },
};
