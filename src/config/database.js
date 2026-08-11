import env from './env.js';

/**
 * `timezone: '+00:00'` on the connection is deliberate and load-bearing.
 * All DATETIME columns hold UTC; an event's local wall-clock time is derived
 * from its IANA `timezone` column at display time. Without this the driver
 * silently applies the server's local offset and every event drifts.
 */
const base = {
  dialect: 'mysql',
  host: env.DB_HOST,
  port: env.DB_PORT,
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  timezone: '+00:00',
  dialectOptions: {
    dateStrings: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
    charset: 'utf8mb4',
  },
  define: {
    underscored: true,
    freezeTableName: true,
    charset: 'utf8mb4',
    collate: 'utf8mb4_unicode_ci',
  },
  pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
  logging: env.DB_LOGGING ? (msg) => process.stdout.write(`${msg}\n`) : false,
};

export const config = {
  development: { ...base, database: env.DB_NAME },
  test: { ...base, database: `${env.DB_NAME}_test`, logging: false },
  staging: { ...base, database: env.DB_NAME },
  production: { ...base, database: env.DB_NAME },
};

export default config;
