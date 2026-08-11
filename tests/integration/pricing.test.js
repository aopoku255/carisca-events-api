import { jest } from '@jest/globals';
import { prepareDatabase, teardown, models } from '../helpers/setup.js';
import { resolvePrice, audienceFor, chooseCurrency, priceMatrix } from '../../src/core/events/price-resolver.service.js';

jest.setTimeout(60_000);

const { Event, EventType, EventPrice } = models;

/**
 * The fixture is CARISCA's real published CPD pricing:
 *
 *   Virtual                      $25
 *   In-Person (Africa)           $50
 *   In-Person (Outside Africa)  $150
 *   plus the same event in GHS   1000 virtual / 1500 in-person
 *
 * If the resolver can price that correctly for a Ghanaian, a Kenyan and a
 * Briton, it can price anything CARISCA has asked for.
 */
let event;

beforeAll(async () => {
  await prepareDatabase();

  const type = await EventType.findOne({ where: { key: 'cpd' } });
  event = await Event.create({
    event_type_id: type.id,
    slug: `pricing-fixture-${Date.now()}`,
    title: 'Supply Chain Analytics for Decision-Making: From Data to Outcome (Level 2)',
    start_at: new Date('2026-09-01T09:00:00Z'),
    end_at: new Date('2026-09-03T16:00:00Z'),
    timezone: 'Africa/Accra',
    delivery_mode: 'HYBRID',
    country_code: 'GH',
    city: 'Kumasi',
    status: 'REGISTRATION_OPEN',
  });

  await EventPrice.bulkCreate([
    { event_id: event.id, tier: 'standard', label: 'Virtual', attendance_mode: 'VIRTUAL', audience: 'ANY', amount_minor: 2500, currency: 'USD', is_default: true },
    { event_id: event.id, tier: 'standard', label: 'In-Person (Africa)', attendance_mode: 'IN_PERSON', audience: 'AFRICA', amount_minor: 5000, currency: 'USD', is_default: false },
    { event_id: event.id, tier: 'standard', label: 'In-Person (Outside Africa)', attendance_mode: 'IN_PERSON', audience: 'INTERNATIONAL', amount_minor: 15000, currency: 'USD', is_default: false },
    { event_id: event.id, tier: 'standard', label: 'Virtual (Ghana)', attendance_mode: 'VIRTUAL', audience: 'ANY', amount_minor: 100000, currency: 'GHS', is_default: false },
    { event_id: event.id, tier: 'standard', label: 'In-Person (Ghana)', attendance_mode: 'IN_PERSON', audience: 'ANY', amount_minor: 150000, currency: 'GHS', is_default: false },
  ]);
});

afterAll(teardown);

const forParticipant = (overrides) => resolvePrice({
  eventId: event.id,
  eventCountry: 'GH',
  ...overrides,
});

describe('audience banding', () => {
  test.each([
    [{ participantCountry: 'GH', participantRegion: 'Africa', eventCountry: 'GH' }, 'HOST_COUNTRY'],
    [{ participantCountry: 'KE', participantRegion: 'Africa', eventCountry: 'GH' }, 'AFRICA'],
    [{ participantCountry: 'GB', participantRegion: 'Europe', eventCountry: 'GH' }, 'INTERNATIONAL'],
    [{ participantCountry: 'US', participantRegion: 'North America', eventCountry: 'GH' }, 'INTERNATIONAL'],
    [{ participantCountry: null, participantRegion: null, eventCountry: 'GH' }, null],
  ])('%o → %s', (input, expected) => {
    expect(audienceFor(input)).toBe(expected);
  });
});

