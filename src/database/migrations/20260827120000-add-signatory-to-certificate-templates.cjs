/* eslint-disable */
'use strict';

/**
 * `certificate_templates` already carried columns for a much bigger "swap the
 * whole background artwork" builder (`background_file_id`, `orientation`,
 * `layout`) that was designed once and never built on top of — left alone,
 * unused. This adds the much smaller thing actually needed: a template is a
 * saved second-signatory profile (name, title, department, signature image)
 * applied to CARISCA's one fixed certificate design. The first signatory and
 * the rest of the artwork never change.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('certificate_templates', 'signatory_name', {
      type: Sequelize.STRING(160), allowNull: true,
    });
    await queryInterface.addColumn('certificate_templates', 'signatory_title', {
      type: Sequelize.STRING(160), allowNull: true,
    });
    await queryInterface.addColumn('certificate_templates', 'signatory_department', {
      type: Sequelize.STRING(255), allowNull: true,
    });
    await queryInterface.addColumn('certificate_templates', 'signature_file_id', {
      type: Sequelize.BIGINT.UNSIGNED,
      allowNull: true,
      references: { model: 'files', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('certificate_templates', 'signature_file_id');
    await queryInterface.removeColumn('certificate_templates', 'signatory_department');
    await queryInterface.removeColumn('certificate_templates', 'signatory_title');
    await queryInterface.removeColumn('certificate_templates', 'signatory_name');
  },
};
