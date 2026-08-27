import { ValidationError } from '../../lib/errors.js';

/**
 * Validates submitted survey answers against a form's configured questions.
 * A close copy of `registrations/answer-validator.js` — same reasoning
 * (server-side because the question set is data, a client could submit
 * anything) — with RATING/NPS added and EMAIL/PHONE/FILE dropped, matching
 * `evaluation_questions`' own type enum, which doesn't have those three.
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
    case 'RATING': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 5) return `${label} must be a rating from 1 to 5.`;
      return null;
    }
    case 'NPS': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 10) return `${label} must be a score from 0 to 10.`;
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
 * @param questions the form's configured questions
 * @param answers   { [questionId]: value } as submitted
 * @returns normalised rows ready for evaluation_responses
 */
export function validateAnswers(questions, answers = {}) {
  const errors = [];
  const rows = [];
  const known = new Map(questions.map((q) => [String(q.id), q]));

  for (const key of Object.keys(answers)) {
    if (!known.has(String(key))) {
      errors.push({ field: `answers.${key}`, message: 'This question does not belong to this survey.' });
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

    const isNumeric = question.type === 'RATING' || question.type === 'NPS';
    rows.push({
      question_id: question.id,
      value: Array.isArray(raw) ? JSON.stringify(raw.map(String)) : String(raw),
      numeric_value: isNumeric ? Number(raw) : null,
    });
  }

  if (errors.length) throw new ValidationError(errors);
  return rows;
}

export default { validateAnswers };
