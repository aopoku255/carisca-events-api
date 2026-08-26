import { DataTypes } from 'sequelize';

/**
 * A record that a certificate was issued — one per registration, enforced by
 * the database (`UNIQUE(registration_id)`). `issued_snapshot` freezes the
 * participant/event facts at issue time so editing the event later can never
 * change what an already-issued certificate says. Revocation sets `status`
 * rather than deleting the row: the whole point of public verification is
 * being able to say "this was issued, and later withdrawn," not to make the
 * record disappear.
 */
export default function defineCertificate(sequelize) {
  const Certificate = sequelize.define('Certificate', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    registration_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, unique: true },
    event_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    user_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    // e.g. CARISCA-CPD-2026-000123-K4F9 — what the QR code on the
    // certificate encodes and a verifier types in by hand if scanning fails.
    verification_code: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    issued_snapshot: { type: DataTypes.JSON, allowNull: false },
    status: {
      type: DataTypes.ENUM('PENDING', 'GENERATING', 'ISSUED', 'FAILED', 'REVOKED'),
      allowNull: false,
      defaultValue: 'PENDING',
    },
    issued_at: { type: DataTypes.DATE(3) },
    revoked_at: { type: DataTypes.DATE(3) },
    revoked_reason: { type: DataTypes.STRING(500) },
    revoked_by: { type: DataTypes.BIGINT.UNSIGNED },
    download_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    last_downloaded_at: { type: DataTypes.DATE(3) },
  }, {
    tableName: 'certificates',
    timestamps: true,
    underscored: true,
  });

  return { Certificate };
}
