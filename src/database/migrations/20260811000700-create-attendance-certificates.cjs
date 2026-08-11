/* eslint-disable */
'use strict';

/**
 * Attendance, certificates and evaluation.
 *
 * A certificate is a record of something that happened, so it snapshots its
 * facts at issue time and is generated exactly once — UNIQUE(registration_id).
 * Revocation sets a status; it never deletes the row, because the whole point
 * of public verification is being able to say "this was issued and withdrawn".
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('attendance_records', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      registration_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'registrations', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      // NULL = attendance for the event as a whole (single-session events).
      //
      // RESTRICT rather than CASCADE for two reasons. First, MySQL forbids
      // CASCADE or SET NULL on the base column of a STORED generated column,
      // and `session_key` below is generated from this one. Second, it is the
      // behaviour we want: a session with attendance recorded against it must
      // not be hard-deleted out from under the record. Sessions are soft-
      // deleted in normal operation, so this rarely bites.
      session_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'event_sessions', key: 'id' },
        onUpdate: 'NO ACTION',
        onDelete: 'RESTRICT',
      },
      status: {
        type: Sequelize.ENUM('REGISTERED', 'CHECKED_IN', 'ATTENDED', 'ABSENT'),
        allowNull: false,
        defaultValue: 'REGISTERED',
      },
      check_in_at: { type: Sequelize.DATE(3), allowNull: true },
      check_out_at: { type: Sequelize.DATE(3), allowNull: true },
      method: {
        type: Sequelize.ENUM('QR', 'MANUAL', 'IMPORT', 'SELF'),
        allowNull: false,
        defaultValue: 'QR',
      },
      recorded_by: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      device_info: { type: Sequelize.STRING(255), allowNull: true },
      notes: { type: Sequelize.STRING(500), allowNull: true },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    // One row per registration per session. A second scan updates the existing
    // row (check-out) rather than creating a duplicate attendance record.
    //
    // MySQL treats NULLs as distinct in a UNIQUE index, so `session_id IS NULL`
    // rows would not be constrained. `session_key` is a generated column that
    // collapses NULL to 0 purely so the constraint bites for whole-event rows.
    await queryInterface.sequelize.query(`
      ALTER TABLE attendance_records
      ADD COLUMN session_key BIGINT UNSIGNED
        AS (IFNULL(session_id, 0)) STORED NOT NULL
    `);
    await queryInterface.addConstraint('attendance_records', {
      fields: ['registration_id', 'session_key'],
      type: 'unique',
      name: 'uq_attendance_registration_session',
    });
    await queryInterface.addIndex('attendance_records', ['session_id'], { name: 'idx_attendance_session' });
    await queryInterface.addIndex('attendance_records', ['status'], { name: 'idx_attendance_status' });

    // --- certificates -------------------------------------------------------
    await queryInterface.createTable('certificate_templates', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      name: { type: Sequelize.STRING(120), allowNull: false },
      description: { type: Sequelize.STRING(255), allowNull: true },
      background_file_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'files', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      orientation: {
        type: Sequelize.ENUM('PORTRAIT', 'LANDSCAPE'),
        allowNull: false,
        defaultValue: 'LANDSCAPE',
      },
      // Positioned fields, fonts and signature blocks. Rendered server-side.
      layout: { type: Sequelize.JSON, allowNull: true },
      is_default: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_by: {
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

    await queryInterface.addConstraint('events', {
      fields: ['certificate_template_id'],
      type: 'foreign key',
      name: 'fk_events_certificate_template',
      references: { table: 'certificate_templates', field: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });

    await queryInterface.createTable('certificates', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      registration_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        unique: true, // one certificate per registration, enforced by the database
        references: { model: 'registrations', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
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
      template_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'certificate_templates', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      // e.g. CARISCA-CPD-2026-000123-K4F9. Contains a random component so the
      // space cannot be walked sequentially.
      verification_code: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      // Participant name, event title, dates, credits and signatories as they
      // stood at issuance. Editing the event later must not alter this.
      issued_snapshot: { type: Sequelize.JSON, allowNull: false },
      file_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'files', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      status: {
        type: Sequelize.ENUM('PENDING', 'GENERATING', 'ISSUED', 'FAILED', 'REVOKED'),
        allowNull: false,
        defaultValue: 'PENDING',
      },
      generation_error: { type: Sequelize.TEXT, allowNull: true },
      generation_attempts: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      issued_at: { type: Sequelize.DATE(3), allowNull: true },
      revoked_at: { type: Sequelize.DATE(3), allowNull: true },
      revoked_reason: { type: Sequelize.STRING(500), allowNull: true },
      revoked_by: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      download_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      last_downloaded_at: { type: Sequelize.DATE(3), allowNull: true },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.addIndex('certificates', ['event_id', 'status'], { name: 'idx_certificates_event_status' });
    await queryInterface.addIndex('certificates', ['user_id'], { name: 'idx_certificates_user' });

    // --- evaluation ---------------------------------------------------------
    await queryInterface.createTable('evaluation_forms', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      event_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'events', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      title: { type: Sequelize.STRING(255), allowNull: false },
      phase: { type: Sequelize.ENUM('PRE', 'POST'), allowNull: false, defaultValue: 'POST' },
      is_required_for_certificate: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      is_anonymous: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      opens_at: { type: Sequelize.DATE(3), allowNull: true },
      closes_at: { type: Sequelize.DATE(3), allowNull: true },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
      deleted_at: { type: Sequelize.DATE(3), allowNull: true },
    });

    await queryInterface.addIndex('evaluation_forms', ['event_id', 'phase'], { name: 'idx_eval_forms_event' });

    await queryInterface.createTable('evaluation_questions', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      form_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'evaluation_forms', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      label: { type: Sequelize.STRING(500), allowNull: false },
      type: {
        type: Sequelize.ENUM(
          'TEXT', 'LONGTEXT', 'NUMBER', 'SELECT', 'MULTISELECT',
          'RADIO', 'CHECKBOX', 'RATING', 'NPS', 'DATE',
        ),
        allowNull: false,
        defaultValue: 'RATING',
      },
      options: { type: Sequelize.JSON, allowNull: true },
      // Groups answers for M&E rollups: satisfaction, learning_outcome, facilitator.
      category: { type: Sequelize.STRING(48), allowNull: true },
      is_required: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      sort_order: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
      deleted_at: { type: Sequelize.DATE(3), allowNull: true },
    });

    await queryInterface.addIndex('evaluation_questions', ['form_id', 'sort_order'], { name: 'idx_eval_questions_form' });

    await queryInterface.createTable('evaluation_responses', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      form_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'evaluation_forms', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      // Nullable so an anonymous form can still be tied to an event without
      // identifying the respondent.
      registration_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'registrations', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      question_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'evaluation_questions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      value: { type: Sequelize.TEXT, allowNull: true },
      numeric_value: { type: Sequelize.DECIMAL(8, 2), allowNull: true },
      submitted_at: { type: Sequelize.DATE(3), allowNull: false },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.addIndex('evaluation_responses', ['form_id', 'question_id'], { name: 'idx_eval_responses_q' });
    await queryInterface.addIndex('evaluation_responses', ['registration_id'], { name: 'idx_eval_responses_reg' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('evaluation_responses');
    await queryInterface.dropTable('evaluation_questions');
    await queryInterface.dropTable('evaluation_forms');
    await queryInterface.dropTable('certificates');
    await queryInterface.removeConstraint('events', 'fk_events_certificate_template');
    await queryInterface.dropTable('certificate_templates');
    await queryInterface.dropTable('attendance_records');
  },
};
