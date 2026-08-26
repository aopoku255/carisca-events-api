/* eslint-disable */
'use strict';

/**
 * A configurable list of sponsorship levels per event — Platinum, Gold,
 * Silver — with their own benefits text, the same "per-event configurable
 * list" shape `event_prices` already uses for registration fees.
 *
 * The tier belongs to the PAIRING (`event_partners.sponsorship_tier_id`), not
 * to the partner itself: the same institution can be Platinum on one Summit
 * and Gold on the next, exactly as `event_partners.role` already belongs to
 * the pairing rather than the partner. `price_amount_minor`/`currency` are
 * informational display fields only — nothing here creates a payment
 * obligation or touches the payments module.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('event_sponsorship_tiers', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      event_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'events', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      // Free text, not an enum — organizers name their own tiers.
      name: { type: Sequelize.STRING(80), allowNull: false },
      // One benefit per line, rendered as a list — same convention as
      // event_sessions.description and cpd_event_details.learning_objectives.
      benefits: { type: Sequelize.TEXT, allowNull: true },
      price_amount_minor: { type: Sequelize.BIGINT.UNSIGNED, allowNull: true },
      currency: {
        type: Sequelize.CHAR(3),
        allowNull: true,
        references: { model: 'currencies', key: 'code' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      sort_order: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
      deleted_at: { type: Sequelize.DATE(3) },
    });
    await queryInterface.addIndex('event_sponsorship_tiers', ['event_id'], { name: 'idx_sponsorship_tiers_event' });

    await queryInterface.addColumn('event_partners', 'sponsorship_tier_id', {
      type: Sequelize.BIGINT.UNSIGNED,
      allowNull: true,
      references: { model: 'event_sponsorship_tiers', key: 'id' },
      onUpdate: 'CASCADE',
      // A sponsor with role SPONSOR and no tier_id is still a valid, ordinary
      // sponsor — deleting the tier just ungroups them, same as a track.
      onDelete: 'SET NULL',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('event_partners', 'sponsorship_tier_id');
    await queryInterface.dropTable('event_sponsorship_tiers');
  },
};
