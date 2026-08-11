import { DataTypes } from 'sequelize';

export default function defineReference(sequelize) {
  const Currency = sequelize.define('Currency', {
    code: { type: DataTypes.CHAR(3), primaryKey: true },
    name: { type: DataTypes.STRING(80), allowNull: false },
    symbol: { type: DataTypes.STRING(8), allowNull: false },
    exponent: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 2 },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  }, {
    tableName: 'currencies',
    timestamps: true,
    underscored: true,
  });

  const Country = sequelize.define('Country', {
    iso2: { type: DataTypes.CHAR(2), primaryKey: true },
    iso3: { type: DataTypes.CHAR(3), allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    // Derived, never asked for separately — see the profile-fields migration.
    region: {
      type: DataTypes.ENUM('Africa', 'Asia', 'Europe', 'North America', 'South America', 'Oceania', 'Antarctica'),
    },
    phone_code: { type: DataTypes.STRING(8), allowNull: false },
    default_currency: { type: DataTypes.CHAR(3) },
    default_timezone: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'UTC' },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  }, {
    tableName: 'countries',
    timestamps: true,
    underscored: true,
  });

  /**
   * Position and sector are M&E taxonomies rather than free text, so cohorts
   * stay comparable across programmes. Tables rather than ENUMs so the M&E
   * team can add a category without a migration.
   */
  const Position = sequelize.define('Position', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    key: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    label: { type: DataTypes.STRING(120), allowNull: false },
    requires_student_id: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    sort_order: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  }, { tableName: 'positions', timestamps: true, underscored: true });

  const Sector = sequelize.define('Sector', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    key: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    label: { type: DataTypes.STRING(120), allowNull: false },
    sort_order: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  }, { tableName: 'sectors', timestamps: true, underscored: true });

  return { Currency, Country, Position, Sector };
}
