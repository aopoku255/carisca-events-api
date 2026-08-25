/* eslint-disable */
'use strict';

/**
 * Lets an administrator reduce or zero a registration's fee after it has
 * already been quoted — a sponsor covering someone's place, a hardship case,
 * a speaker who should not have to pay to attend their own session.
 *
 * `price_amount_minor` remains the one number everything else reads (capacity,
 * `isPaid()`, the CSV export, the certificate-payment gate) — a waiver
 * overwrites it directly rather than introducing a second "real" amount that
 * every one of those call sites would need to learn about. What is added here
 * is purely the record of *that a waiver happened*: the amount before it, who
 * granted it, when, and why. `original_price_amount_minor` is set once, on
 * the first waiver, and left alone after — so if an amount is waived twice
 * (say, first to a reduced rate, then to free) it still remembers what the
 * participant was quoted at registration, not just the last adjustment.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('registrations', 'original_price_amount_minor', {
      type: Sequelize.BIGINT.UNSIGNED,
      allowNull: true,
    });
    await queryInterface.addColumn('registrations', 'waiver_reason', {
      type: Sequelize.STRING(500),
      allowNull: true,
    });
    await queryInterface.addColumn('registrations', 'waived_at', {
      type: Sequelize.DATE(3),
      allowNull: true,
    });
    await queryInterface.addColumn('registrations', 'waived_by', {
      type: Sequelize.BIGINT.UNSIGNED,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('registrations', 'waived_by');
    await queryInterface.removeColumn('registrations', 'waived_at');
    await queryInterface.removeColumn('registrations', 'waiver_reason');
    await queryInterface.removeColumn('registrations', 'original_price_amount_minor');
  },
};
