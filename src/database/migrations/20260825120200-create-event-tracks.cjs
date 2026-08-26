/* eslint-disable */
'use strict';

/**
 * A track is a pure grouping label for a Summit's agenda — "Track A: Digital
 * Supply Chains" running alongside "Track B: Policy" — not a new attendance
 * mechanism. `AttendanceRecord` already ties to `event_sessions` generically;
 * a session simply gains an optional `track_id` saying which parallel stream
 * it belongs to. Nullable and additive, so every existing CPD session (which
 * will never set it) is untouched.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('event_tracks', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      event_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'events', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      name: { type: Sequelize.STRING(160), allowNull: false },
      description: { type: Sequelize.STRING(500), allowNull: true },
      // An optional swatch hex for the public agenda UI — cosmetic, never
      // validated beyond its column length.
      color: { type: Sequelize.STRING(16), allowNull: true },
      sort_order: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
      deleted_at: { type: Sequelize.DATE(3) },
    });
    await queryInterface.addIndex('event_tracks', ['event_id'], { name: 'idx_event_tracks_event' });

    await queryInterface.addColumn('event_sessions', 'track_id', {
      type: Sequelize.BIGINT.UNSIGNED,
      allowNull: true,
      references: { model: 'event_tracks', key: 'id' },
      onUpdate: 'CASCADE',
      // Deleting a track ungroups its sessions rather than deleting them.
      onDelete: 'SET NULL',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('event_sessions', 'track_id');
    await queryInterface.dropTable('event_tracks');
  },
};
