import { Sequelize } from 'sequelize';
import config from '../../config/database.js';
import env from '../../config/env.js';
import { logger } from '../../lib/logger.js';

import defineReference from './reference.js';
import defineIdentity from './identity.js';
import defineSystem from './system.js';

export const sequelize = new Sequelize(config[env.NODE_ENV]);

/**
 * Models are registered by domain rather than by file-per-model auto-loading,
 * so the association graph is written down in one readable place instead of
 * being scattered across thirty files.
 *
 * Event, registration, payment, attendance and certificate models are added
 * here as their modules are built.
 */
const registry = {};
Object.assign(registry, defineReference(sequelize));
Object.assign(registry, defineIdentity(sequelize));
Object.assign(registry, defineSystem(sequelize));

// --- associations ----------------------------------------------------------
const {
  Country, Currency,
  Department, User, Role, Permission, RefreshToken, UserToken, UserRole, RolePermission,
  AuditLog, File, SystemSetting,
} = registry;

Currency.hasMany(Country, { foreignKey: 'default_currency', as: 'countries' });
Country.belongsTo(Currency, { foreignKey: 'default_currency', as: 'currency' });

Department.hasMany(User, { foreignKey: 'department_id', as: 'members' });
User.belongsTo(Department, { foreignKey: 'department_id', as: 'department' });
User.belongsTo(Country, { foreignKey: 'country_code', as: 'country' });

User.belongsToMany(Role, {
  through: UserRole, foreignKey: 'user_id', otherKey: 'role_id', as: 'roles',
});
Role.belongsToMany(User, {
  through: UserRole, foreignKey: 'role_id', otherKey: 'user_id', as: 'users',
});

Role.belongsToMany(Permission, {
  through: RolePermission, foreignKey: 'role_id', otherKey: 'permission_id', as: 'permissions',
});
Permission.belongsToMany(Role, {
  through: RolePermission, foreignKey: 'permission_id', otherKey: 'role_id', as: 'roles',
});

User.hasMany(RefreshToken, { foreignKey: 'user_id', as: 'refreshTokens' });
RefreshToken.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

User.hasMany(UserToken, { foreignKey: 'user_id', as: 'tokens' });
UserToken.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

AuditLog.belongsTo(User, { foreignKey: 'actor_user_id', as: 'actor' });
File.belongsTo(User, { foreignKey: 'uploaded_by', as: 'uploader' });
SystemSetting.belongsTo(User, { foreignKey: 'updated_by', as: 'updatedBy' });

export const models = registry;
export const {
  Country: CountryModel,
} = registry;

export async function connect() {
  await sequelize.authenticate();
  logger.info({ database: config[env.NODE_ENV].database }, 'database connected');
  return sequelize;
}

export async function disconnect() {
  await sequelize.close();
}

export default { sequelize, models, connect, disconnect };
