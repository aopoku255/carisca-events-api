import { Router } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import { models } from '../../database/models/index.js';
import * as eventService from './event.service.js';
import { serialisePublicEvent } from './event.serialiser.js';
import { PUBLIC_STATUSES } from './event-state-machine.js';
import { ok, paginated } from '../../lib/response.js';
import { offsetFor, searchAcross, pageMeta } from '../../lib/pagination.js';
import { validate } from '../../middleware/validate.js';

const { Event, EventType, Country, Position, Sector } = models;

/**
 * Public discovery. No authentication: these are the pages that need to be
 * indexable and shareable. Only events in a public status are ever returned,
 * and the serialiser withholds anything operational.
 */
const router = Router();

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  q: z.string().trim().max(200).optional(),
  type: z.string().trim().max(48).optional(),
  countryCode: z.string().trim().length(2).toUpperCase().optional(),
  deliveryMode: z.enum(['ONLINE', 'OFFLINE', 'HYBRID']).optional(),
  when: z.enum(['upcoming', 'past', 'all']).default('upcoming'),
});

router.get('/events',
  validate({ query: listSchema }),
  async (req, res, next) => {
    try {
      const { page, limit, q, type, countryCode, deliveryMode, when } = req.validatedQuery;

      const where = { status: { [Op.in]: PUBLIC_STATUSES } };
      if (countryCode) where.country_code = countryCode;
      if (deliveryMode) where.delivery_mode = deliveryMode;
      if (when === 'upcoming') where.end_at = { [Op.gte]: new Date() };
      if (when === 'past') where.end_at = { [Op.lt]: new Date() };

      const search = searchAcross(q, ['title', 'short_description', 'city', 'venue']);

      const { rows, count } = await Event.findAndCountAll({
        where: search ? { ...where, ...search } : where,
        include: [
          { model: EventType, as: 'type', ...(type ? { where: { key: type } } : {}) },
          { model: models.EventPrice, as: 'prices' },
          { model: Country, as: 'country' },
        ],
        order: [['start_at', when === 'past' ? 'DESC' : 'ASC']],
        ...offsetFor({ page, limit }),
        distinct: true,
      });

      return paginated(
        res,
        rows.map((e) => serialisePublicEvent(e)),
        pageMeta({ page, limit }, count),
      );
    } catch (err) {
      return next(err);
    }
  });

router.get('/events/:slug',
  validate({ params: z.object({ slug: z.string().trim().min(1).max(180) }) }),
  async (req, res, next) => {
    try {
      const event = await eventService.findPublicBySlug(req.params.slug);
      const [inPerson, virtual] = await Promise.all([
        eventService.capacityStatus(event, 'IN_PERSON'),
        eventService.capacityStatus(event, 'VIRTUAL'),
      ]);
      return ok(res, serialisePublicEvent(event, { capacity: { inPerson, virtual } }));
    } catch (err) {
      return next(err);
    }
  });

/**
 * Reference data the registration form needs. Public so the form can render
 * before the participant has an account.
 */
router.get('/reference', async (req, res, next) => {
  try {
    const [countries, positions, sectors, currencies] = await Promise.all([
      Country.findAll({
        where: { is_active: true },
        attributes: ['iso2', 'name', 'phone_code', 'region', 'default_currency'],
        order: [['name', 'ASC']],
      }),
      Position.findAll({ where: { is_active: true }, order: [['sort_order', 'ASC']] }),
      Sector.findAll({ where: { is_active: true }, order: [['sort_order', 'ASC']] }),
      models.Currency.findAll({ where: { is_active: true }, order: [['code', 'ASC']] }),
    ]);

    return ok(res, {
      countries: countries.map((c) => ({
        code: c.iso2, name: c.name, phoneCode: c.phone_code,
        region: c.region, defaultCurrency: c.default_currency,
      })),
      positions: positions.map((p) => ({
        key: p.key, label: p.label, requiresStudentId: !!p.requires_student_id,
      })),
      sectors: sectors.map((s) => ({ key: s.key, label: s.label })),
      currencies: currencies.map((c) => ({
        code: c.code, name: c.name, symbol: c.symbol, exponent: c.exponent,
      })),
      // Suggestions, not an enum — the column is free text so this list can
      // grow without a migration.
      genders: ['Male', 'Female', 'Other', 'Prefer not to say'],
      prefixes: ['Dr.', 'Prof.', 'Mr.', 'Mrs.', 'Ms.'],
      suffixes: ['Jr.', 'Sr.', 'II', 'III'],
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
