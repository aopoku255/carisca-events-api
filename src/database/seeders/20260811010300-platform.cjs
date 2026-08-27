/* eslint-disable */
'use strict';

/**
 * Platform configuration: event types, departments, payment providers and the
 * routing matrix, plus the default certificate template and system settings.
 *
 * The routing rules encode the decisions from the payment architecture: lower
 * priority wins, a NULL country is the fallback for that currency, and nothing
 * about Ghana is special-cased in code — it is just a row here.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const ts = new Date();

    await queryInterface.bulkInsert('event_types', [
      { key: 'cpd', name: 'Continuing Professional Development', module: 'cpd', description: 'CPD programmes and short courses', is_active: true, created_at: ts, updated_at: ts },
      { key: 'summit', name: 'CARISCA Summit', module: 'summit', description: 'Annual supply chain research summit', is_active: true, created_at: ts, updated_at: ts },
      { key: 'business_forum', name: 'Business Forum', module: 'business-forum', description: 'Industry and business forum events', is_active: false, created_at: ts, updated_at: ts },
    ], { updateOnDuplicate: ['name', 'module', 'description', 'updated_at'] });

    await queryInterface.bulkInsert('departments', [
      { name: 'Directorate', code: 'DIR', description: 'Centre leadership', is_active: true, created_at: ts, updated_at: ts },
      { name: 'Programmes', code: 'PROG', description: 'Programme and event management', is_active: true, created_at: ts, updated_at: ts },
      { name: 'Monitoring & Evaluation', code: 'MNE', description: 'Programme metrics and evaluation', is_active: true, created_at: ts, updated_at: ts },
      { name: 'Accounts & Finance', code: 'FIN', description: 'Finance and reconciliation', is_active: true, created_at: ts, updated_at: ts },
      { name: 'Information Technology', code: 'IT', description: 'Systems and technical operations', is_active: true, created_at: ts, updated_at: ts },
      { name: 'Communications', code: 'COMM', description: 'Communications and outreach', is_active: true, created_at: ts, updated_at: ts },
    ], { updateOnDuplicate: ['description', 'is_active', 'updated_at'] });

    await queryInterface.bulkInsert('payment_providers', [
      { key: 'paystack', name: 'Paystack', is_enabled: true, is_healthy: true, created_at: ts, updated_at: ts },
      { key: 'stripe', name: 'Stripe', is_enabled: true, is_healthy: true, created_at: ts, updated_at: ts },
    ], { updateOnDuplicate: ['name', 'updated_at'] });

    // currency, country (null = any), provider, priority
    const ROUTES = [
      ['GHS', 'GH', 'paystack', 10],
      ['GHS', null, 'paystack', 20],
      ['NGN', 'NG', 'paystack', 10],
      ['NGN', null, 'paystack', 20],
      ['ZAR', 'ZA', 'paystack', 10],
      ['ZAR', 'ZA', 'stripe', 20],
      ['ZAR', null, 'stripe', 30],
      ['KES', 'KE', 'paystack', 10],
      ['KES', null, 'stripe', 20],
      // Local cardholders paying in USD route locally first, then fall back.
      ['USD', 'GH', 'paystack', 5],
      ['USD', 'NG', 'paystack', 5],
      ['USD', null, 'stripe', 10],
      // Paystack does not settle these, so Stripe is the only candidate.
      ['GBP', null, 'stripe', 10],
      ['EUR', null, 'stripe', 10],
      ['CAD', null, 'stripe', 10],
      ['AUD', null, 'stripe', 10],
    ];

    await queryInterface.bulkInsert(
      'payment_routing_rules',
      ROUTES.map(([currency, country_code, provider, priority]) => ({
        currency, country_code, provider, priority, is_enabled: true, created_at: ts, updated_at: ts,
      })),
    );

    // No unique constraint on `name` to hang an `updateOnDuplicate` off of
    // (unlike every other insert in this file) — an existence check does the
    // same job. Without it, this row silently duplicated on every re-seed.
    //
    // `layout`/`orientation`/`background_file_id` are legacy of an earlier,
    // much larger "custom certificate builder" design that was never built —
    // left NULL/default here on purpose. What a template actually carries
    // today is a second-signatory profile (name/title/department/signature
    // image, added in a later migration) applied to CARISCA's one fixed
    // design; see `certificate.template.js`.
    const [existingTemplate] = await queryInterface.sequelize.query(
      "SELECT id FROM certificate_templates WHERE name = 'CARISCA Standard Certificate' LIMIT 1",
    );
    if (!existingTemplate.length) {
      await queryInterface.bulkInsert('certificate_templates', [{
        name: 'CARISCA Standard Certificate',
        description: 'The default template — no second-signatory override until one is filled in.',
        is_default: true,
        is_active: true,
        created_at: ts,
        updated_at: ts,
      }]);
    }

    await queryInterface.bulkInsert('system_settings', [
      { key: 'organisation.name', value: JSON.stringify('CARISCA'), description: 'Display name used on certificates and emails', is_public: true, created_at: ts, updated_at: ts },
      { key: 'organisation.full_name', value: JSON.stringify('Centre for Applied Research and Innovation in Supply Chain-Africa'), description: 'Full legal name', is_public: true, created_at: ts, updated_at: ts },
      { key: 'organisation.tagline', value: JSON.stringify('Strong Supply Chains — Strong Communities'), description: 'Organisation tagline', is_public: true, created_at: ts, updated_at: ts },
      { key: 'organisation.email', value: JSON.stringify('carisca@knust.edu.gh'), description: 'Primary contact address', is_public: true, created_at: ts, updated_at: ts },
      { key: 'organisation.address', value: JSON.stringify('KNUST School of Business, Postgraduate Block E, Kumasi, Ghana'), description: 'Postal address', is_public: true, created_at: ts, updated_at: ts },
      { key: 'platform.default_currency', value: JSON.stringify('GHS'), description: 'Currency proposed when creating an event', is_public: false, created_at: ts, updated_at: ts },
      { key: 'platform.default_timezone', value: JSON.stringify('Africa/Accra'), description: 'Timezone proposed when creating an event', is_public: false, created_at: ts, updated_at: ts },
      { key: 'registration.hold_minutes', value: JSON.stringify(30), description: 'How long a seat is held while a participant pays', is_public: false, created_at: ts, updated_at: ts },
      { key: 'certificate.verification_url', value: JSON.stringify('/verify/certificate'), description: 'Public verification path', is_public: true, created_at: ts, updated_at: ts },
    ], { updateOnDuplicate: ['description', 'is_public', 'updated_at'] });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.bulkDelete('system_settings', null, {});
    await queryInterface.bulkDelete('certificate_templates', null, {});
    await queryInterface.bulkDelete('payment_routing_rules', null, {});
    await queryInterface.bulkDelete('payment_providers', null, {});
    await queryInterface.bulkDelete('departments', null, {});
    await queryInterface.bulkDelete('event_types', null, {});
  },
};