describe('CARISCA published USD pricing', () => {
  test('virtual attendee pays $25 regardless of where they are', async () => {
    for (const [country, region] of [['GH', 'Africa'], ['KE', 'Africa'], ['GB', 'Europe']]) {
      const r = await forParticipant({
        attendanceMode: 'VIRTUAL',
        participantCountry: country,
        participantRegion: region,
        preferredCurrency: 'USD',
      });
      expect(r.money.formatted).toBe('25.00');
      expect(r.currency).toBe('USD');
    }
  });

  test('in-person African attendee pays $50', async () => {
    const r = await forParticipant({
      attendanceMode: 'IN_PERSON',
      participantCountry: 'KE',
      participantRegion: 'Africa',
      preferredCurrency: 'USD',
    });
    expect(r.money.formatted).toBe('50.00');
    expect(r.price.label).toBe('In-Person (Africa)');
  });

  test('a host-country attendee gets the Africa rate, not the international one', async () => {
    const r = await forParticipant({
      attendanceMode: 'IN_PERSON',
      participantCountry: 'GH',
      participantRegion: 'Africa',
      preferredCurrency: 'USD',
    });
    expect(r.audience).toBe('HOST_COUNTRY');
    expect(r.money.formatted).toBe('50.00');
  });

  test('in-person attendee from outside Africa pays $150', async () => {
    const r = await forParticipant({
      attendanceMode: 'IN_PERSON',
      participantCountry: 'GB',
      participantRegion: 'Europe',
      preferredCurrency: 'USD',
    });
    expect(r.money.formatted).toBe('150.00');
    expect(r.price.label).toBe('In-Person (Outside Africa)');
  });
});

describe('currency selection', () => {
  test('a Ghanaian paying in cedis gets the GHS price list', async () => {
    const r = await forParticipant({
      attendanceMode: 'IN_PERSON',
      participantCountry: 'GH',
      participantRegion: 'Africa',
      countryDefaultCurrency: 'GHS',
    });
    expect(r.currency).toBe('GHS');
    expect(r.money.formatted).toBe('1500.00');
    expect(r.amountMinor).toBe(150000);
  });

  test('virtual in cedis is 1000', async () => {
    const r = await forParticipant({
      attendanceMode: 'VIRTUAL',
      participantCountry: 'GH',
      participantRegion: 'Africa',
      countryDefaultCurrency: 'GHS',
    });
    expect(r.money.formatted).toBe('1000.00');
  });

  test('falls back to the default currency when the requested one is not priced', async () => {
    const r = await forParticipant({
      attendanceMode: 'VIRTUAL',
      participantCountry: 'KE',
      participantRegion: 'Africa',
      countryDefaultCurrency: 'KES', // no KES price exists
    });
    expect(r.currency).toBe('USD');
  });

  test('chooseCurrency prefers the explicit request over the country default', () => {
    const prices = [{ currency: 'USD', is_default: true }, { currency: 'GHS', is_default: false }];
    expect(chooseCurrency(prices, { preferredCurrency: 'GHS', countryDefaultCurrency: 'USD' })).toBe('GHS');
    expect(chooseCurrency(prices, { preferredCurrency: null, countryDefaultCurrency: 'GHS' })).toBe('GHS');
    expect(chooseCurrency(prices, {})).toBe('USD');
  });
});

