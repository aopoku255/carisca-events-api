/**
 * Aggregates registration answers into per-question summaries.
 *
 * Kept out of the route because the shape of the aggregation depends entirely
 * on the question type, and that is a page of branching that has nothing to do
 * with HTTP.
 *
 * Two storage details drive everything here:
 *
 *   - Multi-value answers are stored as a JSON array in one text column
 *     (`["vegetarian","halal"]`), so a SQL GROUP BY on the raw value would
 *     count every distinct combination as its own bucket. They are parsed and
 *     counted per selection instead.
 *   - Choice answers store the option's *value*, not its label. The label is
 *     resolved from the question's own options, and an answer whose option was
 *     later deleted keeps its raw value rather than disappearing.
 */

const TEXTUAL = new Set(['TEXT', 'LONGTEXT', 'EMAIL', 'PHONE']);
const CHOICE = new Set(['SELECT', 'RADIO', 'MULTISELECT']);

/** How many free-text answers to return before the client is told there are more. */
const TEXT_SAMPLE_LIMIT = 200;

/**
 * Multi-value answers are JSON arrays; everything else is a plain string. A
 * value that looks like JSON but does not parse is treated as the literal
 * string it is, rather than being dropped.
 */
function selectionsOf(value) {
  if (value === null || value === undefined) return [];
  const raw = String(value);
  if (!raw.startsWith('[')) return [raw];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [raw];
  } catch {
    return [raw];
  }
}

function choiceSummary(question, answers) {
  const declared = Array.isArray(question.options) ? question.options : [];

  // Declared order, not count order. These are often ordinal — "Strongly
  // agree" through "Strongly disagree" — and sorting by popularity would
  // destroy the scale the author built.
  const buckets = new Map(
    declared.map((o) => [String(o.value), { value: String(o.value), label: o.label ?? String(o.value), count: 0, retired: false }]),
  );

  let selections = 0;

  for (const answer of answers) {
    for (const value of selectionsOf(answer.value)) {
      if (!buckets.has(value)) {
        // An option removed from the form after someone answered it. Kept
        // visible and marked, because silently dropping it would make the
        // counts disagree with the number of people who answered.
        buckets.set(value, { value, label: value, count: 0, retired: true });
      }
      buckets.get(value).count += 1;
      selections += 1;
    }
  }

  return { options: [...buckets.values()], selections };
}

function textSummary(answers) {
  const values = answers
    .map((a) => (a.value === null || a.value === undefined ? '' : String(a.value).trim()))
    .filter(Boolean);

  // Repeats are worth surfacing — twenty people typing "None" is a finding,
  // and a reader scrolling a flat list would never notice.
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);

  const repeated = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    samples: values.slice(0, TEXT_SAMPLE_LIMIT),
    truncated: values.length > TEXT_SAMPLE_LIMIT,
    distinct: counts.size,
    repeated,
  };
}

function numberSummary(answers) {
  const numbers = answers
    .map((a) => Number(a.value))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  if (!numbers.length) return { stats: null, buckets: [] };

  const sum = numbers.reduce((a, b) => a + b, 0);
  const min = numbers[0];
  const max = numbers[numbers.length - 1];
  const mid = Math.floor(numbers.length / 2);
  const median = numbers.length % 2
    ? numbers[mid]
    : (numbers[mid - 1] + numbers[mid]) / 2;

  // A histogram needs a spread to bin. When every answer is the same number
  // there is nothing to distribute, and one full-width bar would imply one.
  let buckets = [];
  if (max > min) {
    const count = Math.min(8, new Set(numbers).size);
    const width = (max - min) / count;
    buckets = Array.from({ length: count }, (_, i) => {
      const from = min + i * width;
      const to = i === count - 1 ? max : min + (i + 1) * width;
      return {
        label: `${round(from)}–${round(to)}`,
        count: numbers.filter((n) => (i === count - 1 ? n >= from && n <= to : n >= from && n < to)).length,
      };
    });
  }

  return {
    stats: { count: numbers.length, min, max, sum, mean: round(sum / numbers.length), median: round(median) },
    buckets,
  };
}

const round = (n) => Math.round(n * 100) / 100;

function dateSummary(answers) {
  const counts = new Map();
  for (const a of answers) {
    const parsed = new Date(String(a.value));
    if (Number.isNaN(parsed.valueOf())) continue;
    const day = parsed.toISOString().slice(0, 10);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }

  // Chronological — a date axis out of order is not a date axis.
  return {
    buckets: [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, count]) => ({ label, count })),
  };
}

/**
 * @param questions  the event's questions, in sort order
 * @param answers    rows of { question_id, value }, already scoped to the event
 * @param responses  how many registrations could have answered — the denominator
 */
export function summariseResponses(questions, answers, responses) {
  const byQuestion = new Map(questions.map((q) => [String(q.id), []]));
  for (const answer of answers) {
    byQuestion.get(String(answer.question_id))?.push(answer);
  }

  return questions.map((question) => {
    const own = byQuestion.get(String(question.id)) ?? [];
    // A row exists only when something was submitted, but an empty string can
    // still reach the column, so "answered" is counted on content.
    const answered = own.filter((a) => String(a.value ?? '').trim() !== '').length;

    const base = {
      id: String(question.id),
      label: question.label,
      type: question.type,
      required: !!question.is_required,
      answered,
      skipped: Math.max(0, responses - answered),
    };

    if (CHOICE.has(question.type)) {
      const { options, selections } = choiceSummary(question, own);
      return {
        ...base,
        options,
        selections,
        // Several answers per person means the shares are of respondents, not
        // of selections, and will exceed 100%. The client has to say so.
        multiple: question.type === 'MULTISELECT',
      };
    }

    if (question.type === 'CHECKBOX') {
      const ticked = own.filter((a) => {
        const v = String(a.value ?? '').toLowerCase();
        return v !== '' && v !== 'false' && v !== '0' && v !== '[]';
      }).length;
      return {
        ...base,
        options: [
          { value: 'ticked', label: 'Ticked', count: ticked, retired: false },
          { value: 'not', label: 'Not ticked', count: Math.max(0, responses - ticked), retired: false },
        ],
        selections: responses,
        multiple: false,
      };
    }

    if (TEXTUAL.has(question.type)) return { ...base, text: textSummary(own) };
    // RATING/NPS are evaluation-only types (never appear on a registration
    // question) — same shape of number as NUMBER, just a fixed scale.
    if (question.type === 'NUMBER' || question.type === 'RATING' || question.type === 'NPS') {
      return { ...base, number: numberSummary(own) };
    }
    if (question.type === 'DATE') return { ...base, date: dateSummary(own) };
    if (question.type === 'FILE') return { ...base, uploaded: answered };

    return base;
  });
}

export default { summariseResponses };
