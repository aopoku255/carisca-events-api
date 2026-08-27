/* eslint-disable */
'use strict';

/**
 * `20260811010300-platform.cjs` inserted 'CARISCA Standard Certificate' with
 * no existence check and no unique constraint on `name` to fall back on —
 * every environment that ran `db:seed:all` more than once (every redeploy
 * that re-runs the migrate step, since Sequelize only tracks a seeder by
 * filename and content edits to an already-run one — the fix landing
 * alongside this migration — never re-execute it) picked up one more
 * duplicate row each time. Same lesson as the RBAC resync migration: fixing
 * the seeder only helps a brand-new environment, an already-seeded one
 * needs a migration.
 *
 * Keeps the lowest id (oldest row) and deletes the rest — none of them ever
 * had a signatory or signature image set, so nothing meaningful is lost.
 * Also drops the `certificate.signatories` system setting, whose own
 * comment referenced a `CertificateEligibilityService` gate that was never
 * built — the real version of that idea is what this feature replaces it
 * with.
 */
module.exports = {
  async up(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      "SELECT id FROM certificate_templates WHERE name = 'CARISCA Standard Certificate' ORDER BY id ASC",
    );
    if (rows.length > 1) {
      const keep = rows[0].id;
      const dropIds = rows.slice(1).map((r) => r.id);
      await queryInterface.sequelize.query(
        'DELETE FROM certificate_templates WHERE id IN (:dropIds)',
        { replacements: { dropIds } },
      );
      // eslint-disable-next-line no-console
      console.log(`  Removed ${dropIds.length} duplicate "CARISCA Standard Certificate" row(s), kept id ${keep}.`);
    }

    await queryInterface.bulkDelete('system_settings', { key: 'certificate.signatories' });
  },

  async down() {
    // No-op: re-creating duplicate rows on purpose makes no sense.
  },
};
