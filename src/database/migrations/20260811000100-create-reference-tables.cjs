/* eslint-disable */
'use strict';

/**
 * Currencies and countries. These are reference data, not configuration:
 * the decimal exponent lives here so no code ever assumes two decimal places,
 * and no country is special-cased anywhere in the application.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('currencies', {
      code: { type: Sequelize.CHAR(3), primaryKey: true, allowNull: false },
      name: { type: Sequelize.STRING(80), allowNull: false },
      symbol: { type: Sequelize.STRING(8), allowNull: false },
      // Number of digits in the minor unit. GHS/USD = 2, JPY = 0, KWD = 3.
      exponent: { type: Sequelize.TINYINT.UNSIGNED, allowNull: false, defaultValue: 2 },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.createTable('countries', {
      iso2: { type: Sequelize.CHAR(2), primaryKey: true, allowNull: false },
      iso3: { type: Sequelize.CHAR(3), allowNull: false, unique: true },
      name: { type: Sequelize.STRING(120), allowNull: false },
      phone_code: { type: Sequelize.STRING(8), allowNull: false },
      default_currency: {
        type: Sequelize.CHAR(3),
        allowNull: true,
        references: { model: 'currencies', key: 'code' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      default_timezone: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'UTC' },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.addIndex('countries', ['name'], { name: 'idx_countries_name' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('countries');
    await queryInterface.dropTable('currencies');
  },
};
