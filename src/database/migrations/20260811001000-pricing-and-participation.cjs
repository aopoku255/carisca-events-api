/* eslint-disable */
'use strict';

/**
 * Two changes driven by how the live CPD registration actually prices and
 * enrols people.
 *
 * 1. PRICE IS NOT ONE NUMBER PER EVENT.
 *
 *    cpd.carisca.org quotes, for a single event:
 *      Virtual                  $25
 *      In-Person (Africa)       $50
 *      In-Person (Outside Africa) $150
 *    and elsewhere the same event in GHS (1000 virtual / 1500 in-person).
 *
 *    So the price depends on how you attend, where you are, and which currency
 *    you pay in. `event_prices` was already a list; it now carries the
 *    conditions that select a row, and resolution is a query rather than a
 *    branch in application code.
 *
 * 2. HOW SOMEONE ATTENDS IS PART OF THE REGISTRATION.
 *
 *    In-person and virtual are the same event with different capacity, badge
 *    and attendance implications — not two events.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // --- pricing conditions -------------------------------------------------
    await queryInterface.addColumn('event_prices', 'attendance_mode', {
      type: Sequelize.ENUM('ANY', 'IN_PERSON', 'VIRTUAL'),
      allowNull: false,
      defaultValue: 'ANY',
      after: 'tier',
    });

    /**
     * Where the participant is, as a pricing band:
     *   HOST_COUNTRY  — same country as the event
     *   AFRICA        — anywhere in the Africa region
     *   INTERNATIONAL — everywhere else
     *   ANY           — no geographic condition
     */
    await queryInterface.addColumn('event_prices', 'audience', {
      type: Sequelize.ENUM('ANY', 'HOST_COUNTRY', 'AFRICA', 'INTERNATIONAL'),
      allowNull: false,
      defaultValue: 'ANY',
      after: 'attendance_mode',
    });

    // Tie-break when several rows match equally well. Lower wins.
    await queryInterface.addColumn('event_prices', 'priority', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 100,
      after: 'audience',
    });

    await queryInterface.addIndex('event_prices', ['event_id', 'currency', 'attendance_mode', 'audience'], {
      name: 'idx_prices_resolution',
    });

    // --- how the participant attends and what they consented to -------------
    await queryInterface.addColumn('registrations', 'attendance_mode', {
      type: Sequelize.ENUM('IN_PERSON', 'VIRTUAL'),
      allowNull: false,
      defaultValue: 'IN_PERSON',
      after: 'status',
    });

    await queryInterface.addColumn('registrations', 'wants_certificate', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
    });

    await queryInterface.addColumn('registrations', 'is_previous_attendee', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
    });

    await queryInterface.addColumn('registrations', 'comments', {
      type: Sequelize.TEXT,
      allowNull: true,
    });

    /**
     * Consent to being recorded is a legal record, not a checkbox. Storing the
     * moment and the address it was given from makes it evidence; a bare
     * boolean does not.
     */
    await queryInterface.addColumn('registrations', 'media_consent_at', {
      type: Sequelize.DATE(3),
      allowNull: true,
    });
    await queryInterface.addColumn('registrations', 'media_consent_ip', {
      type: Sequelize.STRING(45),
      allowNull: true,
    });

    // Supporting evidence for a concessionary rate, e.g. a student ID card.
    await queryInterface.addColumn('registrations', 'evidence_file_id', {
      type: Sequelize.BIGINT.UNSIGNED,
      allowNull: true,
      references: { model: 'files', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });

    await queryInterface.addIndex('registrations', ['event_id', 'attendance_mode'], {
      name: 'idx_registrations_event_mode',
    });

    /**
     * Virtual attendance usually has no physical limit while in-person does,
     * so capacity is tracked per mode. NULL means unlimited, matching
     * `events.capacity`.
     */
    await queryInterface.addColumn('events', 'virtual_capacity', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
      after: 'capacity',
    });

    /**
     * The live flow emails a payment link and cancels the registration if it
     * is not paid "before the specified deadline" — days, not the 30 minutes a
     * checkout hold assumes. Per-event so a high-demand event can be tighter.
     */
    await queryInterface.addColumn('events', 'payment_hold_hours', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
      after: 'registration_closes_at',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('events', 'payment_hold_hours');
    await queryInterface.removeColumn('events', 'virtual_capacity');
    await queryInterface.removeIndex('registrations', 'idx_registrations_event_mode');
    for (const c of [
      'evidence_file_id', 'media_consent_ip', 'media_consent_at', 'comments',
      'is_previous_attendee', 'wants_certificate', 'attendance_mode',
    ]) {
      await queryInterface.removeColumn('registrations', c);
    }
    await queryInterface.removeIndex('event_prices', 'idx_prices_resolution');
    for (const c of ['priority', 'audience', 'attendance_mode']) {
      await queryInterface.removeColumn('event_prices', c);
    }
  },
};
