import { Router } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import { models } from '../../database/models/index.js';
import * as registrationService from './registration.service.js';
import * as eventService from '../events/event.service.js';
import { generateCertificate, certificateEligibility } from '../certificates/certificate.service.js';
import { resolvePrice } from '../events/price-resolver.service.js';
import { serialiseRegistration } from '../events/event.serialiser.js';
import { ok, created, paginated } from '../../lib/response.js';
import { paginationSchema, resolveOrder, offsetFor, pageMeta } from '../../lib/pagination.js';
import { validate } from '../../middleware/validate.js';
import {
  authenticate, loadPermissions, requirePermission,
} from '../../middleware/authenticate.js';
import { AuthorizationError, NotFoundError } from '../../lib/errors.js';
import { toCsv, exportFilename, sendCsv } from '../../lib/csv.js';
import { record as audit } from '../audit/audit.service.js';

const {
  Registration, Event, User, Country, RegistrationAnswer, RegistrationQuestion, CpdEventDetail,
} = models;

const router = Router();

const contextOf = (req) => ({ ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id });

const registerSchema = z.object({
  eventId: z.coerce.number().int().positive(),
  attendanceMode: z.enum(['IN_PERSON', 'VIRTUAL']).default('IN_PERSON'),
  // Keyed by question id; validated server-side against the event's questions.
  answers: z.record(z.string(), z.any()).default({}),
  comments: z.string().trim().max(5000).optional(),
  specialRequirements: z.string().trim().max(1000).optional(),
  wantsCertificate: z.boolean().optional(),
  isPreviousAttendee: z.boolean().optional(),
  mediaConsent: z.boolean().default(false),
  evidenceFileId: z.coerce.number().int().positive().optional(),
  preferredCurrency: z.string().trim().length(3).toUpperCase().optional(),
});

// --- quote -------------------------------------------------------------------
/**
 * What will this cost me? Exposed separately so the registration form can show
 * a price the moment someone picks in-person or virtual, without creating
 * anything or holding a seat.
 */
