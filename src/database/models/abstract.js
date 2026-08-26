import { DataTypes } from 'sequelize';

/**
 * A researcher's proposal to present at a Summit. Ownership-scoped like
 * `Registration` — the author acts on their own row by ownership, not by
 * permission; only the staff review routes are permission-gated.
 */
export default function defineAbstract(sequelize) {
  const AbstractSubmission = sequelize.define('AbstractSubmission', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    event_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    user_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    reference: { type: DataTypes.STRING(48), allowNull: false, unique: true },
    title: { type: DataTypes.STRING(255), allowNull: false },
    abstract_text: { type: DataTypes.TEXT, allowNull: false },
    // The author's requested track — reviewers may move it during triage.
    track_id: { type: DataTypes.BIGINT.UNSIGNED },
    // [{ name, affiliation, email }]
    co_authors: { type: DataTypes.JSON },
    paper_file_id: { type: DataTypes.BIGINT.UNSIGNED },
    status: {
      type: DataTypes.ENUM('SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED', 'WITHDRAWN'),
      allowNull: false,
      defaultValue: 'SUBMITTED',
    },
    // Staff-only. Never serialised back to the author.
    review_notes: { type: DataTypes.TEXT },
    decided_by: { type: DataTypes.BIGINT.UNSIGNED },
    decided_at: { type: DataTypes.DATE(3) },
    submitted_at: { type: DataTypes.DATE(3), allowNull: false },
  }, {
    tableName: 'abstract_submissions',
    timestamps: true,
    paranoid: true,
    underscored: true,
  });

  return { AbstractSubmission };
}
