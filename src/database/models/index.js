import { Sequelize } from 'sequelize';
import config from '../../config/database.js';
import env from '../../config/env.js';
import { logger } from '../../lib/logger.js';

import defineReference from './reference.js';
import defineIdentity from './identity.js';
import defineSystem from './system.js';
import defineEvent from './event.js';
import defineRegistration from './registration.js';
import definePartner from './partner.js';
import defineTrack from './track.js';
import defineAbstract from './abstract.js';
import defineCertificate from './certificate.js';
import definePayment from './payment.js';

export const sequelize = new Sequelize(config[env.NODE_ENV]);

/**
 * Models are registered by domain rather than by file-per-model auto-loading,
 * so the association graph is written down in one readable place instead of
 * being scattered across thirty files.
 *
 * Event and registration models are added here as their modules are built.
 */
const registry = {};
Object.assign(registry, defineReference(sequelize));
Object.assign(registry, defineIdentity(sequelize));
Object.assign(registry, defineSystem(sequelize));
Object.assign(registry, defineEvent(sequelize));
Object.assign(registry, defineRegistration(sequelize));
Object.assign(registry, definePartner(sequelize));
Object.assign(registry, defineTrack(sequelize));
Object.assign(registry, defineAbstract(sequelize));
Object.assign(registry, defineCertificate(sequelize));
Object.assign(registry, definePayment(sequelize));

