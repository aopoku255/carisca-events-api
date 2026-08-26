import { DataTypes } from 'sequelize';

export default function defineRegistration(sequelize) {
  const EventSession = sequelize.define('EventSession', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    event_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    title: { type: DataTypes.STRING(255), allowNull: false },
    description: { type: DataTypes.TEXT },
    start_at: { type: DataTypes.DATE(3), allowNull: false },
    end_at: { type: DataTypes.DATE(3), allowNull: false },
    location: { type: DataTypes.STRING(255) },
    is_required_for_attendance: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sort_order: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    // Which parallel stream this session belongs to. Nullable and unused by
    // CPD, whose agenda is one linear list — set only on a Summit session.
    track_id: { type: DataTypes.BIGINT.UNSIGNED },
  }, { tableName: 'event_sessions', timestamps: true, paranoid: true, underscored: true });

  const EventSpeaker = sequelize.define('EventSpeaker', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    event_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    name: { type: DataTypes.STRING(160), allowNull: false },
    title: { type: DataTypes.STRING(160) },
    organization: { type: DataTypes.STRING(160) },
    bio: { type: DataTypes.TEXT },
    photo_file_id: { type: DataTypes.BIGINT.UNSIGNED },
    role: {
      type: DataTypes.ENUM('SPEAKER', 'FACILITATOR', 'MODERATOR', 'PANELLIST'),
      allowNull: false,
      defaultValue: 'SPEAKER',
    },
    sort_order: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
  }, { tableName: 'event_speakers', timestamps: true, paranoid: true, underscored: true });

  const RegistrationQuestion = sequelize.define('RegistrationQuestion', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    event_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    label: { type: DataTypes.STRING(255), allowNull: false },
    help_text: { type: DataTypes.STRING(500) },
    type: {
      type: DataTypes.ENUM(
        'TEXT', 'LONGTEXT', 'NUMBER', 'EMAIL', 'PHONE',
        'SELECT', 'MULTISELECT', 'RADIO', 'CHECKBOX', 'DATE', 'FILE',
      ),
      allowNull: false,
      defaultValue: 'TEXT',
    },
    options: { type: DataTypes.JSON },
    is_required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    sort_order: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
  }, { tableName: 'registration_questions', timestamps: true, paranoid: true, underscored: true });

  const Registration = sequelize.define('Registration', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    event_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    user_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    reference: { type: DataTypes.STRING(48), allowNull: false, unique: true },
    qr_token: { type: DataTypes.CHAR(32), allowNull: false, unique: true },

    status: {
      type: DataTypes.ENUM(
        'PENDING_PAYMENT', 'CONFIRMED', 'WAITLISTED', 'CANCELLED', 'REFUNDED', 'REQUIRES_REVIEW',
      ),
      allowNull: false,
      defaultValue: 'PENDING_PAYMENT',
    },
    attendance_mode: {
      type: DataTypes.ENUM('IN_PERSON', 'VIRTUAL'),
      allowNull: false,
      defaultValue: 'IN_PERSON',
    },
    hold_expires_at: { type: DataTypes.DATE(3) },

    price_amount_minor: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    currency: { type: DataTypes.CHAR(3) },
    price_tier: { type: DataTypes.STRING(48) },

    // Set once, on the first waiver, and never touched again — see the
    // migration for why. NULL means this registration has never been waived.
    original_price_amount_minor: { type: DataTypes.BIGINT.UNSIGNED },
    waiver_reason: { type: DataTypes.STRING(500) },
    waived_at: { type: DataTypes.DATE(3) },
    waived_by: { type: DataTypes.BIGINT.UNSIGNED },

    profile_snapshot: { type: DataTypes.JSON },
    special_requirements: { type: DataTypes.STRING(1000) },
    comments: { type: DataTypes.TEXT },
    wants_certificate: { type: DataTypes.BOOLEAN },
    is_previous_attendee: { type: DataTypes.BOOLEAN },
    media_consent_at: { type: DataTypes.DATE(3) },
    media_consent_ip: { type: DataTypes.STRING(45) },
    evidence_file_id: { type: DataTypes.BIGINT.UNSIGNED },

    confirmed_at: { type: DataTypes.DATE(3) },
    cancelled_at: { type: DataTypes.DATE(3) },
    cancellation_reason: { type: DataTypes.STRING(500) },
    review_reason: { type: DataTypes.STRING(500) },
  }, {
    tableName: 'registrations',
    timestamps: true,
    paranoid: true,
    underscored: true,
    defaultScope: {
      // The QR token is a bearer credential for check-in. It is opt-in so it
      // cannot be serialised into a list response by accident.
      attributes: { exclude: ['qr_token'] },
    },
    scopes: {
      withQr: { attributes: { include: ['qr_token'] } },
    },
  });

  /** Statuses that occupy a seat: confirmed, or holding one while paying. */
  Registration.OCCUPYING = ['CONFIRMED', 'PENDING_PAYMENT', 'REQUIRES_REVIEW'];

  Registration.prototype.isPaid = function isPaid() {
    return Number(this.price_amount_minor) === 0 || this.status === 'CONFIRMED';
  };

  Registration.prototype.holdHasLapsed = function holdHasLapsed(at = new Date()) {
    return this.status === 'PENDING_PAYMENT'
      && !!this.hold_expires_at
      && this.hold_expires_at < at;
  };

  const RegistrationAnswer = sequelize.define('RegistrationAnswer', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    registration_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    question_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    value: { type: DataTypes.TEXT },
    file_id: { type: DataTypes.BIGINT.UNSIGNED },
  }, { tableName: 'registration_answers', timestamps: true, underscored: true });

  const RegistrationStatusHistory = sequelize.define('RegistrationStatusHistory', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    registration_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    from_status: { type: DataTypes.STRING(32) },
    to_status: { type: DataTypes.STRING(32), allowNull: false },
    reason: { type: DataTypes.STRING(500) },
    changed_by: { type: DataTypes.BIGINT.UNSIGNED },
  }, {
    tableName: 'registration_status_history',
    timestamps: true,
    updatedAt: false,
    createdAt: 'created_at',
    underscored: true,
  });

  const AttendanceRecord = sequelize.define('AttendanceRecord', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    registration_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    // NULL means the event as a whole rather than a particular session.
    session_id: { type: DataTypes.BIGINT.UNSIGNED },
    status: {
      type: DataTypes.ENUM('REGISTERED', 'CHECKED_IN', 'ATTENDED', 'ABSENT'),
      allowNull: false,
      defaultValue: 'CHECKED_IN',
    },
    check_in_at: { type: DataTypes.DATE(3) },
    check_out_at: { type: DataTypes.DATE(3) },
    method: {
      type: DataTypes.ENUM('QR', 'MANUAL', 'IMPORT', 'SELF'),
      allowNull: false,
      defaultValue: 'QR',
    },
    recorded_by: { type: DataTypes.BIGINT.UNSIGNED },
    device_info: { type: DataTypes.STRING(255) },
    notes: { type: DataTypes.STRING(500) },
  }, {
    tableName: 'attendance_records',
    timestamps: true,
    underscored: true,
    // session_key is a generated column backing the unique constraint; the
    // database maintains it and writing to it would error.
    defaultScope: { attributes: { exclude: ['session_key'] } },
  });

  return {
    EventSession, EventSpeaker, RegistrationQuestion,
    Registration, RegistrationAnswer, RegistrationStatusHistory,
    AttendanceRecord,
  };
}
