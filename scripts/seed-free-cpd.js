/**
 * A free CPD, which is what CARISCA's upcoming event actually is.
 *
 * Free registrations confirm immediately — there is no payment hold and no
 * provider involved — so this is the path that has to be right for the event.
 *
 *   node scripts/seed-free-cpd.js
 */
import { connect, disconnect, models, sequelize } from '../src/database/models/index.js';
import { loadCurrencyExponents } from '../src/lib/money.js';

const SLUG = 'introduction-to-supply-chain-analytics-free';

async function main() {
  await connect();
  await loadCurrencyExponents(sequelize);

  const { Event, EventType, EventPrice, RegistrationQuestion, EventSession } = models;
  const type = await EventType.findOne({ where: { key: 'cpd' } });

  const existing = await Event.findOne({ where: { slug: SLUG }, paranoid: false });
  if (existing) await existing.destroy({ force: true });

  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 21);
  start.setUTCHours(9, 0, 0, 0);
  const end = new Date(start.getTime() + 5 * 3600_000);

  const event = await Event.create({
    event_type_id: type.id,
    slug: SLUG,
    title: 'Introduction to Supply Chain Analytics',
    short_description: 'A free half-day introduction for practitioners and students. No cost to attend.',
    description:
      'A practical half day covering what supply chain analytics is for, the questions '
      + 'it can answer, and where teams usually go wrong.\n\n'
      + 'No prior experience is needed and there is no fee. Places are limited, so '
      + 'register early.',
    start_at: start,
    end_at: end,
    timezone: 'Africa/Accra',
    delivery_mode: 'HYBRID',
    country_code: 'GH',
    city: 'Kumasi',
    venue: 'KNUST School of Business, Postgraduate Block E',
    online_url: 'https://meet.example.test/free-cpd',
    capacity: 60,
    virtual_capacity: 300,
    allow_waitlist: true,
    status: 'REGISTRATION_OPEN',
    issues_certificate: true,
    // Nothing to pay, so payment cannot be a condition of the certificate.
    certificate_requires_payment: false,
    attendance_rule: 'CHECK_IN',
    contact_email: 'info@carisca.knust.edu.gh',
    published_at: new Date(),
  });

  // A price row is still required — zero is a price, and publishing validates
  // that one exists so an event can never reach the public unpriced.
  await EventPrice.create({
    event_id: event.id,
    tier: 'standard',
    label: 'Free',
    amount_minor: 0,
    currency: 'GHS',
    is_default: true,
  });

  await EventSession.create({
    event_id: event.id,
    title: 'Introduction to Supply Chain Analytics',
    start_at: start,
    end_at: end,
    location: 'Block E, Room 1',
    is_required_for_attendance: true,
    sort_order: 10,
  });

  await RegistrationQuestion.bulkCreate([
    { event_id: event.id, label: 'What is your organization?', type: 'TEXT', is_required: true, sort_order: 10 },
    {
      event_id: event.id,
      label: 'How did you hear about this event?',
      type: 'SELECT',
      is_required: false,
      sort_order: 20,
      options: [
        { value: 'email', label: 'CARISCA email' },
        { value: 'social', label: 'Social media' },
        { value: 'colleague', label: 'A colleague' },
        { value: 'other', label: 'Somewhere else' },
      ],
    },
  ]);

  process.stdout.write(`\nSeeded free CPD\n  ${event.title}\n  /events/${event.slug}\n  id ${event.id}\n\n`);
  await disconnect();
}

main().catch(async (err) => {
  process.stderr.write(`${err.stack}\n`);
  await disconnect().catch(() => {});
  process.exit(1);
});
