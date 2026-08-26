/* eslint-disable */
'use strict';

/**
 * A researcher's proposal to present at a Summit — entirely new domain, no
 * existing table to extend.
 *
 * `reference` is a shareable, human-quotable id, the same idea as
 * `registrations.reference`. `review_notes` is staff-only and never shown to
 * the author. Status moves SUBMITTED -> UNDER_REVIEW -> ACCEPTED|REJECTED
 * (terminal), or WITHDRAWN from either non-terminal state — never from a
 * decided state. That machine is small enough to live as a plain check in
 * `abstract.service.js` rather than the generic event state machine, which
 * exists for a different domain with different actors.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('abstract_submissions', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      event_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'events', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      user_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      reference: { type: Sequelize.STRING(48), allowNull: false, unique: true },
      title: { type: Sequelize.STRING(255), allowNull: false },
      abstract_text: { type: Sequelize.TEXT, allowNull: false },
      track_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'event_tracks', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      // [{ name, affiliation, email }] — free-form, same convention as
      // cpd_event_details.learning_objectives.
      co_authors: { type: Sequelize.JSON, allowNull: true },
      paper_file_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'files', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      status: {
        type: Sequelize.ENUM('SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED', 'WITHDRAWN'),
        allowNull: false,
        defaultValue: 'SUBMITTED',
      },
      review_notes: { type: Sequelize.TEXT, allowNull: true },
      decided_by: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      decided_at: { type: Sequelize.DATE(3), allowNull: true },
      submitted_at: { type: Sequelize.DATE(3), allowNull: false },
      created_at: { type: Sequelize.DATE(3), allowNull: false },
      updated_at: { type: Sequelize.DATE(3), allowNull: false },
      deleted_at: { type: Sequelize.DATE(3) },
    });

    await queryInterface.addIndex('abstract_submissions', ['event_id', 'status'], { name: 'idx_abstracts_event_status' });
    await queryInterface.addIndex('abstract_submissions', ['user_id'], { name: 'idx_abstracts_user' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('abstract_submissions');
  },
};
