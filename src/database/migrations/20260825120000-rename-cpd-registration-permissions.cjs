/* eslint-disable */
'use strict';

/**
 * `cpd.registration.*` was never actually CPD-specific — registration
 * handling is fully generic shared code, and every other piece of shared
 * core (`attendance.*`, `files.*`, `audit.*`, `users.*`) already uses bare,
 * module-agnostic keys. The `cpd.` prefix here was only ever an accident of
 * CPD being the sole module; it stops being harmless the moment a second
 * module (Summit) starts registering people too.
 *
 * This renames the six permission ROWS in place rather than deleting and
 * re-inserting them. `role_permissions` references `permission_id` (an
 * integer FK), not the key string, so an in-place rename preserves every
 * existing grant with zero re-seeding — `syncPermissions()` only inserts
 * missing keys, it never renames or re-grants, so editing permissions.json
 * alone would silently leave every current grant behind on the old key.
 */
const RENAMES = [
  ['cpd.registration.view', 'registration.view'],
  ['cpd.registration.create', 'registration.create'],
  ['cpd.registration.update', 'registration.update'],
  ['cpd.registration.approve', 'registration.approve'],
  ['cpd.registration.cancel', 'registration.cancel'],
  ['cpd.registration.export', 'registration.export'],
];

module.exports = {
  async up(queryInterface) {
    for (const [from, to] of RENAMES) {
      await queryInterface.sequelize.query(
        'UPDATE permissions SET `key` = ?, module = ? WHERE `key` = ?',
        { replacements: [to, 'core', from] },
      );
    }
  },

  async down(queryInterface) {
    for (const [from, to] of RENAMES) {
      await queryInterface.sequelize.query(
        'UPDATE permissions SET `key` = ?, module = ? WHERE `key` = ?',
        { replacements: [from, 'cpd', to] },
      );
    }
  },
};
