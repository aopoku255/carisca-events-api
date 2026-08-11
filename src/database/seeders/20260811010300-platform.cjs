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
      { key: 'summit', name: 'CARISCA Summit', module: 'summit', description: 'Annual supply chain research summit', is_active: false, created_at: ts, updated_at: ts },
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

    await queryInterface.bulkInsert('certificate_templates', [{
      name: 'CARISCA Standard Certificate',
      description: 'Default landscape certificate of participation.',
      orientation: 'LANDSCAPE',
      layout: JSON.stringify({
        // Percentage coordinates so the layout survives a page-size change.
        fields: [
          { key: 'organisation', text: 'CARISCA', x: 50, y: 14, size: 20, align: 'center', color: '#0F3B8F', weight: 'bold' },
          { key: 'subtitle', text: 'Centre for Applied Research and Innovation in Supply Chain-Africa', x: 50, y: 20, size: 10, align: 'center', color: '#677289' },
          { key: 'title', text: 'Certificate of Participation', x: 50, y: 32, size: 26, align: 'center', color: '#0A2961' },
          { key: 'presented_to', text: 'This is to certify that', x: 50, y: 42, size: 11, align: 'center', color: '#677289' },
          { key: 'participant_name', source: 'participant_name', x: 50, y: 50, size: 28, align: 'center', color: '#0F3B8F' },
          { key: 'body', text: 'has successfully participated in', x: 50, y: 58, size: 11, align: 'center', color: '#677289' },
          { key: 'event_title', source: 'event_title', x: 50, y: 65, size: 16, align: 'center', color: '#0A2961' },
          { key: 'event_dates', source: 'event_dates', x: 50, y: 71, size: 11, align: 'center', color: '#677289' },
          { key: 'credits', source: 'cpd_credits_label', x: 50, y: 76, size: 10, align: 'center', color: '#677289' },
          { key: 'verification', source: 'verification_code', x: 50, y: 93, size: 8, align: 'center', color: '#677289' },
        ],
        signatories: [
          { name_source: 'signatory_1_name', title_source: 'signatory_1_title', x: 28, y: 84 },
          { name_source: 'signatory_2_name', title_source: 'signatory_2_title', x: 72, y: 84 },
        ],
        qr: { x: 88, y: 82, size: 12, source: 'verification_url' },
      }),
      is_default: true,
      is_active: true,
      created_at: ts,
      updated_at: ts,
    }]);

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
      // Intentionally blank. Certificates must not be issued with placeholder
      // signatories, so CertificateEligibilityService refuses to generate until
      // real names and titles are set at /admin/settings.
      { key: 'certificate.signatories', value: JSON.stringify([
        { name: '', title: 'Director, CARISCA' },
        { name: '', title: 'Programme Lead' },
      ]), description: 'Certificate signatories — MUST be filled in before the first certificate is generated', is_public: false, created_at: ts, updated_at: ts },
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
