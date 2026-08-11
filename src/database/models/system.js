import { DataTypes } from 'sequelize';

export default function defineSystem(sequelize) {
  const AuditLog = sequelize.define('AuditLog', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    actor_user_id: { type: DataTypes.BIGINT.UNSIGNED },
    actor_email: { type: DataTypes.STRING(190) },
    action: { type: DataTypes.STRING(96), allowNull: false },
    resource_type: { type: DataTypes.STRING(64), allowNull: false },
    resource_id: { type: DataTypes.STRING(64) },
    before: { type: DataTypes.JSON },
    after: { type: DataTypes.JSON },
    metadata: { type: DataTypes.JSON },
    ip: { type: DataTypes.STRING(45) },
    user_agent: { type: DataTypes.STRING(255) },
    request_id: { type: DataTypes.CHAR(26) },
  }, {
    tableName: 'audit_logs',
    // Append-only: created_at is set on insert and there is no updated_at,
    // matching the database triggers that reject UPDATE and DELETE outright.
    timestamps: true,
    updatedAt: false,
    createdAt: 'created_at',
    underscored: true,
  });

  const File = sequelize.define('File', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    storage_provider: {
      type: DataTypes.ENUM('local', 's3', 'gcs'),
      allowNull: false,
      defaultValue: 'local',
    },
    storage_key: { type: DataTypes.STRING(255), allowNull: false, unique: true },
    original_name: { type: DataTypes.STRING(255), allowNull: false },
    mime_type: { type: DataTypes.STRING(128), allowNull: false },
    size_bytes: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    checksum: { type: DataTypes.CHAR(64) },
    visibility: {
      type: DataTypes.ENUM('PUBLIC', 'PRIVATE'),
      allowNull: false,
      defaultValue: 'PRIVATE',
    },
    purpose: { type: DataTypes.STRING(48), allowNull: false, defaultValue: 'GENERAL' },
    uploaded_by: { type: DataTypes.BIGINT.UNSIGNED },
  }, {
    tableName: 'files',
    timestamps: true,
    paranoid: true,
    underscored: true,
  });

  const SystemSetting = sequelize.define('SystemSetting', {
    key: { type: DataTypes.STRING(96), primaryKey: true },
    value: { type: DataTypes.JSON },
    description: { type: DataTypes.STRING(255) },
    is_public: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    updated_by: { type: DataTypes.BIGINT.UNSIGNED },
  }, {
    tableName: 'system_settings',
    timestamps: true,
    underscored: true,
  });

  const Notification = sequelize.define('Notification', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    user_id: { type: DataTypes.BIGINT.UNSIGNED },
    channel: {
      type: DataTypes.ENUM('EMAIL', 'IN_APP', 'SMS'),
      allowNull: false,
      defaultValue: 'IN_APP',
    },
    template: { type: DataTypes.STRING(96), allowNull: false },
    subject: { type: DataTypes.STRING(255) },
    payload: { type: DataTypes.JSON },
    to_address: { type: DataTypes.STRING(255) },
    status: {
      type: DataTypes.ENUM('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED'),
      allowNull: false,
      defaultValue: 'PENDING',
    },
    attempts: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    last_error: { type: DataTypes.TEXT },
    next_attempt_at: { type: DataTypes.DATE(3) },
    sent_at: { type: DataTypes.DATE(3) },
    read_at: { type: DataTypes.DATE(3) },
    resource_type: { type: DataTypes.STRING(64) },
    resource_id: { type: DataTypes.STRING(64) },
  }, {
    tableName: 'notifications',
    timestamps: true,
    underscored: true,
  });

  return { AuditLog, File, SystemSetting, Notification };
}
