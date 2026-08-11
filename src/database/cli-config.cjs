/* eslint-disable */
// CommonJS mirror of src/config/database.js for sequelize-cli.
// Keep the two in sync; the runtime uses the ESM version.
require('dotenv').config();

const base = {
  dialect: 'mysql',
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  username: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  timezone: '+00:00',
  dialectOptions: { charset: 'utf8mb4', supportBigNumbers: true },
  define: {
    underscored: true,
    freezeTableName: true,
    charset: 'utf8mb4',
    collate: 'utf8mb4_unicode_ci',
  },
  logging: process.env.DB_LOGGING === 'true' ? console.log : false,
};

const name = process.env.DB_NAME || 'carisca_dev';

module.exports = {
  development: { ...base, database: name },
  test: { ...base, database: `${name}_test` },
  staging: { ...base, database: name },
  production: { ...base, database: name },
};
