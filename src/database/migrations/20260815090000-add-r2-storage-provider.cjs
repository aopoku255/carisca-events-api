'use strict';

/**
 * Adds 'r2' and 'gdrive' to files.storage_provider.
 *
 * The column was written as an ENUM of the providers imagined at the time, so
 * adding a driver in code was not enough — the insert failed with "Data
 * truncated for column 'storage_provider'", which is MySQL's way of saying the
 * value is not in the enum.
 *
 * The enum is kept rather than widened to a VARCHAR on purpose: a typo in
 * STORAGE_DRIVER should fail loudly at the first upload, not quietly record a
 * provider nothing can read back.
 */

const BEFORE = "ENUM('local', 's3', 'gcs')";
const AFTER = "ENUM('local', 's3', 'gcs', 'r2', 'gdrive')";

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE files MODIFY COLUMN storage_provider ${AFTER} NOT NULL DEFAULT 'local'`,
    );
  },

  async down(queryInterface) {
    // Rows on a removed provider would become unreadable, so refuse rather
    // than silently truncate them back to 'local' and orphan the objects.
    const [rows] = await queryInterface.sequelize.query(
      "SELECT COUNT(*) AS count FROM files WHERE storage_provider IN ('r2', 'gdrive')",
    );

    if (Number(rows[0].count) > 0) {
      throw new Error(
        `Cannot roll back: ${rows[0].count} file(s) are stored on r2 or gdrive. `
        + 'Migrate them to a remaining provider first.',
      );
    }

    await queryInterface.sequelize.query(
      `ALTER TABLE files MODIFY COLUMN storage_provider ${BEFORE} NOT NULL DEFAULT 'local'`,
    );
  },
};
