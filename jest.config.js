export default {
  testEnvironment: 'node',
  // Integration tests share one MySQL database, so they must not run in
  // parallel. `npm test` passes --runInBand for the same reason.
  maxWorkers: 1,
  testMatch: ['**/tests/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/helpers/env.js'],
  globalSetup: '<rootDir>/tests/helpers/global-setup.js',
  transform: {},
  verbose: true,
  testTimeout: 30_000,
  collectCoverageFrom: ['src/**/*.js', '!src/database/migrations/**', '!src/database/seeders/**'],
};
