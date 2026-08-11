import { DataTypes } from 'sequelize';

export default function defineIdentity(sequelize) {
  const Department = sequelize.define('Department', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    code: { type: DataTypes.STRING(32), allowNull: false },
    description: { type: DataTypes.STRING(255) },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  }, {
    tableName: 'departments',
    timestamps: true,
    paranoid: true,
    underscored: true,
  });

  const User = sequelize.define('User', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    email: {
      type: DataTypes.STRING(190),
      allowNull: false,
      unique: true,
      set(value) {
        // Normalised on the way in so lookups never need LOWER() and the
        // unique index cannot be defeated by casing.
        this.setDataValue('email', String(value).trim().toLowerCase());
      },
    },
    password_hash: { type: DataTypes.STRING(255), allowNull: false },
    first_name: { type: DataTypes.STRING(80), allowNull: false },
    last_name: { type: DataTypes.STRING(80), allowNull: false },
    // Demographics modelled on what CARISCA collects today. They live on the
    // user rather than the registration so a returning participant does not
    // retype them for every programme.
    prefix: { type: DataTypes.STRING(16) },
    middle_name: { type: DataTypes.STRING(80) },
    suffix: { type: DataTypes.STRING(16) },
    gender: { type: DataTypes.STRING(32) },
    position_id: { type: DataTypes.BIGINT.UNSIGNED },
    sector_id: { type: DataTypes.BIGINT.UNSIGNED },
    city: { type: DataTypes.STRING(120) },
    state_province: { type: DataTypes.STRING(120) },
    email_opt_out: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    email_preference_set_at: { type: DataTypes.DATE(3) },

    phone: { type: DataTypes.STRING(32) },
    country_code: { type: DataTypes.CHAR(2) },
    organization: { type: DataTypes.STRING(160) },
    job_title: { type: DataTypes.STRING(160) },
    timezone: { type: DataTypes.STRING(64) },
    status: {
      type: DataTypes.ENUM('ACTIVE', 'INACTIVE', 'SUSPENDED'),
      allowNull: false,
      defaultValue: 'ACTIVE',
    },
    is_staff: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    department_id: { type: DataTypes.BIGINT.UNSIGNED },
    email_verified_at: { type: DataTypes.DATE(3) },
    last_login_at: { type: DataTypes.DATE(3) },
    token_version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
  }, {
    tableName: 'users',
    timestamps: true,
    paranoid: true,
    underscored: true,
    defaultScope: {
      // The hash is opt-in, so it cannot be serialised into a response by
      // accident. Authentication uses the `withSecrets` scope explicitly.
      attributes: { exclude: ['password_hash'] },
    },
    scopes: {
      withSecrets: { attributes: { include: ['password_hash'] } },
    },
  });

  User.prototype.fullName = function fullName() {
    return `${this.first_name} ${this.last_name}`.trim();
  };

  User.prototype.isActive = function isActive() {
    return this.status === 'ACTIVE' && !this.deleted_at;
  };

  const Role = sequelize.define('Role', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    key: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    description: { type: DataTypes.STRING(255) },
    is_system: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  }, {
    tableName: 'roles',
    timestamps: true,
    paranoid: true,
    underscored: true,
  });

  const Permission = sequelize.define('Permission', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    key: { type: DataTypes.STRING(96), allowNull: false, unique: true },
    module: { type: DataTypes.STRING(48), allowNull: false },
    resource: { type: DataTypes.STRING(48), allowNull: false },
    action: { type: DataTypes.STRING(48), allowNull: false },
    description: { type: DataTypes.STRING(255) },
  }, {
    tableName: 'permissions',
    timestamps: true,
    underscored: true,
  });

  const RefreshToken = sequelize.define('RefreshToken', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    user_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    token_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    family_id: { type: DataTypes.CHAR(26), allowNull: false },
    user_agent: { type: DataTypes.STRING(255) },
    ip: { type: DataTypes.STRING(45) },
    revoked_at: { type: DataTypes.DATE(3) },
    revoked_reason: { type: DataTypes.STRING(64) },
    expires_at: { type: DataTypes.DATE(3), allowNull: false },
  }, {
    tableName: 'refresh_tokens',
    timestamps: true,
    underscored: true,
  });

  RefreshToken.prototype.isUsable = function isUsable() {
    return !this.revoked_at && this.expires_at > new Date();
  };

  const UserToken = sequelize.define('UserToken', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    user_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    type: { type: DataTypes.ENUM('EMAIL_VERIFICATION', 'PASSWORD_RESET'), allowNull: false },
    token_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    consumed_at: { type: DataTypes.DATE(3) },
    expires_at: { type: DataTypes.DATE(3), allowNull: false },
  }, {
    tableName: 'user_tokens',
    timestamps: true,
    underscored: true,
  });

  UserToken.prototype.isUsable = function isUsable() {
    return !this.consumed_at && this.expires_at > new Date();
  };

  /**
   * The join tables are declared explicitly rather than left to Sequelize's
   * implicit through-model. Both carry a NOT NULL `created_at` (we want to know
   * when a grant was made), and `user_roles` additionally carries the scope
   * columns and `granted_by`, none of which an implicit model would populate.
   */
  const UserRole = sequelize.define('UserRole', {
    user_id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    role_id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    scope_type: { type: DataTypes.STRING(32) },
    scope_id: { type: DataTypes.BIGINT.UNSIGNED },
    granted_by: { type: DataTypes.BIGINT.UNSIGNED },
  }, {
    tableName: 'user_roles',
    timestamps: true,
    updatedAt: false,
    createdAt: 'created_at',
    underscored: true,
  });

  const RolePermission = sequelize.define('RolePermission', {
    role_id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    permission_id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
  }, {
    tableName: 'role_permissions',
    timestamps: true,
    updatedAt: false,
    createdAt: 'created_at',
    underscored: true,
  });

  return { Department, User, Role, Permission, RefreshToken, UserToken, UserRole, RolePermission };
}
