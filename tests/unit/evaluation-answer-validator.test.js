import { validateAnswers } from '../../src/core/evaluations/evaluation-answer-validator.js';

const question = (overrides) => ({
  id: 1, label: 'How was it', type: 'TEXT', is_required: false, options: null, ...overrides,
});

describe('RATING', () => {
  test.each([1, 2, 3, 4, 5])('%i is a valid rating', (n) => {
    const rows = validateAnswers([question({ type: 'RATING' })], { 1: String(n) });
    expect(rows[0].numeric_value).toBe(n);
    expect(rows[0].value).toBe(String(n));
  });

  test.each([0, 6, -1, 3.5, 'great'])('%p is refused', (bad) => {
    expect(() => validateAnswers([question({ type: 'RATING' })], { 1: bad })).toThrow();
  });
});

describe('NPS', () => {
  test.each([0, 5, 10])('%i is a valid score', (n) => {
    const rows = validateAnswers([question({ type: 'NPS' })], { 1: String(n) });
    expect(rows[0].numeric_value).toBe(n);
  });

  test.each([-1, 11, 4.5, 'yes'])('%p is refused', (bad) => {
    expect(() => validateAnswers([question({ type: 'NPS' })], { 1: bad })).toThrow();
  });
});

describe('required questions', () => {
  test('a blank required question is refused', () => {
    expect(() => validateAnswers([question({ type: 'RATING', is_required: true })], {})).toThrow();
  });

  test('a blank optional question is skipped, not an error', () => {
    expect(validateAnswers([question({ type: 'RATING', is_required: false })], {})).toEqual([]);
  });
});

describe('question ownership', () => {
  test('an answer to a question outside this survey is rejected, not silently dropped', () => {
    expect(() => validateAnswers([question({ id: 1 })], { 999: 'hi' })).toThrow();
  });
});

describe('non-numeric types unaffected', () => {
  test('TEXT/SELECT/etc still validate and store the same as the registration validator', () => {
    const rows = validateAnswers(
      [question({ id: 2, type: 'SELECT', options: [{ value: 'good', label: 'Good' }] })],
      { 2: 'good' },
    );
    expect(rows[0]).toMatchObject({ question_id: 2, value: 'good', numeric_value: null });
  });
});
