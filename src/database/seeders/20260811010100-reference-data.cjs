/* eslint-disable */
'use strict';

/**
 * Currencies and countries. Idempotent: re-running updates rather than
 * duplicating, so this is safe to apply to an existing environment.
 */
const now = () => new Date();

const CURRENCIES = [
  ['GHS', 'Ghanaian Cedi', 'GH₵', 2],
  ['NGN', 'Nigerian Naira', '₦', 2],
  ['USD', 'US Dollar', '$', 2],
  ['GBP', 'Pound Sterling', '£', 2],
  ['EUR', 'Euro', '€', 2],
  ['ZAR', 'South African Rand', 'R', 2],
  ['KES', 'Kenyan Shilling', 'KSh', 2],
  ['TZS', 'Tanzanian Shilling', 'TSh', 2],
  ['UGX', 'Ugandan Shilling', 'USh', 0],
  ['RWF', 'Rwandan Franc', 'FRw', 0],
  ['XOF', 'West African CFA Franc', 'CFA', 0],
  ['XAF', 'Central African CFA Franc', 'FCFA', 0],
  ['EGP', 'Egyptian Pound', 'E£', 2],
  ['MAD', 'Moroccan Dirham', 'DH', 2],
  ['ETB', 'Ethiopian Birr', 'Br', 2],
  ['ZMW', 'Zambian Kwacha', 'ZK', 2],
  ['BWP', 'Botswana Pula', 'P', 2],
  ['CAD', 'Canadian Dollar', 'CA$', 2],
  ['AUD', 'Australian Dollar', 'A$', 2],
  ['INR', 'Indian Rupee', '₹', 2],
  ['CNY', 'Chinese Yuan', '¥', 2],
  ['JPY', 'Japanese Yen', '¥', 0],
];

