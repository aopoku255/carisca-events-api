/* eslint-disable */
'use strict';

/**
 * The shared event core. CPD, Summit and Business Forum are all rows in
 * `events` distinguished by `event_type_id`; module-specific structure lives in
 * a 1:1 extension table. Registrations, payments, attendance and certificates
 * all point at `events.id` and never at an extension table — that is what makes
 * a second module cheap.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('event_types', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      key: { type: Sequelize.STRING(48), allowNull: false, unique: true },
      name: { type: Sequelize.STRING(120), allowNull: false },
      // Route prefix the module is mounted under, e.g. 'cpd'.
      module: { type: Sequelize.STRING(48), allowNull: false },
      description: { type: Sequelize.STRING(255), allowNull: true },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.createTable('events', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      event_type_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'event_types', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      slug: { type: Sequelize.STRING(180), allowNull: false, unique: true },
      title: { type: Sequelize.STRING(255), allowNull: false },
      short_description: { type: Sequelize.STRING(500), allowNull: true },
      description: { type: Sequelize.TEXT, allowNull: true },
      banner_file_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'files', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },

      // --- when -------------------------------------------------------------
      // Stored in UTC. `timezone` is the IANA zone the event is advertised in;
      // wall-clock time is derived from the two together, never assumed.
      start_at: { type: Sequelize.DATE(3), allowNull: false },
      end_at: { type: Sequelize.DATE(3), allowNull: false },
      timezone: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'Africa/Accra' },

      // --- where ------------------------------------------------------------
      delivery_mode: {
        type: Sequelize.ENUM('ONLINE', 'OFFLINE', 'HYBRID'),
        allowNull: false,
        defaultValue: 'OFFLINE',
      },
      country_code: {
        type: Sequelize.CHAR(2),
        allowNull: true,
        references: { model: 'countries', key: 'iso2' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      city: { type: Sequelize.STRING(120), allowNull: true },
      venue: { type: Sequelize.STRING(255), allowNull: true },
      online_url: { type: Sequelize.STRING(500), allowNull: true },

      // --- registration -----------------------------------------------------
      capacity: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true }, // NULL = unlimited
      allow_waitlist: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      registration_opens_at: { type: Sequelize.DATE(3), allowNull: true },
      registration_closes_at: { type: Sequelize.DATE(3), allowNull: true },

      status: {
        type: Sequelize.ENUM(
          'DRAFT',
          'PENDING_APPROVAL',
          'PUBLISHED',
          'REGISTRATION_OPEN',
          'REGISTRATION_CLOSED',
          'ONGOING',
          'COMPLETED',
          'CANCELLED',
          'ARCHIVED',
        ),
        allowNull: false,
        defaultValue: 'DRAFT',
      },
      cancelled_reason: { type: Sequelize.STRING(500), allowNull: true },

      // --- certificate policy ----------------------------------------------
      issues_certificate: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      certificate_template_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: true }, // FK added later
      certificate_requires_payment: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      certificate_requires_evaluation: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },

      // --- attendance policy -------------------------------------------------
      attendance_rule: {
        type: Sequelize.ENUM('NONE', 'CHECK_IN', 'SESSION_PERCENT'),
        allowNull: false,
        defaultValue: 'CHECK_IN',
      },
      min_attendance_percent: { type: Sequelize.TINYINT.UNSIGNED, allowNull: true },

      // --- ownership and contact --------------------------------------------
      organizer_department_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'departments', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      contact_email: { type: Sequelize.STRING(190), allowNull: true },
      contact_phone: { type: Sequelize.STRING(32), allowNull: true },

      created_by: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      published_at: { type: Sequelize.DATE(3), allowNull: true },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
      deleted_at: { type: Sequelize.DATE(3), allowNull: true },
    });

    await queryInterface.addIndex('events', ['status', 'start_at'], { name: 'idx_events_status_start' });
    await queryInterface.addIndex('events', ['event_type_id', 'status'], { name: 'idx_events_type_status' });
    await queryInterface.addIndex('events', ['country_code'], { name: 'idx_events_country' });
    await queryInterface.addIndex('events', ['organizer_department_id'], { name: 'idx_events_department' });

    // --- CPD extension ------------------------------------------------------
    await queryInterface.createTable('cpd_event_details', {
      event_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        primaryKey: true,
        allowNull: false,
        references: { model: 'events', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      cpd_credits: { type: Sequelize.DECIMAL(5, 2), allowNull: true },
      accrediting_body: { type: Sequelize.STRING(160), allowNull: true },
      learning_objectives: { type: Sequelize.JSON, allowNull: true },
      target_audience: { type: Sequelize.JSON, allowNull: true },
      requirements: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    // --- sessions, speakers, prices ----------------------------------------
    await queryInterface.createTable('event_sessions', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      event_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'events', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      title: { type: Sequelize.STRING(255), allowNull: false },
      description: { type: Sequelize.TEXT, allowNull: true },
      start_at: { type: Sequelize.DATE(3), allowNull: false },
      end_at: { type: Sequelize.DATE(3), allowNull: false },
      location: { type: Sequelize.STRING(255), allowNull: true },
      // Only sessions marked required count toward a SESSION_PERCENT rule.
      is_required_for_attendance: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      sort_order: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
      deleted_at: { type: Sequelize.DATE(3), allowNull: true },
    });

    await queryInterface.addIndex('event_sessions', ['event_id', 'start_at'], { name: 'idx_sessions_event_start' });

    await queryInterface.createTable('event_speakers', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      event_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'events', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      name: { type: Sequelize.STRING(160), allowNull: false },
      title: { type: Sequelize.STRING(160), allowNull: true },
      organization: { type: Sequelize.STRING(160), allowNull: true },
      bio: { type: Sequelize.TEXT, allowNull: true },
      photo_file_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'files', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      role: {
        type: Sequelize.ENUM('SPEAKER', 'FACILITATOR', 'MODERATOR', 'PANELLIST'),
        allowNull: false,
        defaultValue: 'SPEAKER',
      },
      sort_order: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
      deleted_at: { type: Sequelize.DATE(3), allowNull: true },
    });

    await queryInterface.addIndex('event_speakers', ['event_id'], { name: 'idx_speakers_event' });

    // A price list rather than a price column: early-bird, student and member
    // tiers slot in later without a migration.
    await queryInterface.createTable('event_prices', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      event_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'events', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      tier: { type: Sequelize.STRING(48), allowNull: false, defaultValue: 'standard' },
      label: { type: Sequelize.STRING(120), allowNull: false },
      // Integer minor units. Never a float, never a decimal cast to JS number.
      amount_minor: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },
      currency: {
        type: Sequelize.CHAR(3),
        allowNull: false,
        references: { model: 'currencies', key: 'code' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      is_default: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      available_from: { type: Sequelize.DATE(3), allowNull: true },
      available_until: { type: Sequelize.DATE(3), allowNull: true },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
      deleted_at: { type: Sequelize.DATE(3), allowNull: true },
    });

    await queryInterface.addIndex('event_prices', ['event_id', 'tier'], { name: 'idx_prices_event_tier' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('event_prices');
    await queryInterface.dropTable('event_speakers');
    await queryInterface.dropTable('event_sessions');
    await queryInterface.dropTable('cpd_event_details');
    await queryInterface.dropTable('events');
    await queryInterface.dropTable('event_types');
  },
};
