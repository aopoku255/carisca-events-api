import { DataTypes } from 'sequelize';

/**
 * Summit-only concepts, kept out of `event.js`: a track groups sessions into
 * a parallel stream, a sponsorship tier groups sponsoring partners into a
 * paid level. Both are per-event configurable lists, the same shape
 * `EventPrice` already uses for registration fees.
 */
export default function defineTrack(sequelize) {
  const EventTrack = sequelize.define('EventTrack', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    event_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    name: { type: DataTypes.STRING(160), allowNull: false },
    description: { type: DataTypes.STRING(500) },
    color: { type: DataTypes.STRING(16) },
    sort_order: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
  }, {
    tableName: 'event_tracks',
    timestamps: true,
    paranoid: true,
    underscored: true,
  });

  const EventSponsorshipTier = sequelize.define('EventSponsorshipTier', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    event_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    name: { type: DataTypes.STRING(80), allowNull: false },
    benefits: { type: DataTypes.TEXT },
    // Informational display fields only — no payment flow attaches to these.
    price_amount_minor: { type: DataTypes.BIGINT.UNSIGNED },
    currency: { type: DataTypes.CHAR(3) },
    sort_order: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
  }, {
    tableName: 'event_sponsorship_tiers',
    timestamps: true,
    paranoid: true,
    underscored: true,
  });

  return { EventTrack, EventSponsorshipTier };
}
