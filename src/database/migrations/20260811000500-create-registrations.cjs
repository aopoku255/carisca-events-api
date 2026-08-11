/* eslint-disable */
'use strict';

/**
 * Registration, including the configurable question system. Questions are rows,
 * so an administrator adds "What is your organization?" to one CPD without a
 * schema change and without affecting any other event.
 *
 * Duplicate protection is the UNIQUE (event_id, user_id) index. MySQL has no
 * partial unique index, so a cancelled registration keeps its row and is
 * reactivated on re-registration; the trail lives in registration_status_history.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('registration_questions', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      event_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'events', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      label: { type: Sequelize.STRING(255), allowNull: false },
      help_text: { type: Sequelize.STRING(500), allowNull: true },
      type: {
        type: Sequelize.ENUM(
          'TEXT', 'LONGTEXT', 'NUMBER', 'EMAIL', 'PHONE',
          'SELECT', 'MULTISELECT', 'RADIO', 'CHECKBOX', 'DATE', 'FILE',
        ),
        allowNull: false,
        defaultValue: 'TEXT',
      },
      // For SELECT/MULTISELECT/RADIO: [{ value, label }]
      options: { type: Sequelize.JSON, allowNull: true },
      is_required: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      sort_order: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
      deleted_at: { type: Sequelize.DATE(3), allowNull: true },
    });

    await queryInterface.addIndex('registration_questions', ['event_id', 'sort_order'], {
      name: 'idx_reg_questions_event',
    });

    await queryInterface.createTable('registrations', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      event_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
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
      // Human-quotable, e.g. CAR-CPD-26-01H8X. Unique across the platform.
      reference: { type: Sequelize.STRING(48), allowNull: false, unique: true },
      // Opaque value encoded in the QR badge. Rotatable, revocable, and it
      // carries no personal information.
      qr_token: { type: Sequelize.CHAR(32), allowNull: false, unique: true },

      status: {
        type: Sequelize.ENUM(
          'PENDING_PAYMENT', 'CONFIRMED', 'WAITLISTED', 'CANCELLED', 'REFUNDED', 'REQUIRES_REVIEW',
        ),
        allowNull: false,
        defaultValue: 'PENDING_PAYMENT',
      },
      // A seat is held from the moment registration starts, so two people
      // cannot both take the last place while one of them is paying.
      hold_expires_at: { type: Sequelize.DATE(3), allowNull: true },

      // Price frozen at registration time. Changing the event price later must
      // never retroactively alter what someone owed.
      price_amount_minor: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },
      currency: {
        type: Sequelize.CHAR(3),
        allowNull: true,
        references: { model: 'currencies', key: 'code' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      price_tier: { type: Sequelize.STRING(48), allowNull: true },

      // Who the participant was at the time of registering. Reporting reads
      // this rather than the live profile, which they may edit later.
      profile_snapshot: { type: Sequelize.JSON, allowNull: true },
      special_requirements: { type: Sequelize.STRING(1000), allowNull: true },

      confirmed_at: { type: Sequelize.DATE(3), allowNull: true },
      cancelled_at: { type: Sequelize.DATE(3), allowNull: true },
      cancellation_reason: { type: Sequelize.STRING(500), allowNull: true },
      review_reason: { type: Sequelize.STRING(500), allowNull: true },

      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
      deleted_at: { type: Sequelize.DATE(3), allowNull: true },
    });

    await queryInterface.addConstraint('registrations', {
      fields: ['event_id', 'user_id'],
      type: 'unique',
      name: 'uq_registration_event_user',
    });
    await queryInterface.addIndex('registrations', ['event_id', 'status'], { name: 'idx_registrations_event_status' });
    await queryInterface.addIndex('registrations', ['user_id', 'status'], { name: 'idx_registrations_user_status' });
    await queryInterface.addIndex('registrations', ['hold_expires_at'], { name: 'idx_registrations_hold' });

    await queryInterface.createTable('registration_answers', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      registration_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'registrations', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      question_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'registration_questions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      value: { type: Sequelize.TEXT, allowNull: true },
      file_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'files', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.addConstraint('registration_answers', {
      fields: ['registration_id', 'question_id'],
      type: 'unique',
      name: 'uq_answer_registration_question',
    });

    await queryInterface.createTable('registration_status_history', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      registration_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'registrations', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      from_status: { type: Sequelize.STRING(32), allowNull: true },
      to_status: { type: Sequelize.STRING(32), allowNull: false },
      reason: { type: Sequelize.STRING(500), allowNull: true },
      changed_by: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.addIndex('registration_status_history', ['registration_id', 'created_at'], {
      name: 'idx_reg_history_registration',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('registration_status_history');
    await queryInterface.dropTable('registration_answers');
    await queryInterface.dropTable('registrations');
    await queryInterface.dropTable('registration_questions');
  },
};
