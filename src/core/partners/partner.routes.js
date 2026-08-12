import { Router } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import { models } from '../../database/models/index.js';
import { serialiseFile } from '../files/storage.service.js';
import { slugify } from '../../lib/ids.js';
import { ok, created, paginated } from '../../lib/response.js';
import { offsetFor, pageMeta } from '../../lib/pagination.js';
import { validate } from '../../middleware/validate.js';
import {
  authenticate, requireStaff, loadPermissions, requirePermission,
} from '../../middleware/authenticate.js';
import { record as audit } from '../audit/audit.service.js';
import { AppError, NotFoundError } from '../../lib/errors.js';

const { Partner, EventPartner, File, Country } = models;

/**
 * The partner library.
 *
 * Partners live once and attach to many events — CARISCA works with the same
 * institutions repeatedly, and a per-event list would leave several slightly
 * different versions of the same logo in circulation.
 */
const router = Router();

router.use(authenticate, requireStaff, loadPermissions);

const contextOf = (req) => ({ ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id });
const actorOf = (req) => ({ id: req.user.id, email: req.user.email });

const WITH_REFS = [
  { model: File, as: 'logo' },
  { model: Country, as: 'country' },
];

export function serialisePartner(partner, { eventRole = null } = {}) {
  if (!partner) return null;
  return {
    id: String(partner.id),
    name: partner.name,
    shortName: partner.short_name ?? null,
    slug: partner.slug,
    description: partner.description ?? null,
    websiteUrl: partner.website_url ?? null,
    logo: serialiseFile(partner.logo),
    country: partner.country
      ? { code: partner.country.iso2, name: partner.country.name }
      : null,
    isActive: !!partner.is_active,
    // Present when read through an event, absent from the library listing.
    role: eventRole ?? partner.EventPartner?.role ?? undefined,
  };
}

const partnerBody = z.object({
  name: z.string().trim().min(2).max(180),
  shortName: z.string().trim().max(80).nullish(),
  description: z.string().trim().max(1000).nullish(),
  websiteUrl: z.string().url().max(500).nullish().or(z.literal('')),
  logoFileId: z.coerce.number().int().positive().nullish(),
  countryCode: z.string().trim().length(2).toUpperCase().nullish(),
  isActive: z.boolean().default(true),
});

async function uniqueSlug(name, excludeId = null) {
  const base = slugify(name).slice(0, 180);
  for (let i = 0; i < 20; i += 1) {
    const candidate = i === 0 ? base : `${base}-${i}`;
    // eslint-disable-next-line no-await-in-loop
    const clash = await Partner.findOne({
      where: excludeId ? { slug: candidate, id: { [Op.ne]: excludeId } } : { slug: candidate },
      paranoid: false,
    });
    if (!clash) return candidate;
  }
  throw new AppError('Could not generate a unique slug for this partner.', { code: 'SLUG_EXHAUSTED' });
}

const toColumns = (b) => ({
  name: b.name,
  short_name: b.shortName || null,
  description: b.description || null,
  website_url: b.websiteUrl || null,
  logo_file_id: b.logoFileId ?? null,
  country_code: b.countryCode || null,
  is_active: b.isActive,
});

// --- the library --------------------------------------------------------------
router.get('/',
  requirePermission('partners.view'),
  validate({
    query: z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      q: z.string().trim().max(120).optional(),
      activeOnly: z.coerce.boolean().default(false),
    }),
  }),
  async (req, res, next) => {
    try {
      const { page, limit, q, activeOnly } = req.validatedQuery;

      const where = {};
      if (activeOnly) where.is_active = true;
      if (q) {
        where[Op.or] = [
          { name: { [Op.like]: `%${q}%` } },
          { short_name: { [Op.like]: `%${q}%` } },
        ];
      }

      const { rows, count } = await Partner.findAndCountAll({
        where,
        include: WITH_REFS,
        order: [['name', 'ASC']],
        ...offsetFor({ page, limit }),
        distinct: true,
      });

      return paginated(res, rows.map((p) => serialisePartner(p)), pageMeta({ page, limit }, count));
    } catch (err) {
      return next(err);
    }
  });

router.post('/',
  requirePermission('partners.manage'),
  validate({ body: partnerBody }),
  async (req, res, next) => {
    try {
      const partner = await Partner.create({
        ...toColumns(req.body),
        slug: await uniqueSlug(req.body.name),
        created_by: req.user.id,
      });
      await partner.reload({ include: WITH_REFS });

      await audit({
        actor: actorOf(req),
        action: 'partner.created',
        resourceType: 'partner',
        resourceId: partner.id,
        after: { name: partner.name },
        context: contextOf(req),
      });

      return created(res, serialisePartner(partner), `${partner.name} added.`);
    } catch (err) {
      return next(err);
    }
  });

router.patch('/:id',
  requirePermission('partners.manage'),
  validate({ params: z.object({ id: z.coerce.number().int().positive() }), body: partnerBody.partial() }),
  async (req, res, next) => {
    try {
      const partner = await Partner.findByPk(req.params.id, { include: WITH_REFS });
      if (!partner) throw new NotFoundError('Partner');

      const before = serialisePartner(partner);
      const patch = {};
      for (const [k, v] of Object.entries(toColumns(req.body))) {
        if (req.body[
          { name: 'name', short_name: 'shortName', description: 'description',
            website_url: 'websiteUrl', logo_file_id: 'logoFileId',
            country_code: 'countryCode', is_active: 'isActive' }[k]
        ] !== undefined) patch[k] = v;
      }
      // Renaming keeps the slug stable — it is referenced in saved links.
      await partner.update(patch);
      await partner.reload({ include: WITH_REFS });

      await audit({
        actor: actorOf(req),
        action: 'partner.updated',
        resourceType: 'partner',
        resourceId: partner.id,
        before,
        after: serialisePartner(partner),
        context: contextOf(req),
      });

      return ok(res, serialisePartner(partner), 'Saved.');
    } catch (err) {
      return next(err);
    }
  });

router.delete('/:id',
  requirePermission('partners.manage'),
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  async (req, res, next) => {
    try {
      const partner = await Partner.findByPk(req.params.id);
      if (!partner) throw new NotFoundError('Partner');

      // Removing a partner still credited on an event would rewrite the record
      // of who ran it. Deactivating hides it from the picker instead.
      const attached = await EventPartner.count({ where: { partner_id: partner.id } });
      if (attached > 0) {
        throw new AppError(
          `${partner.name} is credited on ${attached} event${attached === 1 ? '' : 's'} and cannot be deleted. Mark it inactive instead.`,
          { status: 409, code: 'PARTNER_IN_USE', details: { events: attached } },
        );
      }

      await audit({
        actor: actorOf(req),
        action: 'partner.deleted',
        resourceType: 'partner',
        resourceId: partner.id,
        before: { name: partner.name },
        context: contextOf(req),
      });
      await partner.destroy();

      return ok(res, null, `${partner.name} removed.`);
    } catch (err) {
      return next(err);
    }
  });

export default router;
