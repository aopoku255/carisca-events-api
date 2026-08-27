import { DataTypes } from 'sequelize';

/**
 * Money received (or attempted). `Payment` and `PaymentEvent` are the two
 * tables this system actually reads and writes; `PaymentProvider`,
 * `PaymentRoutingRule` and `PaymentRefund` are modelled for completeness with
 * the schema but stay otherwise unused today — there is exactly one provider
 * (Paystack), the Ghana-vs-card channel choice is a plain currency check in
 * `payment.service.js` rather than a DB-driven rule, and refunds were never
 * asked for. See `payment.service.js` for why.
 */
export default function definePayment(sequelize) {
  const PaymentProvider = sequelize.define('PaymentProvider', {
    key: { type: DataTypes.STRING(32), primaryKey: true },
    name: { type: DataTypes.STRING(80), allowNull: false },
    is_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    is_healthy: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    last_health_check_at: { type: DataTypes.DATE(3) },
  }, { tableName: 'payment_providers', timestamps: true, underscored: true });

  const PaymentRoutingRule = sequelize.define('PaymentRoutingRule', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    currency: { type: DataTypes.CHAR(3), allowNull: false },
    country_code: { type: DataTypes.CHAR(2) },
    provider: { type: DataTypes.STRING(32), allowNull: false },
    priority: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 100 },
    is_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  }, { tableName: 'payment_routing_rules', timestamps: true, underscored: true });

  const Payment = sequelize.define('Payment', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    registration_id: { type: DataTypes.BIGINT.UNSIGNED },
    event_id: { type: DataTypes.BIGINT.UNSIGNED },
    user_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    // Ours, generated before the provider is even chosen — the idempotency
    // anchor for the whole transaction, and what we hand Paystack as its own
    // `reference` on initiate so the two never need mapping to each other.
    reference: { type: DataTypes.STRING(48), allowNull: false, unique: true },
    provider: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'paystack' },
    provider_reference: { type: DataTypes.STRING(191) },
    amount_minor: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    currency: { type: DataTypes.CHAR(3), allowNull: false },
    amount_refunded_minor: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    status: {
      type: DataTypes.ENUM(
        'PENDING', 'PROCESSING', 'SUCCESSFUL', 'FAILED',
        'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED',
      ),
      allowNull: false,
      defaultValue: 'PENDING',
    },
    failure_reason: { type: DataTypes.STRING(500) },
    checkout_url: { type: DataTypes.STRING(1000) },
    paid_at: { type: DataTypes.DATE(3) },
    last_verified_at: { type: DataTypes.DATE(3) },
    provider_metadata: { type: DataTypes.JSON },
  }, { tableName: 'payments', timestamps: true, underscored: true });

  const PaymentEvent = sequelize.define('PaymentEvent', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    payment_id: { type: DataTypes.BIGINT.UNSIGNED },
    provider: { type: DataTypes.STRING(32), allowNull: false },
    // The dedupe key. A webhook replay fails this unique insert and is
    // acknowledged without being processed a second time.
    provider_event_id: { type: DataTypes.STRING(191), allowNull: false, unique: true },
    event_type: { type: DataTypes.STRING(96), allowNull: false },
    raw_payload: { type: DataTypes.JSON },
    signature_valid: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    processing_status: {
      type: DataTypes.ENUM('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED'),
      allowNull: false,
      defaultValue: 'RECEIVED',
    },
    processing_error: { type: DataTypes.TEXT },
    attempts: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    received_at: { type: DataTypes.DATE(3), allowNull: false },
    processed_at: { type: DataTypes.DATE(3) },
  }, { tableName: 'payment_events', timestamps: true, underscored: true });

  const PaymentRefund = sequelize.define('PaymentRefund', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    payment_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    amount_minor: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    status: {
      type: DataTypes.ENUM('PENDING', 'SUCCESSFUL', 'FAILED'),
      allowNull: false,
      defaultValue: 'PENDING',
    },
    reason: { type: DataTypes.STRING(500) },
    provider_refund_id: { type: DataTypes.STRING(191) },
    requested_by: { type: DataTypes.BIGINT.UNSIGNED },
    completed_at: { type: DataTypes.DATE(3) },
  }, { tableName: 'payment_refunds', timestamps: true, underscored: true });

  return {
    Payment, PaymentEvent, PaymentProvider, PaymentRoutingRule, PaymentRefund,
  };
}
