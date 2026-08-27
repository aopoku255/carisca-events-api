import { DataTypes } from 'sequelize';

/**
 * Tables already existed (`20260811000700-create-attendance-certificates.cjs`)
 * from when the certificate-eligibility work was first scaffolded — this is
 * the first time they get Sequelize models. No migration needed.
 */
export default function defineEvaluation(sequelize) {
  const EvaluationForm = sequelize.define('EvaluationForm', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    event_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    title: { type: DataTypes.STRING(255), allowNull: false },
    phase: { type: DataTypes.ENUM('PRE', 'POST'), allowNull: false, defaultValue: 'POST' },
    is_required_for_certificate: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    is_anonymous: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    opens_at: { type: DataTypes.DATE(3) },
    closes_at: { type: DataTypes.DATE(3) },
  }, { tableName: 'evaluation_forms', timestamps: true, paranoid: true, underscored: true });

  const EvaluationQuestion = sequelize.define('EvaluationQuestion', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    form_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    label: { type: DataTypes.STRING(500), allowNull: false },
    type: {
      type: DataTypes.ENUM(
        'TEXT', 'LONGTEXT', 'NUMBER', 'SELECT', 'MULTISELECT',
        'RADIO', 'CHECKBOX', 'RATING', 'NPS', 'DATE',
      ),
      allowNull: false,
      defaultValue: 'RATING',
    },
    options: { type: DataTypes.JSON },
    // Groups answers for M&E rollups: satisfaction, learning_outcome, facilitator.
    category: { type: DataTypes.STRING(48) },
    is_required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    sort_order: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
  }, { tableName: 'evaluation_questions', timestamps: true, paranoid: true, underscored: true });

  const EvaluationResponse = sequelize.define('EvaluationResponse', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    form_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    // Nullable so an anonymous form can still be tied to an event without
    // identifying the respondent — unused today (no form is anonymous yet)
    // but the column exists, so the model reflects it honestly.
    registration_id: { type: DataTypes.BIGINT.UNSIGNED },
    question_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    value: { type: DataTypes.TEXT },
    numeric_value: { type: DataTypes.DECIMAL(8, 2) },
    submitted_at: { type: DataTypes.DATE(3), allowNull: false },
  }, { tableName: 'evaluation_responses', timestamps: true, underscored: true });

  return { EvaluationForm, EvaluationQuestion, EvaluationResponse };
}
