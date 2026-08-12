/* eslint-disable */
'use strict';

/**
 * Partner institutions and organizations.
 *
 * A library rather than a per-event list: CARISCA works with the same
 * universities, ministries and funders repeatedly, so a partner is recorded
 * once with its logo and attached to as many events as it takes part in.
 * Re-uploading the same logo for every CPD would be the obvious shortcut and
 * would leave four slightly different KNUST logos in circulation within a year.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('partners', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      name: { type: Sequelize.STRING(180), allowNull: false },
      slug: { type: Sequelize.STRING(200), allowNull: false, unique: true },
      short_name: { type: Sequelize.STRING(80) },
      description: { type: Sequelize.STRING(1000) },
      website_url: { type: Sequelize.STRING(500) },
      logo_file_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'files', key: 'id' },
        onUpdate: 'CASCADE',
        // Losing a logo must not take the partner with it.
        onDelete: 'SET NULL',
      },
      country_code: {
        type: Sequelize.CHAR(2),
        allowNull: true,
        references: { model: 'countries', key: 'iso2' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
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
      deleted_at: { type: Sequelize.DATE(3) },
    });

    await queryInterface.addIndex('partners', ['name'], { name: 'idx_partners_name' });
    await queryInterface.addIndex('partners', ['is_active'], { name: 'idx_partners_active' });

    /**
     * The join carries the relationship, not the partner: the same institution
     * may host one event and merely sponsor the next.
     */
    await queryInterface.createTable('event_partners', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      event_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'events', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      partner_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'partners', key: 'id' },
        onUpdate: 'CASCADE',
        // Refuse to delete a partner still attached to an event — the alternative
        // is silently rewriting the record of who ran it.
        onDelete: 'RESTRICT',
      },
      role: {
        type: Sequelize.ENUM('PARTNER', 'SPONSOR', 'HOST', 'FUNDER', 'ACCREDITOR', 'SUPPORTER'),
        allowNull: false,
        defaultValue: 'PARTNER',
      },
      sort_order: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    // One row per partner per event; changing their role updates it.
    await queryInterface.addConstraint('event_partners', {
      fields: ['event_id', 'partner_id'],
      type: 'unique',
      name: 'uq_event_partner',
    });
    await queryInterface.addIndex('event_partners', ['partner_id'], { name: 'idx_event_partners_partner' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('event_partners');
    await queryInterface.dropTable('partners');
  },
};
