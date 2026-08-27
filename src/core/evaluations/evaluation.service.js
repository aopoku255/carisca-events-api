import { models, sequelize } from '../../database/models/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { record as audit } from '../audit/audit.service.js';
import { validateAnswers } from './evaluation-answer-validator.js';

const {
  EvaluationForm, EvaluationQuestion, EvaluationResponse, Event,
} = models;

/**
 * Every event gets at most one POST-phase survey, auto-created the first
 * time its questions are saved — the form itself is never a thing an admin
 * manages directly (no title/phase/anonymity picker), it's just where the
 * question list lives. PRE-phase forms and multiple forms per event are
 * schema-supported but not built; nothing here assumes there's only ever
 * one form for an event, it just never creates more than one.
 */
async function findOrCreatePostForm(eventId, { transaction } = {}) {
  const [form] = await EvaluationForm.findOrCreate({
    where: { event_id: eventId, phase: 'POST' },
    defaults: { event_id: eventId, phase: 'POST', title: 'Post-event survey' },
    transaction,
  });
  return form;
}

export async function saveQuestions(eventId, questions, { actor, context = {} } = {}) {
  return sequelize.transaction(async (transaction) => {
    const form = await findOrCreatePostForm(eventId, { transaction });

    const existing = await EvaluationQuestion.findAll({ where: { form_id: form.id }, transaction });
    const before = existing.map((q) => q.label);

    await EvaluationQuestion.destroy({ where: { form_id: form.id }, transaction });
    if (questions.length) {
      await EvaluationQuestion.bulkCreate(
        questions.map((q, i) => ({
          form_id: form.id,
          label: q.label,
          type: q.type,
          options: q.options ?? null,
          category: q.category ?? null,
          is_required: q.required,
          sort_order: q.sortOrder || (i + 1) * 10,
        })),
        { transaction },
      );
    }

    await audit({
      actor,
      action: 'event.evaluation_questions_updated',
      resourceType: 'event',
      resourceId: eventId,
      before: { questions: before },
      after: { questions: questions.map((q) => q.label) },
      context,
    }, { transaction });

    return form;
  });
}

/** The questions the admin has configured for this event, in display order — `[]` if none yet. */
export async function questionsForEvent(eventId) {
  const form = await EvaluationForm.findOne({ where: { event_id: eventId, phase: 'POST' } });
  if (!form) return [];
  return EvaluationQuestion.findAll({ where: { form_id: form.id }, order: [['sort_order', 'ASC']] });
}

/**
 * The form plus this registration's own answers, for rendering the
 * participant-facing survey (pre-filled if they already submitted).
 */
export async function getSurveyFor(registration) {
  const form = await EvaluationForm.findOne({ where: { event_id: registration.event_id, phase: 'POST' } });
  if (!form) return null;

  const [questions, responses] = await Promise.all([
    EvaluationQuestion.findAll({ where: { form_id: form.id }, order: [['sort_order', 'ASC']] }),
    EvaluationResponse.findAll({ where: { form_id: form.id, registration_id: registration.id } }),
  ]);

  return { form, questions, responses };
}

/** Same "has the program ended" window `certificateEligibility()` already gates on. */
function eventHasFinished(event) {
  return event.status === 'COMPLETED' || new Date(event.end_at) <= new Date();
}

export async function submitResponses(registration, answers) {
  const event = registration.event ?? await Event.findByPk(registration.event_id);
  if (!event) throw new NotFoundError('Event');

  const survey = await getSurveyFor(registration);
  if (!survey) throw new NotFoundError('Survey');

  if (registration.status !== 'CONFIRMED') {
    throw new ConflictError('Your registration must be confirmed before you can complete the survey.', 'REGISTRATION_NOT_CONFIRMED');
  }
  if (!eventHasFinished(event)) {
    throw new ConflictError('The survey opens once the programme has ended.', 'EVENT_NOT_FINISHED');
  }

  const rows = validateAnswers(survey.questions, answers);
  if (!rows.length) {
    throw new ValidationError([{ field: 'answers', message: 'Answer at least one question.' }]);
  }

  return sequelize.transaction(async (transaction) => {
    await EvaluationResponse.destroy({
      where: { form_id: survey.form.id, registration_id: registration.id },
      transaction,
    });
    await EvaluationResponse.bulkCreate(
      rows.map((row) => ({
        form_id: survey.form.id,
        registration_id: registration.id,
        submitted_at: new Date(),
        ...row,
      })),
      { transaction },
    );
    return EvaluationResponse.findAll({
      where: { form_id: survey.form.id, registration_id: registration.id },
      transaction,
    });
  });
}

/**
 * The certificate gate: `false` only blocks something. An admin who flips
 * `certificate_requires_evaluation` on before ever writing a question — or
 * whose event has no survey at all — must not lock out every certificate
 * for a requirement nobody could ever satisfy.
 */
export async function hasCompletedRequiredSurvey(registration, event) {
  if (!event.certificate_requires_evaluation) return true;

  const form = await EvaluationForm.findOne({ where: { event_id: event.id, phase: 'POST' } });
  if (!form) return true;

  const required = await EvaluationQuestion.findAll({
    where: { form_id: form.id, is_required: true },
    attributes: ['id'],
  });
  if (!required.length) return true;

  const answered = await EvaluationResponse.findAll({
    where: { form_id: form.id, registration_id: registration.id },
    attributes: ['question_id'],
  });
  const answeredIds = new Set(answered.map((r) => Number(r.question_id)));

  return required.every((q) => answeredIds.has(Number(q.id)));
}

export default {
  saveQuestions, questionsForEvent, getSurveyFor, submitResponses, hasCompletedRequiredSurvey,
};