// --- associations ----------------------------------------------------------
const {
  Country, Currency, Position, Sector,
  Department, User, Role, Permission, RefreshToken, UserToken, UserRole, RolePermission,
  AuditLog, File, SystemSetting,
  EventType, Event, EventPrice, CpdEventDetail, SummitEventDetail,
  EventSession, EventSpeaker, RegistrationQuestion,
  Registration, RegistrationAnswer, RegistrationStatusHistory, AttendanceRecord,
  Partner, EventPartner, EventTrack, EventSponsorshipTier, AbstractSubmission,
  Certificate, CertificateTemplate, Payment, PaymentEvent,
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

User.belongsTo(Position, { foreignKey: 'position_id', as: 'position' });
User.belongsTo(Sector, { foreignKey: 'sector_id', as: 'sector' });

EventType.hasMany(Event, { foreignKey: 'event_type_id', as: 'events' });
Event.belongsTo(EventType, { foreignKey: 'event_type_id', as: 'type' });
Event.belongsTo(Country, { foreignKey: 'country_code', as: 'country' });
Event.belongsTo(Department, { foreignKey: 'organizer_department_id', as: 'organizer' });
Event.hasMany(EventPrice, { foreignKey: 'event_id', as: 'prices' });
EventPrice.belongsTo(Event, { foreignKey: 'event_id', as: 'event' });
EventPrice.belongsTo(Currency, { foreignKey: 'currency', as: 'currencyRef' });
Event.belongsTo(File, { foreignKey: 'banner_file_id', as: 'banner' });
Event.hasOne(CpdEventDetail, { foreignKey: 'event_id', as: 'cpd' });
CpdEventDetail.belongsTo(Event, { foreignKey: 'event_id', as: 'event' });
Event.hasOne(SummitEventDetail, { foreignKey: 'event_id', as: 'summit' });
SummitEventDetail.belongsTo(Event, { foreignKey: 'event_id', as: 'event' });

Event.hasMany(EventTrack, { foreignKey: 'event_id', as: 'tracks' });
EventTrack.belongsTo(Event, { foreignKey: 'event_id', as: 'event' });
Event.hasMany(EventSponsorshipTier, { foreignKey: 'event_id', as: 'sponsorshipTiers' });
EventSponsorshipTier.belongsTo(Event, { foreignKey: 'event_id', as: 'event' });

Event.hasMany(EventSession, { foreignKey: 'event_id', as: 'sessions' });
EventSession.belongsTo(Event, { foreignKey: 'event_id', as: 'event' });
EventSession.belongsTo(EventTrack, { foreignKey: 'track_id', as: 'track' });
EventTrack.hasMany(EventSession, { foreignKey: 'track_id', as: 'sessions' });
Event.hasMany(EventSpeaker, { foreignKey: 'event_id', as: 'speakers' });
EventSpeaker.belongsTo(Event, { foreignKey: 'event_id', as: 'event' });
EventSpeaker.belongsTo(File, { foreignKey: 'photo_file_id', as: 'photo' });

Event.hasMany(RegistrationQuestion, { foreignKey: 'event_id', as: 'questions' });
RegistrationQuestion.belongsTo(Event, { foreignKey: 'event_id', as: 'event' });

/**
 * Registrations point at `events`, never at a module's own table. This is the
 * association that lets Summit and Business Forum reuse the entire
 * registration, payment, attendance and certificate stack unchanged.
 */
Event.hasMany(Registration, { foreignKey: 'event_id', as: 'registrations' });
Registration.belongsTo(Event, { foreignKey: 'event_id', as: 'event' });
User.hasMany(Registration, { foreignKey: 'user_id', as: 'registrations' });
Registration.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
Registration.belongsTo(File, { foreignKey: 'evidence_file_id', as: 'evidence' });
Registration.belongsTo(User, { foreignKey: 'waived_by', as: 'waivedByUser' });

Registration.hasMany(RegistrationAnswer, { foreignKey: 'registration_id', as: 'answers' });
RegistrationAnswer.belongsTo(Registration, { foreignKey: 'registration_id', as: 'registration' });
RegistrationAnswer.belongsTo(RegistrationQuestion, { foreignKey: 'question_id', as: 'question' });
RegistrationQuestion.hasMany(RegistrationAnswer, { foreignKey: 'question_id', as: 'answers' });

Registration.hasMany(RegistrationStatusHistory, { foreignKey: 'registration_id', as: 'history' });
RegistrationStatusHistory.belongsTo(Registration, { foreignKey: 'registration_id', as: 'registration' });
RegistrationStatusHistory.belongsTo(User, { foreignKey: 'changed_by', as: 'changedBy' });

Registration.hasMany(AttendanceRecord, { foreignKey: 'registration_id', as: 'attendance' });
AttendanceRecord.belongsTo(Registration, { foreignKey: 'registration_id', as: 'registration' });
AttendanceRecord.belongsTo(EventSession, { foreignKey: 'session_id', as: 'session' });
AttendanceRecord.belongsTo(User, { foreignKey: 'recorded_by', as: 'recordedBy' });
EventSession.hasMany(AttendanceRecord, { foreignKey: 'session_id', as: 'attendance' });

Partner.belongsTo(File, { foreignKey: 'logo_file_id', as: 'logo' });
Partner.belongsTo(Country, { foreignKey: 'country_code', as: 'country' });

/**
 * Partners attach to `events`, not to a module table, so Summit and Business
 * Forum list their partners through the same association.
 */
Event.belongsToMany(Partner, {
  through: EventPartner, foreignKey: 'event_id', otherKey: 'partner_id', as: 'partners',
});
Partner.belongsToMany(Event, {
  through: EventPartner, foreignKey: 'partner_id', otherKey: 'event_id', as: 'events',
});
EventPartner.belongsTo(Partner, { foreignKey: 'partner_id', as: 'partner' });
EventPartner.belongsTo(Event, { foreignKey: 'event_id', as: 'event' });
EventPartner.belongsTo(EventSponsorshipTier, { foreignKey: 'sponsorship_tier_id', as: 'sponsorshipTier' });
EventSponsorshipTier.hasMany(EventPartner, { foreignKey: 'sponsorship_tier_id', as: 'sponsors' });

/**
 * A submission belongs to the event and to its author by ownership — the
 * same shape `Registration` uses, which is what lets a participant read and
 * edit their own submissions without holding any permission at all.
 */
Event.hasMany(AbstractSubmission, { foreignKey: 'event_id', as: 'abstracts' });
AbstractSubmission.belongsTo(Event, { foreignKey: 'event_id', as: 'event' });
User.hasMany(AbstractSubmission, { foreignKey: 'user_id', as: 'abstracts' });
AbstractSubmission.belongsTo(User, { foreignKey: 'user_id', as: 'author' });
AbstractSubmission.belongsTo(EventTrack, { foreignKey: 'track_id', as: 'track' });
AbstractSubmission.belongsTo(File, { foreignKey: 'paper_file_id', as: 'paper' });
AbstractSubmission.belongsTo(User, { foreignKey: 'decided_by', as: 'decidedBy' });

/**
 * One certificate per registration — same ownership shape as attendance,
 * reached the same way (through `registrations`, never through a module's
 * own table).
 */
Registration.hasOne(Certificate, { foreignKey: 'registration_id', as: 'certificate' });
Certificate.belongsTo(Registration, { foreignKey: 'registration_id', as: 'registration' });
Certificate.belongsTo(Event, { foreignKey: 'event_id', as: 'event' });
Certificate.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
Certificate.belongsTo(User, { foreignKey: 'revoked_by', as: 'revokedBy' });

/**
 * A template is opt-in per event — `certificate_template_id` is nullable,
 * and `SET NULL` on delete (already on the FK) means removing a template in
 * use falls that event back to the default baked-in signature rather than
 * breaking it.
 */
Event.belongsTo(CertificateTemplate, { foreignKey: 'certificate_template_id', as: 'certificateTemplate' });
CertificateTemplate.hasMany(Event, { foreignKey: 'certificate_template_id', as: 'events' });
CertificateTemplate.belongsTo(File, { foreignKey: 'signature_file_id', as: 'signatureFile' });
CertificateTemplate.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });

/**
 * A registration can carry more than one payment row across retries (a
 * failed mobile-money attempt, then a successful card one) — unlike
 * `Certificate`, this is `hasMany`, not `hasOne`.
 */
Registration.hasMany(Payment, { foreignKey: 'registration_id', as: 'payments' });
Payment.belongsTo(Registration, { foreignKey: 'registration_id', as: 'registration' });
Payment.belongsTo(Event, { foreignKey: 'event_id', as: 'event' });
Payment.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
Payment.hasMany(PaymentEvent, { foreignKey: 'payment_id', as: 'events' });
PaymentEvent.belongsTo(Payment, { foreignKey: 'payment_id', as: 'payment' });

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
