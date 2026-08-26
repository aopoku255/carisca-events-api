import { DataTypes } from 'sequelize';

/**
 * The shared event core. CPD, Summit and Business Forum are all rows here,
 * separated by `event_type_id`; module-specific structure lives in a 1:1
 * extension table such as `cpd_event_details`.
 */
export default function defineEvent(sequelize) {
  const EventType = sequelize.define('EventType', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    key: { type: DataTypes.STRING(48), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    module: { type: DataTypes.STRING(48), allowNull: false },
    description: { type: DataTypes.STRING(255) },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  }, { tableName: 'event_types', timestamps: true, underscored: true });

  const Event = sequelize.define('Event', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    event_type_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    slug: { type: DataTypes.STRING(180), allowNull: false, unique: true },
    title: { type: DataTypes.STRING(255), allowNull: false },
    short_description: { type: DataTypes.STRING(500) },
    description: { type: DataTypes.TEXT },
    banner_file_id: { type: DataTypes.BIGINT.UNSIGNED },

    start_at: { type: DataTypes.DATE(3), allowNull: false },
    end_at: { type: DataTypes.DATE(3), allowNull: false },
    timezone: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'Africa/Accra' },

    delivery_mode: {
      type: DataTypes.ENUM('ONLINE', 'OFFLINE', 'HYBRID'),
      allowNull: false,
      defaultValue: 'OFFLINE',
    },
    country_code: { type: DataTypes.CHAR(2) },
    city: { type: DataTypes.STRING(120) },
    venue: { type: DataTypes.STRING(255) },
    online_url: { type: DataTypes.STRING(500) },

    capacity: { type: DataTypes.INTEGER.UNSIGNED },
    virtual_capacity: { type: DataTypes.INTEGER.UNSIGNED },
    allow_waitlist: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    registration_opens_at: { type: DataTypes.DATE(3) },
    registration_closes_at: { type: DataTypes.DATE(3) },
    payment_hold_hours: { type: DataTypes.INTEGER.UNSIGNED },

    status: {
      type: DataTypes.ENUM(
        'DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'REGISTRATION_OPEN',
        'REGISTRATION_CLOSED', 'ONGOING', 'COMPLETED', 'CANCELLED', 'ARCHIVED',
      ),
      allowNull: false,
      defaultValue: 'DRAFT',
    },
    cancelled_reason: { type: DataTypes.STRING(500) },

    issues_certificate: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    certificate_template_id: { type: DataTypes.BIGINT.UNSIGNED },
    certificate_requires_payment: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    certificate_requires_evaluation: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    attendance_rule: {
      type: DataTypes.ENUM('NONE', 'CHECK_IN', 'SESSION_PERCENT'),
      allowNull: false,
      defaultValue: 'CHECK_IN',
    },
    min_attendance_percent: { type: DataTypes.TINYINT.UNSIGNED },

    organizer_department_id: { type: DataTypes.BIGINT.UNSIGNED },
    contact_email: { type: DataTypes.STRING(190) },
    contact_phone: { type: DataTypes.STRING(32) },
    created_by: { type: DataTypes.BIGINT.UNSIGNED },
    published_at: { type: DataTypes.DATE(3) },
  }, {
    tableName: 'events',
    timestamps: true,
    paranoid: true,
    underscored: true,
  });

  Event.prototype.isOpenForRegistration = function isOpenForRegistration(at = new Date()) {
    if (this.status !== 'REGISTRATION_OPEN') return false;
    if (this.registration_opens_at && this.registration_opens_at > at) return false;
    if (this.registration_closes_at && this.registration_closes_at < at) return false;
    return true;
  };

  /** Capacity is per attendance mode: a hall seats fewer than a webinar. */
  Event.prototype.capacityFor = function capacityFor(mode) {
    return mode === 'VIRTUAL' ? this.virtual_capacity : this.capacity;
  };

  const EventPrice = sequelize.define('EventPrice', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    event_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    tier: { type: DataTypes.STRING(48), allowNull: false, defaultValue: 'standard' },
    label: { type: DataTypes.STRING(120), allowNull: false },
    attendance_mode: {
      type: DataTypes.ENUM('ANY', 'IN_PERSON', 'VIRTUAL'),
      allowNull: false,
      defaultValue: 'ANY',
    },
    audience: {
      type: DataTypes.ENUM('ANY', 'HOST_COUNTRY', 'AFRICA', 'INTERNATIONAL'),
      allowNull: false,
      defaultValue: 'ANY',
    },
    priority: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 100 },
    amount_minor: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    currency: { type: DataTypes.CHAR(3), allowNull: false },
    is_default: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    available_from: { type: DataTypes.DATE(3) },
    available_until: { type: DataTypes.DATE(3) },
  }, {
    tableName: 'event_prices',
    timestamps: true,
    paranoid: true,
    underscored: true,
  });

  const CpdEventDetail = sequelize.define('CpdEventDetail', {
    event_id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    cpd_credits: { type: DataTypes.DECIMAL(5, 2) },
    accrediting_body: { type: DataTypes.STRING(160) },
    learning_objectives: { type: DataTypes.JSON },
    target_audience: { type: DataTypes.JSON },
    requirements: { type: DataTypes.TEXT },
  }, { tableName: 'cpd_event_details', timestamps: true, underscored: true });

  const SummitEventDetail = sequelize.define('SummitEventDetail', {
    event_id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    theme: { type: DataTypes.STRING(255) },
    call_for_papers_opens_at: { type: DataTypes.DATE(3) },
    call_for_papers_closes_at: { type: DataTypes.DATE(3) },
    keynote_count: { type: DataTypes.TINYINT.UNSIGNED },
  }, { tableName: 'summit_event_details', timestamps: true, underscored: true });

  return {
    EventType, Event, EventPrice, CpdEventDetail, SummitEventDetail,
  };
}
