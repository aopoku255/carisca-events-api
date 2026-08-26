/* eslint-disable */
'use strict';

/**
 * The Summit's 1:1 extension table, same shape and purpose as
 * `cpd_event_details` — module-specific fields live here so the shared
 * `events` table stays generic. `call_for_papers_closes_at` is the one field
 * with real behavior: abstract submission is refused once it has passed.
 * The rest is display-only context for the event page.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('summit_event_details', {
      event_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        primaryKey: true,
        allowNull: false,
        references: { model: 'events', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      theme: { type: Sequelize.STRING(255), allowNull: true },
      call_for_papers_opens_at: { type: Sequelize.DATE(3), allowNull: true },
      call_for_papers_closes_at: { type: Sequelize.DATE(3), allowNull: true },
      keynote_count: { type: Sequelize.TINYINT.UNSIGNED, allowNull: true },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('summit_event_details');
  },
};
