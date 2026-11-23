/* eslint-disable */
'use strict';

/**
 * A Distinguished Lecture Series runs through the CPD module (same fees,
 * questions, certificates), but is its own kind of programme on the public
 * site. Its own event type is what puts "Distinguished Lecture Series", rather
 * than "Continuing Professional Development", on the event and its card.
 */
module.exports = {
  async up(queryInterface) {
    const [existing] = await queryInterface.sequelize.query(
      "SELECT id FROM event_types WHERE `key` = 'dls' LIMIT 1",
    );
    if (existing.length) return;

    const now = new Date();
    await queryInterface.bulkInsert('event_types', [{
      key: 'dls',
      name: 'Distinguished Lecture Series',
      module: 'cpd',
      description: 'Distinguished Lecture Series events, run through the CPD module',
      is_active: true,
      created_at: now,
      updated_at: now,
    }]);
  },

  async down(queryInterface) {
    // Only removable while nothing uses it.
    await queryInterface.sequelize.query(
      "DELETE FROM event_types WHERE `key` = 'dls' AND id NOT IN (SELECT event_type_id FROM events)",
    );
  },
};
