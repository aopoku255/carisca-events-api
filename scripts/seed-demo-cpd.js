/**
 * Creates one fully configured, published CPD for local development, modelled
 * on the real event at cpd.carisca.org — including its three-way pricing.
 *
 * Idempotent: re-running replaces the same slug rather than piling up copies.
 *
 *   node scripts/seed-demo-cpd.js
 */
import { connect, disconnect, models, sequelize } from '../src/database/models/index.js';
import { loadCurrencyExponents } from '../src/lib/money.js';

const SLUG = 'supply-chain-analytics-for-decision-making-level-2';

const PRICES = [
  { label: 'Virtual', attendance_mode: 'VIRTUAL', audience: 'ANY', amount_minor: 2500, currency: 'USD', is_default: true },
  { label: 'In-Person (Africa)', attendance_mode: 'IN_PERSON', audience: 'AFRICA', amount_minor: 5000, currency: 'USD' },
  { label: 'In-Person (Outside Africa)', attendance_mode: 'IN_PERSON', audience: 'INTERNATIONAL', amount_minor: 15000, currency: 'USD' },
  { label: 'Virtual', attendance_mode: 'VIRTUAL', audience: 'ANY', amount_minor: 100000, currency: 'GHS' },
  { label: 'In-Person', attendance_mode: 'IN_PERSON', audience: 'ANY', amount_minor: 150000, currency: 'GHS' },
];

const SESSIONS = [
  ['Foundations: from raw data to a question worth asking', 9, 12.5],
  ['Building the analysis: cleaning, joining, and sanity checks', 13.5, 16],
  ['Visualising for decision-makers', 9, 12.5],
  ['Workshop: your own supply chain problem', 13.5, 16],
];

const QUESTIONS = [
  { label: 'What is your organization?', type: 'TEXT', is_required: true, sort_order: 10 },
  {
    label: 'Which best describes your experience with analytics?',
    type: 'RADIO',
    is_required: true,
    sort_order: 20,
    options: [
      { value: 'none', label: 'No prior experience' },
      { value: 'some', label: 'Some spreadsheet work' },
      { value: 'confident', label: 'Confident with data tools' },
    ],
  },
  { label: 'Dietary requirements', type: 'TEXT', is_required: false, sort_order: 30 },
  {
    label: 'What do you most want to take away from this course?',
    type: 'LONGTEXT',
    is_required: false,
    sort_order: 40,
  },
];

async function main() {
  await connect();
  await loadCurrencyExponents(sequelize);

  const { Event, EventType, EventPrice, EventSession, EventSpeaker, RegistrationQuestion, CpdEventDetail } = models;
  const type = await EventType.findOne({ where: { key: 'cpd' } });
  if (!type) throw new Error('CPD event type is missing — run the seeders first.');

  const existing = await Event.findOne({ where: { slug: SLUG }, paranoid: false });
  if (existing) {
    await existing.destroy({ force: true });
    process.stdout.write('Removed the previous demo event.\n');
  }

  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 42);
  start.setUTCHours(9, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  end.setUTCHours(16, 0, 0, 0);

  const event = await Event.create({
    event_type_id: type.id,
    slug: SLUG,
    title: 'Supply Chain Analytics for Decision-Making: From Data to Outcome (Level 2)',
    short_description:
      'A two-day practitioner course on turning supply chain data into decisions leaders '
      + 'will actually act on. Level 2 builds on the fundamentals.',
    description:
      'Most supply chain teams already have more data than they can use. This course is '
      + 'about the harder part: choosing the question, doing the analysis defensibly, and '
      + 'presenting it so that a decision follows.\n\n'
      + 'You will work through real African supply chain cases — distribution in a market '
      + 'with unreliable lead times, stock allocation across regional health facilities, '
      + 'and demand planning where history is thin.\n\n'
      + 'Level 2 assumes you are comfortable with spreadsheets and have seen a dashboard '
      + 'before. It does not assume you can code.',
    start_at: start,
    end_at: end,
    timezone: 'Africa/Accra',
    delivery_mode: 'HYBRID',
    country_code: 'GH',
    city: 'Kumasi',
    venue: 'KNUST School of Business, Postgraduate Block E',
    online_url: 'https://meet.example.test/carisca-cpd-level-2',
    capacity: 45,
    virtual_capacity: 200,
    allow_waitlist: true,
    payment_hold_hours: 72,
    registration_closes_at: new Date(start.getTime() - 5 * 864e5),
    status: 'REGISTRATION_OPEN',
    issues_certificate: true,
    certificate_requires_payment: true,
    attendance_rule: 'SESSION_PERCENT',
    min_attendance_percent: 80,
    contact_email: 'info@carisca.knust.edu.gh',
    published_at: new Date(),
  });

  await CpdEventDetail.create({
    event_id: event.id,
    cpd_credits: 14,
    accrediting_body: 'CARISCA, KNUST School of Business',
    learning_objectives: [
      'Frame a supply chain problem as a question data can answer',
      'Clean and join operational data without losing its meaning',
      'Choose the right chart for the decision being made',
      'Present an analysis so a decision-maker can act on it',
      'Recognise when the data is too thin to support a conclusion',
    ],
    target_audience: [
      'Supply chain and logistics managers',
      'Procurement and operations specialists',
      'Health supply chain officers',
      'Postgraduate students in supply chain or operations',
    ],
    requirements:
      'Bring a laptop with a spreadsheet application installed. No programming experience '
      + 'is required. Completing Level 1 is helpful but not mandatory.',
  });

  await EventPrice.bulkCreate(PRICES.map((p) => ({ ...p, event_id: event.id, tier: 'standard' })));

  await EventSession.bulkCreate(SESSIONS.map(([title, from, to], i) => {
    const day = new Date(start);
    day.setUTCDate(day.getUTCDate() + Math.floor(i / 2));
    const s = new Date(day); s.setUTCHours(Math.floor(from), (from % 1) * 60, 0, 0);
    const e = new Date(day); e.setUTCHours(Math.floor(to), (to % 1) * 60, 0, 0);
    return {
      event_id: event.id,
      title,
      start_at: s,
      end_at: e,
      location: i % 2 === 0 ? 'Block E, Room 1' : 'Block E, Computer Lab',
      is_required_for_attendance: true,
      sort_order: (i + 1) * 10,
    };
  }));

  await EventSpeaker.bulkCreate([
    {
      event_id: event.id,
      name: 'Course facilitator to be confirmed',
      title: 'Facilitator',
      organization: 'CARISCA',
      bio: 'Placeholder for local development — replace before this is shown to anyone.',
      role: 'FACILITATOR',
      sort_order: 10,
    },
  ]);

  await RegistrationQuestion.bulkCreate(QUESTIONS.map((q) => ({ ...q, event_id: event.id })));

  process.stdout.write(
    `\nSeeded demo CPD\n  ${event.title}\n  /events/${event.slug}\n`
    + `  ${PRICES.length} prices, ${SESSIONS.length} sessions, ${QUESTIONS.length} questions\n\n`,
  );

  await disconnect();
}

main().catch(async (err) => {
  process.stderr.write(`${err.stack}\n`);
  await disconnect().catch(() => {});
  process.exit(1);
});
