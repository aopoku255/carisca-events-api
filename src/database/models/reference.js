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
    phone_code: { type: DataTypes.STRING(8), allowNull: false },
    default_currency: { type: DataTypes.CHAR(3) },
    default_timezone: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'UTC' },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  }, {
    tableName: 'countries',
    timestamps: true,
    underscored: true,
  });

  return { Currency, Country };
}
