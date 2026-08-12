import { Router } from 'express';
import { z } from 'zod';
import { models } from '../../database/models/index.js';
import { serialiseUser } from './user.serialiser.js';
import { ok } from '../../lib/response.js';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { record as audit } from '../audit/audit.service.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';

const { User, Position, Sector, Country } = models;

/**
 * Self-service profile.
 *
 * Separate from /admin/users on purpose: this route can only ever act on the
 * caller's own record, so there is no id to get wrong and no permission that
 * could widen it. Administrative user management stays behind users.* in the
 * admin module.
 */
const router = Router();

const WITH_REFS = [
  { model: Position, as: 'position' },
  { model: Sector, as: 'sector' },
  { model: Country, as: 'country' },
];

const profileSchema = z.object({
  prefix: z.string().trim().max(16).nullish(),
  firstName: z.string().trim().min(1).max(80).optional(),
  middleName: z.string().trim().max(80).nullish(),
  lastName: z.string().trim().min(1).max(80).optional(),
  suffix: z.string().trim().max(16).nullish(),
  gender: z.string().trim().max(32).nullish(),
  phone: z.string().trim().max(32).nullish(),
  organization: z.string().trim().max(160).nullish(),
  jobTitle: z.string().trim().max(160).nullish(),
  positionKey: z.string().trim().max(64).nullish(),
  sectorKey: z.string().trim().max(64).nullish(),
  countryCode: z.string().trim().length(2).toUpperCase().nullish(),
  city: z.string().trim().max(120).nullish(),
  stateProvince: z.string().trim().max(120).nullish(),
  timezone: z.string().trim().max(64).nullish(),
  emailOptOut: z.boolean().optional(),
}).strict();

// Email is deliberately absent: changing it has to re-verify, which is its own
// flow rather than a field on this form.

const COLUMN = {
  prefix: 'prefix',
  firstName: 'first_name',
  middleName: 'middle_name',
  lastName: 'last_name',
  suffix: 'suffix',
  gender: 'gender',
  phone: 'phone',
  organization: 'organization',
  jobTitle: 'job_title',
  countryCode: 'country_code',
  city: 'city',
  stateProvince: 'state_province',
  timezone: 'timezone',
};

router.get('/me', authenticate, async (req, res, next) => {
  try {
    const user = await User.findByPk(req.user.id, { include: WITH_REFS });
    if (!user) throw new NotFoundError('User');
    return ok(res, serialiseUser(user));
  } catch (err) {
    return next(err);
  }
});

router.patch('/me',
  authenticate,
  validate({ body: profileSchema }),
  async (req, res, next) => {
    try {
      const user = await User.findByPk(req.user.id, { include: WITH_REFS });
      if (!user) throw new NotFoundError('User');

      const before = serialiseUser(user);
      const patch = {};

      for (const [field, column] of Object.entries(COLUMN)) {
        if (req.body[field] !== undefined) patch[column] = req.body[field] || null;
      }

      // Vocabularies are referenced by key so the client never has to know
      // database ids, and an unknown key is an error rather than a silent null.
      if (req.body.positionKey !== undefined) {
        if (!req.body.positionKey) patch.position_id = null;
        else {
          const position = await Position.findOne({ where: { key: req.body.positionKey, is_active: true } });
          if (!position) throw new ValidationError([{ field: 'positionKey', message: 'Unknown position.' }]);
          patch.position_id = position.id;
        }
      }

      if (req.body.sectorKey !== undefined) {
        if (!req.body.sectorKey) patch.sector_id = null;
        else {
          const sector = await Sector.findOne({ where: { key: req.body.sectorKey, is_active: true } });
          if (!sector) throw new ValidationError([{ field: 'sectorKey', message: 'Unknown sector.' }]);
          patch.sector_id = sector.id;
        }
      }

      if (req.body.countryCode) {
        const country = await Country.findByPk(req.body.countryCode);
        if (!country) throw new ValidationError([{ field: 'countryCode', message: 'Unknown country.' }]);
      }

      if (req.body.emailOptOut !== undefined) {
        patch.email_opt_out = req.body.emailOptOut;
        // Timestamped so the choice is evidenced rather than merely current.
        patch.email_preference_set_at = new Date();
      }

      await user.update(patch);
      await user.reload({ include: WITH_REFS });

      await audit({
        actor: { id: user.id, email: user.email },
        action: 'user.profile_updated',
        resourceType: 'user',
        resourceId: user.id,
        before,
        after: serialiseUser(user),
        context: { ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id },
      });

      return ok(res, serialiseUser(user), 'Your details have been saved.');
    } catch (err) {
      return next(err);
    }
  });

export default router;
