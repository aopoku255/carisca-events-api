import { DataTypes } from 'sequelize';

export default function definePartner(sequelize) {
  const Partner = sequelize.define('Partner', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(180), allowNull: false },
    slug: { type: DataTypes.STRING(200), allowNull: false, unique: true },
    // For crowded logo rows where the full legal name will not fit.
    short_name: { type: DataTypes.STRING(80) },
    description: { type: DataTypes.STRING(1000) },
    website_url: { type: DataTypes.STRING(500) },
    logo_file_id: { type: DataTypes.BIGINT.UNSIGNED },
    country_code: { type: DataTypes.CHAR(2) },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_by: { type: DataTypes.BIGINT.UNSIGNED },
  }, {
    tableName: 'partners',
    timestamps: true,
    paranoid: true,
    underscored: true,
  });

  const EventPartner = sequelize.define('EventPartner', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    event_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    partner_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    /**
     * The relationship belongs to the pairing, not the partner: the same
     * institution may host one event and merely sponsor the next.
     */
    role: {
      type: DataTypes.ENUM('PARTNER', 'SPONSOR', 'HOST', 'FUNDER', 'ACCREDITOR', 'SUPPORTER'),
      allowNull: false,
      defaultValue: 'PARTNER',
    },
    sort_order: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    // Set only when role is SPONSOR and the event has sponsorship tiers —
    // an ordinary sponsor with no tier is still perfectly valid.
    sponsorship_tier_id: { type: DataTypes.BIGINT.UNSIGNED },
  }, {
    tableName: 'event_partners',
    timestamps: true,
    underscored: true,
  });

  return { Partner, EventPartner };
}