router.get('/quote',
  authenticate,
  validate({
    query: z.object({
      eventId: z.coerce.number().int().positive(),
      attendanceMode: z.enum(['IN_PERSON', 'VIRTUAL']).default('IN_PERSON'),
      currency: z.string().trim().length(3).toUpperCase().optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const { eventId, attendanceMode, currency } = req.validatedQuery;
      const event = await eventService.findById(eventId, { includeDetail: false });
      const country = req.user.country_code ? await Country.findByPk(req.user.country_code) : null;

      const price = await resolvePrice({
        eventId,
        attendanceMode,
        participantCountry: req.user.country_code,
        participantRegion: country?.region ?? null,
        eventCountry: event.country_code,
        preferredCurrency: currency,
        countryDefaultCurrency: country?.default_currency ?? null,
      });

      const capacity = await eventService.capacityStatus(event, attendanceMode);

      return ok(res, {
        eventId: String(eventId),
        attendanceMode,
        amount: price.money,
        tier: price.tier,
        label: price.price.label,
        audience: price.audience,
        isFree: price.amountMinor === 0,
        isFull: capacity.isFull,
        waitlistAvailable: capacity.isFull && !!event.allow_waitlist,
      });
    } catch (err) {
      return next(err);
    }
  });

// --- register ----------------------------------------------------------------
router.post('/',
  authenticate,
  validate({ body: registerSchema }),
  async (req, res, next) => {
    try {
      const { registration, price, status } = await registrationService.register({
        ...req.body,
        user: req.user,
      }, { context: contextOf(req) });

      const message = status === 'CONFIRMED'
        ? 'You are registered. A confirmation email is on its way.'
        : status === 'WAITLISTED'
          ? 'You are on the waitlist. We will email you if a place opens up.'
          : 'Registration received. Complete payment to secure your place.';

      const full = await Registration.findByPk(registration.id, {
        include: [{ model: Event, as: 'event' }],
      });

      return created(res, {
        registration: serialiseRegistration(full),
        payment: price.amountMinor === 0 ? null : {
          required: true,
          amount: price.money,
          dueBy: registration.hold_expires_at,
        },
      }, message);
    } catch (err) {
      return next(err);
    }
  });

// --- the participant's own registrations --------------------------------------
router.get('/mine',
  authenticate,
  validate({ query: z.object({ status: z.string().trim().max(32).optional() }) }),
  async (req, res, next) => {
    try {
      const registrations = await registrationService.findForUser(req.user.id, {
        status: req.validatedQuery.status,
      });
      return ok(res, registrations.map((r) => serialiseRegistration(r)));
    } catch (err) {
      return next(err);
    }
  });

// --- export ------------------------------------------------------------------
/**
 * The participant list as a spreadsheet.
 *
 * Its own permission (`.export`) rather than riding on `.view`: reading one
 * registration on screen and walking out with every participant's contact
 * details are different acts, and only the second needs an audit trail.
 */
router.get('/export',
  authenticate,
  loadPermissions,
  requirePermission('cpd.registration.export'),
  validate({
    query: z.object({
      eventId: z.coerce.number().int().positive(),
      status: z.string().trim().max(64).optional(),
      attendanceMode: z.enum(['IN_PERSON', 'VIRTUAL']).optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const { eventId, status, attendanceMode } = req.validatedQuery;

      const event = await eventService.findById(eventId, { includeDetail: false });

      const where = { event_id: eventId };
      if (status) where.status = { [Op.in]: status.split(',').map((s) => s.trim().toUpperCase()) };
      if (attendanceMode) where.attendance_mode = attendanceMode;

      const registrations = await Registration.findAll({
        where,
        include: [
          { model: User, as: 'user', include: [{ model: models.Position, as: 'position' }, { model: models.Sector, as: 'sector' }, { model: Country, as: 'country' }] },
          { model: RegistrationAnswer, as: 'answers', include: [{ model: RegistrationQuestion, as: 'question' }] },
        ],
        order: [['created_at', 'ASC']],
      });

      // The event's own questions become columns, so a bespoke form still
      // exports as a flat sheet rather than a JSON blob in one cell.
      const questions = await RegistrationQuestion.findAll({
        where: { event_id: eventId },
        order: [['sort_order', 'ASC']],
      });

      const answerFor = (registration, questionId) => registration.answers
        ?.find((a) => String(a.question_id) === String(questionId))?.value ?? '';

      const columns = [
        { header: 'Reference', map: (r) => r.reference },
        { header: 'Status', map: (r) => r.status },
        { header: 'Attending', map: (r) => (r.attendance_mode === 'VIRTUAL' ? 'Online' : 'In person') },
        { header: 'Title', map: (r) => r.user?.prefix ?? '' },
        { header: 'First name', map: (r) => r.user?.first_name ?? '' },
        { header: 'Last name', map: (r) => r.user?.last_name ?? '' },
        { header: 'Email', map: (r) => r.user?.email ?? '' },
        { header: 'Phone', map: (r) => r.user?.phone ?? '' },
        { header: 'Gender', map: (r) => r.user?.gender ?? '' },
        { header: 'Organization', map: (r) => r.user?.organization ?? '' },
        { header: 'Position', map: (r) => r.user?.position?.label ?? '' },
        { header: 'Sector', map: (r) => r.user?.sector?.label ?? '' },
        { header: 'City', map: (r) => r.user?.city ?? '' },
        { header: 'State/Province', map: (r) => r.user?.state_province ?? '' },
        { header: 'Country', map: (r) => r.user?.country?.name ?? r.user?.country_code ?? '' },
        { header: 'Region', map: (r) => r.user?.country?.region ?? '' },
        { header: 'Fee', map: (r) => (r.currency ? `${r.currency} ${(Number(r.price_amount_minor) / 100).toFixed(2)}` : '') },
        { header: 'Certificate wanted', map: (r) => (r.wants_certificate === null ? '' : r.wants_certificate ? 'Yes' : 'No') },
        { header: 'Attended before', map: (r) => (r.is_previous_attendee === null ? '' : r.is_previous_attendee ? 'Yes' : 'No') },
        { header: 'Consented to recording', map: (r) => (r.media_consent_at ? 'Yes' : 'No') },
        { header: 'Accessibility/dietary', map: (r) => r.special_requirements ?? '' },
        { header: 'Comments', map: (r) => r.comments ?? '' },
        { header: 'Registered at', map: (r) => r.created_at?.toISOString() ?? '' },
        { header: 'Confirmed at', map: (r) => r.confirmed_at?.toISOString() ?? '' },
        ...questions.map((q) => ({
          header: q.label,
          map: (r) => answerFor(r, q.id),
        })),
      ];

      const csv = toCsv(columns, registrations);

      // Exporting participant data is exactly the kind of act the audit log
      // exists for: who took a copy of what, and when.
      await audit({
        actor: { id: req.user.id, email: req.user.email },
        action: 'registration.exported',
        resourceType: 'event',
        resourceId: eventId,
        metadata: { rows: registrations.length, status: status ?? 'all', attendanceMode: attendanceMode ?? 'all' },
        context: { ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id },
      });

      return sendCsv(res, exportFilename(`${event.slug}-registrations`), csv);
    } catch (err) {
      return next(err);
    }
  });

/**
 * Ownership is checked here rather than by a permission. No permission grants
 * a way past it: a staff member needs cpd.registration.view to see someone
 * else's registration, and being staff alone is not enough.
 */
async function loadOwnedRegistration(req, res, next) {
  try {
    const registration = await Registration.findOne({
      where: { reference: req.params.reference },
      include: [
        { model: Event, as: 'event', include: [{ model: CpdEventDetail, as: 'cpd' }] },
        { model: User, as: 'user' },
        { model: User, as: 'waivedByUser' },
        {
          model: RegistrationAnswer,
          as: 'answers',
          include: [{ model: RegistrationQuestion, as: 'question' }],
        },
      ],
    });
    if (!registration) throw new NotFoundError('Registration');

    const isOwner = String(registration.user_id) === String(req.user.id);
    if (!isOwner) {
      const permissions = req.permissions || await import('../rbac/rbac.service.js')
        .then((m) => m.getPermissions(req.user.id));
      if (!permissions.has('cpd.registration.view')) {
        throw new AuthorizationError('You do not have access to this registration.');
      }
    }

    // Which staff member granted a waiver is an internal detail — visible to
    // the staff who share this permission, not to the participant looking at
    // their own record, even though the reason and the amount itself are.
    req.viewerIsStaff = !isOwner;
    req.registration = registration;
    return next();
  } catch (err) {
    return next(err);
  }
}

router.get('/:reference',
  authenticate,
  validate({ params: z.object({ reference: z.string().trim().min(1).max(48) }) }),
  loadOwnedRegistration,
  async (req, res, next) => {
    try {
      const data = serialiseRegistration(req.registration, {
        includeAnswers: true, includeWaiver: req.viewerIsStaff,
      });
      data.certificate = certificateEligibility(req.registration);
      return ok(res, data);
    } catch (err) {
      return next(err);
    }
  });

/**
 * The certificate itself, rendered on demand rather than generated and
 * stored ahead of time — nothing here changes between requests except the
 * registration's own eligibility, so there is no cache to keep correct.
 */
router.get('/:reference/certificate',
  authenticate,
  validate({
    params: z.object({ reference: z.string().trim().min(1).max(48) }),
    query: z.object({ format: z.enum(['pdf', 'png']).default('pdf') }),
  }),
  loadOwnedRegistration,
  async (req, res, next) => {
    try {
      const { buffer, contentType, filename } = await generateCertificate(
        req.registration,
        { format: req.validatedQuery.format },
      );
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', buffer.length);
      // end(), not send(): Express appends "; charset=utf-8" to a
      // Content-Type it set through send(), which is meaningless on a PDF or
      // a PNG and confuses some clients about how to decode the body.
      return res.end(buffer);
    } catch (err) {
      return next(err);
    }
  });

/**
 * The QR badge. Owner-only and never included in a list response — it is the
 * credential a scanner accepts at the door.
 */
router.get('/:reference/qr',
  authenticate,
  validate({ params: z.object({ reference: z.string().trim().min(1).max(48) }) }),
  async (req, res, next) => {
    try {
      const registration = await Registration.scope('withQr').findOne({
        where: { reference: req.params.reference },
      });
      if (!registration) throw new NotFoundError('Registration');
      if (String(registration.user_id) !== String(req.user.id)) {
        throw new AuthorizationError('You do not have access to this registration.');
      }
      if (registration.status !== 'CONFIRMED') {
        return ok(res, { available: false, reason: `Registration is ${registration.status}.` });
      }
      return ok(res, {
        available: true,
        reference: registration.reference,
        qrToken: registration.qr_token,
      });
    } catch (err) {
      return next(err);
    }
  });

router.post('/:reference/cancel',
  authenticate,
  validate({
    params: z.object({ reference: z.string().trim().min(1).max(48) }),
    body: z.object({ reason: z.string().trim().max(500).optional() }),
  }),
  loadOwnedRegistration,
  async (req, res, next) => {
    try {
      await registrationService.cancel(req.registration.id, {
        actor: { id: req.user.id, email: req.user.email },
        reason: req.body.reason ?? 'Cancelled by participant',
        context: contextOf(req),
      });
      return ok(res, null, 'Registration cancelled.');
    } catch (err) {
      return next(err);
    }
  });

/**
 * Reduces or zeroes what a registration owes. Deliberately not behind
 * `loadOwnedRegistration` — a participant can cancel their own place, but
 * waiving a fee is an administrative act regardless of whose registration it
 * is, so it is gated purely on `cpd.registration.update` ("amend a
 * registration") rather than ownership.
 */
router.post('/:reference/waive',
  authenticate,
  loadPermissions,
  requirePermission('cpd.registration.update'),
  validate({
    params: z.object({ reference: z.string().trim().min(1).max(48) }),
    body: z.object({
      // A decimal string, same convention as the fee editor — "0" or "0.00"
      // waives it in full, anything else in between reduces it.
      amount: z.string().trim().max(20).regex(/^\d+(\.\d+)?$/, 'Enter an amount such as 0.00'),
      reason: z.string().trim().max(500).optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const registration = await Registration.findOne({ where: { reference: req.params.reference } });
      if (!registration) throw new NotFoundError('Registration');

      await registrationService.waive(registration.id, {
        actor: { id: req.user.id, email: req.user.email },
        amount: req.body.amount,
        reason: req.body.reason,
        context: contextOf(req),
      });

      const full = await Registration.findOne({
        where: { reference: req.params.reference },
        include: [{ model: Event, as: 'event' }, { model: User, as: 'waivedByUser' }],
      });
      return ok(res, serialiseRegistration(full, { includeWaiver: true }), 'Fee updated.');
    } catch (err) {
      return next(err);
    }
  });

// --- admin -------------------------------------------------------------------
router.get('/',
  authenticate,
  loadPermissions,
  requirePermission('cpd.registration.view'),
  validate({
    query: paginationSchema.extend({
      eventId: z.coerce.number().int().positive().optional(),
      status: z.string().trim().max(32).optional(),
      attendanceMode: z.enum(['IN_PERSON', 'VIRTUAL']).optional(),
      countryCode: z.string().trim().length(2).toUpperCase().optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const { page, limit, sort, order, q, eventId, status, attendanceMode, countryCode } = req.validatedQuery;

      const where = {};
      if (eventId) where.event_id = eventId;
      if (status) where.status = { [Op.in]: status.split(',').map((s) => s.trim().toUpperCase()) };
      if (attendanceMode) where.attendance_mode = attendanceMode;

      const userWhere = {};
      if (countryCode) userWhere.country_code = countryCode;
      if (q) {
        userWhere[Op.or] = [
          { first_name: { [Op.like]: `%${q}%` } },
          { last_name: { [Op.like]: `%${q}%` } },
          { email: { [Op.like]: `%${q}%` } },
          { organization: { [Op.like]: `%${q}%` } },
        ];
      }

      const { rows, count } = await Registration.findAndCountAll({
        where,
        include: [
          { model: Event, as: 'event' },
          {
            model: User,
            as: 'user',
            where: Object.keys(userWhere).length ? userWhere : undefined,
            required: Object.keys(userWhere).length > 0,
          },
        ],
        order: resolveOrder(sort, order, {
          allowed: ['created_at', 'status', 'attendance_mode', 'confirmed_at'],
          fallback: 'created_at',
        }),
        ...offsetFor({ page, limit }),
        distinct: true,
      });

      return paginated(res, rows.map((r) => serialiseRegistration(r)), pageMeta({ page, limit }, count));
    } catch (err) {
      return next(err);
    }
  });

export default router;
