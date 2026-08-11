import { ValidationError } from '../../lib/errors.js';

/**
 * Validates submitted answers against an event's configured questions.
 *
 * This runs on the server because the question set is data: a client could
 * submit anything, including answers to questions that do not belong to this
 * event, or skip a required one by omitting the field entirely.
 */

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

function optionValues(question) {
  const opts = Array.isArray(question.options) ? question.options : [];
  return opts.map((o) => (typeof o === 'string' ? o : o.value ?? o.label)).filter((v) => v != null);
}

function checkOne(question, raw) {
  const label = question.label;

  switch (question.type) {
    case 'NUMBER': {
      if (!/^-?\d+(\.\d+)?$/.test(String(raw))) return `${label} must be a number.`;
      return null;
    }
    case 'EMAIL': {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(raw))) return `${label} must be a valid email address.`;
      return null;
    }
    case 'PHONE': {
      if (!/^\+?[\d\s()-]{6,32}$/.test(String(raw))) return `${label} must be a valid phone number.`;
      return null;
    }
    case 'DATE': {
      if (Number.isNaN(Date.parse(String(raw)))) return `${label} must be a valid date.`;
      return null;
    }
    case 'SELECT':
    case 'RADIO': {
      const allowed = optionValues(question);
      if (allowed.length && !allowed.includes(String(raw))) {
        return `${label} must be one of the available options.`;
      }
      return null;
    }
    case 'MULTISELECT':
    case 'CHECKBOX': {
      const values = Array.isArray(raw) ? raw : [raw];
      const allowed = optionValues(question);
      if (allowed.length) {
        const unknown = values.map(String).filter((v) => !allowed.includes(v));
        if (unknown.length) return `${label} contains an option that is not available.`;
      }
      return null;
    }
    case 'FILE': {
      if (!/^\d+$/.test(String(raw))) return `${label} must be an uploaded file.`;
      return null;
    }
    case 'LONGTEXT': {
      if (String(raw).length > 5000) return `${label} is too long.`;
      return null;
    }
    case 'TEXT':
    default: {
      if (String(raw).length > 1000) return `${label} is too long.`;
      return null;
    }
  }
}

/**
 * @param questions the event's configured questions
 * @param answers   { [questionId]: value } as submitted
 * @returns normalised rows ready for registration_answers
 */
export function validateAnswers(questions, answers = {}) {
  const errors = [];
  const rows = [];
  const known = new Map(questions.map((q) => [String(q.id), q]));

  for (const key of Object.keys(answers)) {
    if (!known.has(String(key))) {
      // Silently dropping it would let a client believe it was recorded.
      errors.push({ field: `answers.${key}`, message: 'This question does not belong to this event.' });
    }
  }

  for (const question of questions) {
    const raw = answers[String(question.id)] ?? answers[question.id];

    if (isBlank(raw) || (Array.isArray(raw) && raw.length === 0)) {
      if (question.is_required) {
        errors.push({ field: `answers.${question.id}`, message: `${question.label} is required.` });
      }
      continue;
    }

    const problem = checkOne(question, raw);
    if (problem) {
      errors.push({ field: `answers.${question.id}`, message: problem });
      continue;
    }

    rows.push({
      question_id: question.id,
      // Multi-value answers are stored as JSON so a single column serves every
      // question type without a second table.
      value: Array.isArray(raw) ? JSON.stringify(raw.map(String)) : String(raw),
      file_id: question.type === 'FILE' ? Number(raw) : null,
    });
  }

  if (errors.length) throw new ValidationError(errors);
  return rows;
}

export default { validateAnswers };