// iso2, iso3, name, phone code, default currency, IANA timezone
const COUNTRIES = [
  ['GH', 'GHA', 'Ghana', '+233', 'GHS', 'Africa/Accra'],
  ['NG', 'NGA', 'Nigeria', '+234', 'NGN', 'Africa/Lagos'],
  ['KE', 'KEN', 'Kenya', '+254', 'KES', 'Africa/Nairobi'],
  ['ZA', 'ZAF', 'South Africa', '+27', 'ZAR', 'Africa/Johannesburg'],
  ['TZ', 'TZA', 'Tanzania', '+255', 'TZS', 'Africa/Dar_es_Salaam'],
  ['UG', 'UGA', 'Uganda', '+256', 'UGX', 'Africa/Kampala'],
  ['RW', 'RWA', 'Rwanda', '+250', 'RWF', 'Africa/Kigali'],
  ['ET', 'ETH', 'Ethiopia', '+251', 'ETB', 'Africa/Addis_Ababa'],
  ['EG', 'EGY', 'Egypt', '+20', 'EGP', 'Africa/Cairo'],
  ['MA', 'MAR', 'Morocco', '+212', 'MAD', 'Africa/Casablanca'],
  ['ZM', 'ZMB', 'Zambia', '+260', 'ZMW', 'Africa/Lusaka'],
  ['ZW', 'ZWE', 'Zimbabwe', '+263', 'USD', 'Africa/Harare'],
  ['BW', 'BWA', 'Botswana', '+267', 'BWP', 'Africa/Gaborone'],
  ['NA', 'NAM', 'Namibia', '+264', 'ZAR', 'Africa/Windhoek'],
  ['MW', 'MWI', 'Malawi', '+265', 'USD', 'Africa/Blantyre'],
  ['MZ', 'MOZ', 'Mozambique', '+258', 'USD', 'Africa/Maputo'],
  ['CI', 'CIV', "Côte d'Ivoire", '+225', 'XOF', 'Africa/Abidjan'],
  ['SN', 'SEN', 'Senegal', '+221', 'XOF', 'Africa/Dakar'],
  ['BJ', 'BEN', 'Benin', '+229', 'XOF', 'Africa/Porto-Novo'],
  ['BF', 'BFA', 'Burkina Faso', '+226', 'XOF', 'Africa/Ouagadougou'],
  ['ML', 'MLI', 'Mali', '+223', 'XOF', 'Africa/Bamako'],
  ['NE', 'NER', 'Niger', '+227', 'XOF', 'Africa/Niamey'],
  ['TG', 'TGO', 'Togo', '+228', 'XOF', 'Africa/Lome'],
  ['GW', 'GNB', 'Guinea-Bissau', '+245', 'XOF', 'Africa/Bissau'],
  ['CM', 'CMR', 'Cameroon', '+237', 'XAF', 'Africa/Douala'],
  ['GA', 'GAB', 'Gabon', '+241', 'XAF', 'Africa/Libreville'],
  ['CD', 'COD', 'DR Congo', '+243', 'USD', 'Africa/Kinshasa'],
  ['LR', 'LBR', 'Liberia', '+231', 'USD', 'Africa/Monrovia'],
  ['SL', 'SLE', 'Sierra Leone', '+232', 'USD', 'Africa/Freetown'],
  ['GM', 'GMB', 'Gambia', '+220', 'USD', 'Africa/Banjul'],
  ['GN', 'GIN', 'Guinea', '+224', 'XOF', 'Africa/Conakry'],
  ['MU', 'MUS', 'Mauritius', '+230', 'USD', 'Indian/Mauritius'],
  ['TN', 'TUN', 'Tunisia', '+216', 'USD', 'Africa/Tunis'],
  ['DZ', 'DZA', 'Algeria', '+213', 'USD', 'Africa/Algiers'],
  ['AO', 'AGO', 'Angola', '+244', 'USD', 'Africa/Luanda'],
  ['SS', 'SSD', 'South Sudan', '+211', 'USD', 'Africa/Juba'],
  ['SD', 'SDN', 'Sudan', '+249', 'USD', 'Africa/Khartoum'],
  ['GB', 'GBR', 'United Kingdom', '+44', 'GBP', 'Europe/London'],
  ['US', 'USA', 'United States', '+1', 'USD', 'America/New_York'],
  ['CA', 'CAN', 'Canada', '+1', 'CAD', 'America/Toronto'],
  ['DE', 'DEU', 'Germany', '+49', 'EUR', 'Europe/Berlin'],
  ['FR', 'FRA', 'France', '+33', 'EUR', 'Europe/Paris'],
  ['NL', 'NLD', 'Netherlands', '+31', 'EUR', 'Europe/Amsterdam'],
  ['BE', 'BEL', 'Belgium', '+32', 'EUR', 'Europe/Brussels'],
  ['SE', 'SWE', 'Sweden', '+46', 'EUR', 'Europe/Stockholm'],
  ['CH', 'CHE', 'Switzerland', '+41', 'EUR', 'Europe/Zurich'],
  ['IE', 'IRL', 'Ireland', '+353', 'EUR', 'Europe/Dublin'],
  ['ES', 'ESP', 'Spain', '+34', 'EUR', 'Europe/Madrid'],
  ['IT', 'ITA', 'Italy', '+39', 'EUR', 'Europe/Rome'],
  ['AU', 'AUS', 'Australia', '+61', 'AUD', 'Australia/Sydney'],
  ['IN', 'IND', 'India', '+91', 'INR', 'Asia/Kolkata'],
  ['CN', 'CHN', 'China', '+86', 'CNY', 'Asia/Shanghai'],
  ['JP', 'JPN', 'Japan', '+81', 'JPY', 'Asia/Tokyo'],
  ['AE', 'ARE', 'United Arab Emirates', '+971', 'USD', 'Asia/Dubai'],
  ['SA', 'SAU', 'Saudi Arabia', '+966', 'USD', 'Asia/Riyadh'],
  ['BR', 'BRA', 'Brazil', '+55', 'USD', 'America/Sao_Paulo'],
];

module.exports = {
  async up(queryInterface) {
    const ts = now();

    await queryInterface.bulkInsert(
      'currencies',
      CURRENCIES.map(([code, name, symbol, exponent]) => ({
        code, name, symbol, exponent, is_active: true, created_at: ts, updated_at: ts,
      })),
      { updateOnDuplicate: ['name', 'symbol', 'exponent', 'updated_at'] },
    );

    await queryInterface.bulkInsert(
      'countries',
      COUNTRIES.map(([iso2, iso3, name, phone_code, default_currency, default_timezone]) => ({
        iso2, iso3, name, phone_code, default_currency, default_timezone,
        is_active: true, created_at: ts, updated_at: ts,
      })),
      { updateOnDuplicate: ['iso3', 'name', 'phone_code', 'default_currency', 'default_timezone', 'updated_at'] },
    );
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.bulkDelete('countries', { iso2: { [Sequelize.Op.in]: COUNTRIES.map((c) => c[0]) } });
    await queryInterface.bulkDelete('currencies', { code: { [Sequelize.Op.in]: CURRENCIES.map((c) => c[0]) } });
  },
};
