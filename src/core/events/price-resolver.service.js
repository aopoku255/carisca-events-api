import { QueryTypes } from 'sequelize';
import { sequelize } from '../../database/models/index.js';
import { AppError, NotFoundError } from '../../lib/errors.js';
import { serialiseMoney } from '../../lib/money.js';

/**
 * Works out what a given participant pays for a given event.
 *
 * CARISCA's live CPD prices one event three ways at once:
 *
 *     Virtual                      $25
 *     In-Person, Africa            $50
 *     In-Person, outside Africa   $150
 *
 * plus the same event quoted in GHS for local participants. Rather than encode
 * that as conditionals, each price row carries the conditions under which it
 * applies and the most specific match wins. Adding an early-bird or student
 * rate is then a row, not a release.
 */

const MODE_ANY = 'ANY';
const AUDIENCE_ANY = 'ANY';

/**
 * How specific a row is. A row naming both the attendance mode and the
 * audience beats one naming only the mode, which beats a catch-all.
 */
function specificity(row) {
  return (row.attendance_mode === MODE_ANY ? 0 : 2)
       + (row.audience === AUDIENCE_ANY ? 0 : 1);
}

/** Which geographic band a participant falls into for this event. */
export function audienceFor({ participantCountry, participantRegion, eventCountry }) {
  if (participantCountry && eventCountry && participantCountry === eventCountry) return 'HOST_COUNTRY';
  if (participantRegion === 'Africa') return 'AFRICA';
  if (participantRegion) return 'INTERNATIONAL';
  return null; // unknown location — only catch-all rows can apply
}

function matches(row, { attendanceMode, audience }) {
  const modeOk = row.attendance_mode === MODE_ANY || row.attendance_mode === attendanceMode;

  if (!modeOk) return false;
  if (row.audience === AUDIENCE_ANY) return true;
  if (!audience) return false;

  // HOST_COUNTRY participants are also in AFRICA when the event is African;
  // a row targeting the wider band still applies to them if no tighter row
  // exists, which is what makes "In-Person (Africa) $50" cover Ghanaians.
  if (row.audience === audience) return true;
  if (row.audience === 'AFRICA' && audience === 'HOST_COUNTRY') return true;

  return false;
}

/**
 * Which currency should this participant be billed in?
 *
 * Their own country's currency if the event is priced in it, otherwise the
 * event's default. Nothing here assumes GHS.
 */
export function chooseCurrency(prices, { preferredCurrency, countryDefaultCurrency }) {
  const available = new Set(prices.map((p) => p.currency));
  for (const candidate of [preferredCurrency, countryDefaultCurrency]) {
    if (candidate && available.has(String(candidate).toUpperCase())) {
      return String(candidate).toUpperCase();
    }
  }
  const fallback = prices.find((p) => p.is_default) || prices[0];
  return fallback ? fallback.currency : null;
}

export async function loadPrices(eventId, { transaction = null } = {}) {
  return sequelize.query(
    `SELECT p.id, p.event_id, p.tier, p.label, p.amount_minor, p.currency,
            p.attendance_mode, p.audience, p.priority, p.is_default,
            p.available_from, p.available_until
       FROM event_prices p
      WHERE p.event_id = :eventId
        AND p.deleted_at IS NULL`,
    { replacements: { eventId }, type: QueryTypes.SELECT, transaction },
  );
}

/**
 * @returns {{ price, amountMinor, currency, tier, money, candidates }}
 * @throws  {NotFoundError} when nothing matches — better than silently
 *          charging zero, which is how people get in for free by accident.
 */
export async function resolvePrice({
  eventId,
  attendanceMode = 'IN_PERSON',
  participantCountry = null,
  participantRegion = null,
  eventCountry = null,
  preferredCurrency = null,
  countryDefaultCurrency = null,
  tier = null,
  at = new Date(),
  transaction = null,
}) {
  const all = await loadPrices(eventId, { transaction });
  if (!all.length) {
    throw new NotFoundError(`No price is configured for event ${eventId}`);
  }

  const withinWindow = all.filter((p) => {
    if (p.available_from && new Date(p.available_from) > at) return false;
    if (p.available_until && new Date(p.available_until) < at) return false;
    return true;
  });

  if (!withinWindow.length) {
    throw new AppError('No price is currently available for this event.', {
      status: 409,
      code: 'NO_ACTIVE_PRICE',
    });
  }

  const currency = chooseCurrency(withinWindow, { preferredCurrency, countryDefaultCurrency });
  const audience = audienceFor({ participantCountry, participantRegion, eventCountry });

  const candidates = withinWindow
    .filter((p) => p.currency === currency)
    .filter((p) => (tier ? p.tier === tier : true))
    .filter((p) => matches(p, { attendanceMode, audience }));

  if (!candidates.length) {
    throw new AppError(
      'No price matches this combination of attendance type and location.',
      {
        status: 409,
        code: 'NO_MATCHING_PRICE',
        details: { attendanceMode, audience, currency, tier },
      },
    );
  }

  // Most specific first; then explicit priority; then the cheaper rate, so an
  // ambiguous configuration never overcharges a participant.
  candidates.sort((a, b) => (
    specificity(b) - specificity(a)
    || a.priority - b.priority
    || Number(a.amount_minor) - Number(b.amount_minor)
  ));

  const chosen = candidates[0];

  return {
    price: chosen,
    amountMinor: Number(chosen.amount_minor),
    currency: chosen.currency,
    tier: chosen.tier,
    audience,
    money: serialiseMoney(chosen.amount_minor, chosen.currency),
    candidates: candidates.length,
  };
}

/** Every price for an event, for the public "what will this cost me" table. */
export async function priceMatrix(eventId) {
  const prices = await loadPrices(eventId);
  return prices.map((p) => ({
    id: String(p.id),
    tier: p.tier,
    label: p.label,
    attendanceMode: p.attendance_mode,
    audience: p.audience,
    money: serialiseMoney(p.amount_minor, p.currency),
    availableFrom: p.available_from,
    availableUntil: p.available_until,
  }));
}

export default { resolvePrice, priceMatrix, audienceFor, chooseCurrency, loadPrices };
