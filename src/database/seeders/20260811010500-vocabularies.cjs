/* eslint-disable */
'use strict';

/**
 * Position and sector vocabularies, taken verbatim from the live CARISCA CPD
 * registration form so historical and future data are directly comparable —
 * renaming a category now would break M&E's ability to compare cohorts.
 *
 * Also backfills the continent for every seeded country, which the price
 * resolver needs and which removes the "Country + Continent" double question
 * from the form.
 */

const POSITIONS = [
  ['professor_faculty', 'Professor/Faculty', false],
  ['higher_ed_admin', 'Higher Education Administration', false],
  ['student', 'Student/Graduate Student/Postdoc', true],
  ['other_researcher', 'Other Researcher', false],
  ['executive_c_suite', 'Executive/C-Suite', false],
  ['svp_vp', 'Senior Vice President/Vice President', false],
  ['owner', 'Owner', false],
  ['director', 'Senior Director/Director', false],
  ['manager', 'Senior Manager/Manager', false],
  ['specialist_coordinator', 'Specialist/Coordinator', false],
  ['other_supply_chain', 'Other Supply Chain Professional', false],
  ['other_nonprofit', 'Other Nonprofit or NGO Professional', false],
  ['doctor', 'Doctor', false],
  ['pharmacist', 'Pharmacist', false],
  ['other_healthcare', 'Other Healthcare Professional', false],
  ['other', 'Other', false],
];

const SECTORS = [
  ['agriculture', 'Agriculture'],
  ['business', 'Business'],
  ['government', 'Government'],
  ['healthcare', 'Health care'],
  ['higher_education', 'Higher Education'],
  ['nonprofit_ngo', 'Nonprofit or NGO'],
];

const REGIONS = {
  Africa: ['GH','NG','KE','ZA','TZ','UG','RW','ET','EG','MA','ZM','ZW','BW','NA','MW','MZ','CI','SN','BJ','BF','ML','NE','TG','GW','CM','GA','CD','LR','SL','GM','GN','MU','TN','DZ','AO','SS','SD'],
  Europe: ['GB','DE','FR','NL','BE','SE','CH','IE','ES','IT'],
  'North America': ['US','CA'],
  'South America': ['BR'],
  Asia: ['IN','CN','JP','AE','SA'],
  Oceania: ['AU'],
};

module.exports = {
  async up(queryInterface) {
    const ts = new Date();

    await queryInterface.bulkInsert(
      'positions',
      POSITIONS.map(([key, label, requires_student_id], i) => ({
        key, label, requires_student_id, sort_order: (i + 1) * 10,
        is_active: true, created_at: ts, updated_at: ts,
      })),
      { updateOnDuplicate: ['label', 'requires_student_id', 'sort_order', 'updated_at'] },
    );

    await queryInterface.bulkInsert(
      'sectors',
      SECTORS.map(([key, label], i) => ({
        key, label, sort_order: (i + 1) * 10, is_active: true, created_at: ts, updated_at: ts,
      })),
      { updateOnDuplicate: ['label', 'sort_order', 'updated_at'] },
    );

    for (const [region, codes] of Object.entries(REGIONS)) {
      await queryInterface.sequelize.query(
        'UPDATE countries SET region = :region WHERE iso2 IN (:codes)',
        { replacements: { region, codes } },
      );
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query('UPDATE countries SET region = NULL');
    await queryInterface.bulkDelete('sectors', { key: { [Sequelize.Op.in]: SECTORS.map((s) => s[0]) } });
    await queryInterface.bulkDelete('positions', { key: { [Sequelize.Op.in]: POSITIONS.map((p) => p[0]) } });
  },
};
