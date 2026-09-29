/* eslint-disable */
'use strict';

/**
 * payments.provider and payment_events.provider are foreign keys into
 * payment_providers, so OGateway (Nigerian bank transfers) needs its own row
 * before a payment can be recorded against it. Seeders don't re-run on an
 * existing database, hence a migration.
 */
module.exports = {
  async up(queryInterface) {
    const now = new Date();
    await queryInterface.bulkInsert('payment_providers', [
      { key: 'ogateway', name: 'OGateway', is_enabled: true, is_healthy: true, created_at: now, updated_at: now },
    ], { updateOnDuplicate: ['name', 'updated_at'] });
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('payment_providers', { key: 'ogateway' });
  },
};