describe('specificity and safety', () => {
  test('the more specific rule wins over a catch-all', async () => {
    const specific = await forParticipant({
      attendanceMode: 'IN_PERSON',
      participantCountry: 'GB',
      participantRegion: 'Europe',
      preferredCurrency: 'USD',
    });
    // A row naming both mode and audience beats one naming only the mode.
    expect(specific.price.audience).toBe('INTERNATIONAL');
  });

  test('refuses rather than guessing when nothing matches', async () => {
    const empty = await Event.create({
      event_type_id: event.event_type_id,
      slug: `no-price-${Date.now()}`,
      title: 'Unpriced event',
      start_at: new Date(), end_at: new Date(),
      status: 'DRAFT',
    });

    await expect(resolvePrice({ eventId: empty.id })).rejects.toThrow(/No price is configured/);
  });

  test('an unknown location can still be priced by a catch-all row', async () => {
    const r = await forParticipant({
      attendanceMode: 'IN_PERSON',
      participantCountry: null,
      participantRegion: null,
      countryDefaultCurrency: 'GHS',
    });
    // The GHS in-person row has audience ANY, so it applies.
    expect(r.currency).toBe('GHS');
    expect(r.money.formatted).toBe('1500.00');
  });

  test('an unknown location with only geography-scoped rows is refused', async () => {
    await expect(forParticipant({
      attendanceMode: 'IN_PERSON',
      participantCountry: null,
      participantRegion: null,
      preferredCurrency: 'USD', // USD in-person rows are all geography-scoped
    })).rejects.toThrow(/No price matches/);
  });

  test('expired price windows are ignored', async () => {
    const windowed = await Event.create({
      event_type_id: event.event_type_id,
      slug: `windowed-${Date.now()}`,
      title: 'Early bird event',
      start_at: new Date(), end_at: new Date(),
      status: 'REGISTRATION_OPEN',
    });
    await EventPrice.bulkCreate([
      {
        event_id: windowed.id, tier: 'early_bird', label: 'Early bird',
        amount_minor: 1000, currency: 'USD', is_default: false,
        available_until: new Date('2020-01-01T00:00:00Z'),
      },
      {
        event_id: windowed.id, tier: 'standard', label: 'Standard',
        amount_minor: 5000, currency: 'USD', is_default: true,
      },
    ]);

    const r = await resolvePrice({ eventId: windowed.id, preferredCurrency: 'USD' });
    expect(r.tier).toBe('standard');
    expect(r.money.formatted).toBe('50.00');
  });

  test('an ambiguous configuration favours the participant', async () => {
    const ambiguous = await Event.create({
      event_type_id: event.event_type_id,
      slug: `ambiguous-${Date.now()}`,
      title: 'Two equally specific prices',
      start_at: new Date(), end_at: new Date(),
      status: 'REGISTRATION_OPEN',
    });
    await EventPrice.bulkCreate([
      { event_id: ambiguous.id, tier: 'a', label: 'A', amount_minor: 9000, currency: 'USD', priority: 100, is_default: true },
      { event_id: ambiguous.id, tier: 'b', label: 'B', amount_minor: 4000, currency: 'USD', priority: 100, is_default: false },
    ]);

    const r = await resolvePrice({ eventId: ambiguous.id, preferredCurrency: 'USD' });
    // Never overcharge because a configuration was ambiguous.
    expect(r.money.formatted).toBe('40.00');
  });
});

describe('the public price matrix', () => {
  test('lists every rate with its conditions', async () => {
    const matrix = await priceMatrix(event.id);
    expect(matrix).toHaveLength(5);

    const usdInPerson = matrix.filter((m) => m.money.currency === 'USD' && m.attendanceMode === 'IN_PERSON');
    expect(usdInPerson.map((m) => m.money.formatted).sort()).toEqual(['150.00', '50.00']);
  });
});

describe('participant vocabularies', () => {
  test('CARISCA\'s 16 positions and 6 sectors are available', async () => {
    expect(await models.Position.count({ where: { is_active: true } })).toBe(16);
    expect(await models.Sector.count({ where: { is_active: true } })).toBe(6);
  });

  test('the student ID upload rule is data, not a hard-coded string match', async () => {
    const needsEvidence = await models.Position.findAll({ where: { requires_student_id: true } });
    expect(needsEvidence).toHaveLength(1);
    expect(needsEvidence[0].key).toBe('student');
  });

  test('continent is derived from the country rather than asked twice', async () => {
    const gh = await models.Country.findByPk('GH');
    const gb = await models.Country.findByPk('GB');
    expect(gh.region).toBe('Africa');
    expect(gb.region).toBe('Europe');
    expect(await models.Country.count({ where: { region: 'Africa' } })).toBe(37);
  });
});
