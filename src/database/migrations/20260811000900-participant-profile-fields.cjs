/* eslint-disable */
'use strict';

/**
 * Participant demographics, modelled from the fields CARISCA actually collects
 * on cpd.carisca.org.
 *
 * Two deliberate choices:
 *
 *   Position and Sector are reference TABLES, not ENUMs. They are M&E
 *   taxonomies that will grow — a new sector must not require a migration and
 *   a deploy, and reporting needs to group by them.
 *
 *   These live on `users`, not on `registrations`. They are stable attributes
 *   of a person, so a returning participant does not retype them for every
 *   programme. The registration still snapshots them at the time it is made.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const ts = new Date();

    await queryInterface.createTable('positions', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      key: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      label: { type: Sequelize.STRING(120), allowNull: false },
      // Drives the conditional "upload your student ID" field, so the rule is
      // data rather than a hard-coded check for the word "student".
      requires_student_id: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      sort_order: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.createTable('sectors', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      key: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      label: { type: Sequelize.STRING(120), allowNull: false },
      sort_order: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    /**
     * Continent is derived from the country rather than asked separately.
     * The live form asks for both, which lets a participant tell you they are
     * in Ghana, Europe. One source of truth removes a whole class of dirty
     * data from the M&E reports.
     */
    await queryInterface.addColumn('countries', 'region', {
      type: Sequelize.ENUM('Africa', 'Asia', 'Europe', 'North America', 'South America', 'Oceania', 'Antarctica'),
      allowNull: true,
      after: 'name',
    });
    // Used by price resolution: Africa vs the rest is a pricing boundary.
    await queryInterface.addIndex('countries', ['region'], { name: 'idx_countries_region' });

    const cols = {
      prefix: { type: Sequelize.STRING(16), allowNull: true },
      middle_name: { type: Sequelize.STRING(80), allowNull: true },
      suffix: { type: Sequelize.STRING(16), allowNull: true },
      // Free text against a suggested list rather than an ENUM: adding
      // "Prefer not to say" must never need a schema change.
      gender: { type: Sequelize.STRING(32), allowNull: true },
      position_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'positions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      sector_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'sectors', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      city: { type: Sequelize.STRING(120), allowNull: true },
      state_province: { type: Sequelize.STRING(120), allowNull: true },
      // Opt-out rather than opt-in mirrors the live form. Stored with a
      // timestamp so the choice is evidenced, not merely a boolean.
      email_opt_out: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      email_preference_set_at: { type: Sequelize.DATE(3), allowNull: true },
    };

    for (const [name, spec] of Object.entries(cols)) {
      await queryInterface.addColumn('users', name, spec);
    }

    await queryInterface.addIndex('users', ['position_id'], { name: 'idx_users_position' });
    await queryInterface.addIndex('users', ['sector_id'], { name: 'idx_users_sector' });
  },

  async down(queryInterface) {
    for (const name of [
      'email_preference_set_at', 'email_opt_out', 'state_province', 'city',
      'sector_id', 'position_id', 'gender', 'suffix', 'middle_name', 'prefix',
    ]) {
      await queryInterface.removeColumn('users', name);
    }
    await queryInterface.removeIndex('countries', 'idx_countries_region');
    await queryInterface.removeColumn('countries', 'region');
    await queryInterface.dropTable('sectors');
    await queryInterface.dropTable('positions');
  },
};
