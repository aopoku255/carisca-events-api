/* eslint-disable */
'use strict';

/**
 * `is_active` on `event_types` is not read anywhere in application code
 * today — it is purely a signal for whoever's looking at the data — but the
 * seeder (the source of truth for a fresh install) now says Summit is
 * active. Seeders do not re-run against an already-seeded database, so this
 * flips the row directly for every environment that was seeded before this
 * change, the same reasoning as the permission rename migration: don't let
 * the seed file and the live data quietly disagree.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      "UPDATE event_types SET is_active = true WHERE `key` = 'summit'",
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      "UPDATE event_types SET is_active = false WHERE `key` = 'summit'",
    );
  },
};
