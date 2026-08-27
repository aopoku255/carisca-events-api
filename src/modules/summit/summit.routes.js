import { Router } from 'express';
import { Op } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import * as eventService from '../../core/events/event.service.js';
import { serialiseAdminEvent } from '../../core/events/event.serialiser.js';
import { toMinor } from '../../lib/money.js';
import { ok, created, paginated } from '../../lib/response.js';
import { resolveOrder, offsetFor, searchAcross, pageMeta } from '../../lib/pagination.js';
import { validate } from '../../middleware/validate.js';
import {
  authenticate, requireStaff, loadPermissions, requirePermission,
} from '../../middleware/authenticate.js';
import { record as audit } from '../../core/audit/audit.service.js';
import { summariseResponses } from '../cpd/response-summary.js';
import * as evaluationService from '../../core/evaluations/evaluation.service.js';
import { toCsv, exportFilename, sendCsv } from '../../lib/csv.js';
import * as cpdSchema from '../cpd/cpd.validation.js';
import * as schema from './summit.validation.js';

const {
  Event, EventType, EventPrice, EventSession, EventSpeaker,
  RegistrationQuestion, EventPartner, EventTrack, EventSponsorshipTier, Registration,
} = models;

const MODULE_KEY = 'summit';

/**
 * The Summit module.
 *
 * Route-for-route mirror of the CPD module — lifecycle, slugs, publication
 * checks and pricing all live in core, exactly as the CPD module's own
 * comment predicted. What's actually Summit-specific is the `summit` detail
 * block and the two extra whole-list-replace endpoints (tracks,
 * sponsorship tiers) neither other module has.
 */
const router = Router();

router.use(authenticate, requireStaff, loadPermissions);

const contextOf = (req) => ({ ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id });
const actorOf = (req) => ({ id: req.user.id, email: req.user.email });

/** Confirms the event exists and is actually a Summit before any Summit route acts. */
async function loadSummitEvent(req, res, next) {
  try {
    const event = await eventService.findById(req.params.id);
    if (event.type?.key !== MODULE_KEY) {
      return next(Object.assign(new Error('Not a Summit event'), { status: 404 }));
    }
    req.event = event;
    return next();
  } catch (err) {
    return next(err);
  }
}

// --- listing ----------------------------------------------------------------
router.get('/events',
  requirePermission('summit.view'),
  validate({ query: schema.listEventsSchema }),
  async (req, res, next) => {
    try {
      const { page, limit, sort, order, q, status, countryCode, from, to } = req.validatedQuery;
      const type = await EventType.findOne({ where: { key: MODULE_KEY } });

      const where = { event_type_id: type.id };
      if (status) where.status = { [Op.in]: status.split(',').map((s) => s.trim().toUpperCase()) };
      if (countryCode) where.country_code = countryCode;
      if (from || to) {
        where.start_at = {};
        if (from) where.start_at[Op.gte] = from;
        if (to) where.start_at[Op.lte] = to;
      }
      const search = searchAcross(q, ['title', 'short_description', 'city', 'venue']);

      const { rows, count } = await Event.findAndCountAll({
        where: search ? { ...where, ...search } : where,
        include: [{ model: EventType, as: 'type' }],
        order: resolveOrder(sort, order, {
          allowed: ['start_at', 'created_at', 'title', 'status'],
          fallback: 'start_at',
        }),
        ...offsetFor({ page, limit }),
        distinct: true,
      });

      return paginated(res, rows.map((e) => serialiseAdminEvent(e)), pageMeta({ page, limit }, count));
    } catch (err) {
      return next(err);
    }
  });

router.get('/events/:id',
  requirePermission('summit.view'),
  validate({ params: schema.idParam }),
  loadSummitEvent,
  async (req, res, next) => {
    try {
      const [inPerson, virtual] = await Promise.all([
        eventService.capacityStatus(req.event, 'IN_PERSON'),
        eventService.capacityStatus(req.event, 'VIRTUAL'),
      ]);
      return ok(res, serialiseAdminEvent(req.event, { capacity: { inPerson, virtual } }));
    } catch (err) {
      return next(err);
    }
  });

/** Same headline-counts-plus-breakdowns call the CPD detail page uses. */
router.get('/events/:id/summary',
  requirePermission('registration.view'),
  validate({ params: schema.idParam }),
  loadSummitEvent,
  async (req, res, next) => {
    try {
      const eventId = req.params.id;
      const replacements = { eventId };

      const group = (column, extraJoin = '', label = 'label') => sequelize.query(
        `SELECT ${column} AS ${label}, COUNT(*) AS count
           FROM registrations r ${extraJoin}
          WHERE r.event_id = :eventId AND r.deleted_at IS NULL
          GROUP BY ${column}
          ORDER BY count DESC`,
        { replacements, type: sequelize.QueryTypes.SELECT },
      );

      const [byStatus, byMode, byCountry, byOrg, bySector, overTime] = await Promise.all([
        group('r.status'),
        group('r.attendance_mode'),
        group("COALESCE(c.name, 'Not given')", 'LEFT JOIN users u ON u.id = r.user_id LEFT JOIN countries c ON c.iso2 = u.country_code'),
        group("COALESCE(NULLIF(u.organization, ''), 'Not given')", 'LEFT JOIN users u ON u.id = r.user_id'),
        group("COALESCE(s.label, 'Not given')", 'LEFT JOIN users u ON u.id = r.user_id LEFT JOIN sectors s ON s.id = u.sector_id'),
        sequelize.query(
          `SELECT DATE(r.created_at) AS day, COUNT(*) AS count
             FROM registrations r
            WHERE r.event_id = :eventId AND r.deleted_at IS NULL
            GROUP BY DATE(r.created_at)
            ORDER BY day ASC`,
          { replacements, type: sequelize.QueryTypes.SELECT },
        ),
      ]);

      const [inPerson, virtual] = await Promise.all([
        eventService.capacityStatus(req.event, 'IN_PERSON'),
        eventService.capacityStatus(req.event, 'VIRTUAL'),
      ]);

      const tally = (rows) => rows.reduce((acc, r) => {
        acc[r.label] = Number(r.count);
        return acc;
      }, {});

      const statuses = tally(byStatus);
      const total = Object.values(statuses).reduce((a, b) => a + b, 0);

      return ok(res, {
        eventId: String(eventId),
        totals: {
          all: total,
          confirmed: statuses.CONFIRMED ?? 0,
          pendingPayment: statuses.PENDING_PAYMENT ?? 0,
          waitlisted: statuses.WAITLISTED ?? 0,
          cancelled: (statuses.CANCELLED ?? 0) + (statuses.REFUNDED ?? 0),
        },
        byStatus: statuses,
        byAttendanceMode: tally(byMode),
        capacity: { inPerson, virtual },
        topCountries: byCountry.slice(0, 10).map((r) => ({ name: r.label, count: Number(r.count) })),
        topOrganizations: byOrg.slice(0, 10).map((r) => ({ name: r.label, count: Number(r.count) })),
        bySector: bySector.map((r) => ({ name: r.label, count: Number(r.count) })),
        registrationsPerDay: overTime.map((r) => ({ day: r.day, count: Number(r.count) })),
        distinctCountries: byCountry.filter((r) => r.label !== 'Not given').length,
        distinctOrganizations: byOrg.filter((r) => r.label !== 'Not given').length,
      });
    } catch (err) {
      return next(err);
    }
  });

router.get('/events/:id/responses',
  requirePermission('registration.view'),
  validate({ params: schema.idParam }),
  loadSummitEvent,
  async (req, res, next) => {
    try {
      const eventId = req.params.id;

      const questions = await RegistrationQuestion.findAll({
        where: { event_id: eventId },
        order: [['sort_order', 'ASC'], ['id', 'ASC']],
      });

      const countable = { [Op.notIn]: ['CANCELLED', 'REFUNDED'] };

      const [responses, answers] = await Promise.all([
        models.Registration.count({ where: { event_id: eventId, status: countable } }),
        questions.length
          ? sequelize.query(
            `SELECT ra.question_id, ra.value
               FROM registration_answers ra
               JOIN registrations r ON r.id = ra.registration_id
              WHERE r.event_id = :eventId
                AND r.deleted_at IS NULL
                AND r.status NOT IN ('CANCELLED', 'REFUNDED')
              ORDER BY ra.id ASC`,
            { replacements: { eventId }, type: sequelize.QueryTypes.SELECT },
          )
          : [],
      ]);

      return ok(res, {
        eventId: String(eventId),
        responses,
        questions: summariseResponses(
          questions.map((q) => ({
            id: q.id, label: q.label, type: q.type, is_required: q.is_required, options: q.options,
          })),
          answers,
          responses,
        ),
      });
    } catch (err) {
      return next(err);
    }
  });

// --- create and edit --------------------------------------------------------
const toColumns = (b) => ({
  title: b.title,
  short_description: b.shortDescription,
  description: b.description,
  banner_file_id: b.bannerFileId,
  start_at: b.startAt,
  end_at: b.endAt,
  timezone: b.timezone,
  delivery_mode: b.deliveryMode,
  country_code: b.countryCode,
  city: b.city,
  venue: b.venue,
  online_url: b.onlineUrl,
  capacity: b.capacity,
  virtual_capacity: b.virtualCapacity,
  allow_waitlist: b.allowWaitlist,
  registration_opens_at: b.registrationOpensAt,
  registration_closes_at: b.registrationClosesAt,
  payment_hold_hours: b.paymentHoldHours,
  issues_certificate: b.issuesCertificate,
  certificate_template_id: b.certificateTemplateId,
  certificate_requires_payment: b.certificateRequiresPayment,
  certificate_requires_evaluation: b.certificateRequiresEvaluation,
  attendance_rule: b.attendanceRule,
  min_attendance_percent: b.minAttendancePercent,
  organizer_department_id: b.organizerDepartmentId,
  contact_email: b.contactEmail,
  contact_phone: b.contactPhone,
  summit: b.summit && {
    theme: b.summit.theme,
    call_for_papers_opens_at: b.summit.callForPapersOpensAt,
    call_for_papers_closes_at: b.summit.callForPapersClosesAt,
    keynote_count: b.summit.keynoteCount,
  },
});

const defined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

router.post('/events',
  requirePermission('summit.create'),
  validate({ body: schema.createEventSchema }),
  async (req, res, next) => {
    try {
      const event = await eventService.create(defined(toColumns(req.body)), {
        actor: actorOf(req), moduleKey: MODULE_KEY, context: contextOf(req),
      });
      return created(res, serialiseAdminEvent(event), 'Summit created as a draft.');
    } catch (err) {
      return next(err);
    }
  });

router.patch('/events/:id',
  requirePermission('summit.update'),
  validate({ params: schema.idParam, body: schema.updateEventSchema }),
  loadSummitEvent,
  async (req, res, next) => {
    try {
      const event = await eventService.update(req.params.id, defined(toColumns(req.body)), {
        actor: actorOf(req), context: contextOf(req),
      });
      return ok(res, serialiseAdminEvent(event), 'Summit updated.');
    } catch (err) {
      return next(err);
    }
  });

// --- lifecycle ---------------------------------------------------------------
const LIFECYCLE = [
  ['submit-for-approval', 'submitForApproval', 'summit.update'],
  ['publish', 'publish', 'summit.publish'],
  ['unpublish', 'unpublish', 'summit.publish'],
  ['open-registration', 'openRegistration', 'summit.publish'],
  ['close-registration', 'closeRegistration', 'summit.update'],
  ['start', 'start', 'summit.update'],
  ['complete', 'complete', 'summit.update'],
  ['cancel', 'cancel', 'summit.cancel'],
  ['archive', 'archive', 'summit.archive'],
];

for (const [path, transition, permission] of LIFECYCLE) {
  router.post(`/events/:id/${path}`,
    requirePermission(permission),
    validate({ params: schema.idParam, body: schema.transitionSchema }),
    loadSummitEvent,
    async (req, res, next) => {
      try {
        const event = await eventService.transition(req.params.id, transition, {
          actor: actorOf(req), reason: req.body.reason, context: contextOf(req),
        });
        return ok(res, serialiseAdminEvent(event), `Event ${event.status.toLowerCase().replace('_', ' ')}.`);
      } catch (err) {
        return next(err);
      }
    });
}

// --- registration questions --------------------------------------------------
router.put('/events/:id/questions',
  requirePermission('summit.question.manage'),
  validate({ params: schema.idParam, body: schema.questionsSchema }),
  loadSummitEvent,
  async (req, res, next) => {
    try {
      const eventId = req.params.id;
      const before = req.event.questions?.map((q) => q.label) ?? [];

      await sequelize.transaction(async (transaction) => {
        await RegistrationQuestion.destroy({ where: { event_id: eventId }, transaction });
        if (req.body.questions.length) {
          await RegistrationQuestion.bulkCreate(
            req.body.questions.map((q, i) => ({
              event_id: eventId,
              label: q.label,
              help_text: q.helpText,
              type: q.type,
              options: q.options ?? null,
              is_required: q.required,
              sort_order: q.sortOrder || (i + 1) * 10,
            })),
            { transaction },
          );
        }
        await audit({
          actor: actorOf(req),
          action: 'event.questions_updated',
          resourceType: 'event',
          resourceId: eventId,
          before: { questions: before },
          after: { questions: req.body.questions.map((q) => q.label) },
          context: contextOf(req),
        }, { transaction });
      });

      const event = await eventService.findById(eventId);
      return ok(res, serialiseAdminEvent(event), 'Registration questions saved.');
    } catch (err) {
      return next(err);
    }
  });

/** See cpd.routes.js's identical route for why the form itself is never exposed directly. */
router.put('/events/:id/evaluation-questions',
  requirePermission('evaluation.manage'),
  validate({ params: schema.idParam, body: cpdSchema.evaluationQuestionsSchema }),
  loadSummitEvent,
  async (req, res, next) => {
    try {
      await evaluationService.saveQuestions(req.params.id, req.body.questions, {
        actor: actorOf(req), context: contextOf(req),
      });
      const event = await eventService.findById(req.params.id);
      return ok(res, serialiseAdminEvent(event), 'Survey questions saved.');
    } catch (err) {
      return next(err);
    }
  });

router.get('/events/:id/evaluation-responses',
  requirePermission('evaluation.view'),
  validate({ params: schema.idParam }),
  loadSummitEvent,
  async (req, res, next) => {
    try {
      const eventId = req.params.id;
      const questions = await evaluationService.questionsForEvent(eventId);

      const countable = { [Op.notIn]: ['CANCELLED', 'REFUNDED'] };
      const [responses, answers] = await Promise.all([
        Registration.count({ where: { event_id: eventId, status: countable } }),
        questions.length
          ? sequelize.query(
            `SELECT er.question_id, er.value
               FROM evaluation_responses er
               JOIN evaluation_forms ef ON ef.id = er.form_id
               JOIN registrations r ON r.id = er.registration_id
              WHERE ef.event_id = :eventId
                AND r.deleted_at IS NULL
                AND r.status NOT IN ('CANCELLED', 'REFUNDED')
              ORDER BY er.id ASC`,
            { replacements: { eventId }, type: sequelize.QueryTypes.SELECT },
          )
          : [],
      ]);

      return ok(res, {
        eventId: String(eventId),
        responses,
        questions: summariseResponses(
          questions.map((q) => ({
            id: q.id, label: q.label, type: q.type, is_required: q.is_required, options: q.options,
          })),
          answers,
          responses,
        ),
      });
    } catch (err) {
      return next(err);
    }
  });

router.get('/events/:id/evaluation-responses/export',
  requirePermission('evaluation.export'),
  validate({ params: schema.idParam }),
  loadSummitEvent,
  async (req, res, next) => {
    try {
      const eventId = req.params.id;
      const questions = await evaluationService.questionsForEvent(eventId);

      const rows = questions.length
        ? await sequelize.query(
          `SELECT r.reference, r.id AS registration_id, u.first_name, u.last_name,
                  er.question_id, er.value
             FROM evaluation_responses er
             JOIN evaluation_forms ef ON ef.id = er.form_id
             JOIN registrations r ON r.id = er.registration_id
             JOIN users u ON u.id = r.user_id
            WHERE ef.event_id = :eventId
              AND r.deleted_at IS NULL
              AND r.status NOT IN ('CANCELLED', 'REFUNDED')
            ORDER BY r.id ASC`,
          { replacements: { eventId }, type: sequelize.QueryTypes.SELECT },
        )
        : [];

      const byRegistration = new Map();
      for (const row of rows) {
        if (!byRegistration.has(row.registration_id)) {
          byRegistration.set(row.registration_id, {
            reference: row.reference,
            name: `${row.first_name} ${row.last_name}`.trim(),
            answers: {},
          });
        }
        byRegistration.get(row.registration_id).answers[row.question_id] = row.value;
      }

      const columns = [
        { key: 'reference', header: 'Reference' },
        { key: 'name', header: 'Participant' },
        ...questions.map((q) => ({
          header: q.label,
          map: (r) => r.answers[q.id] ?? '',
        })),
      ];

      const csv = toCsv(columns, [...byRegistration.values()]);

      await audit({
        actor: actorOf(req),
        action: 'evaluation.exported',
        resourceType: 'event',
        resourceId: eventId,
        metadata: { rows: byRegistration.size },
        context: contextOf(req),
      });

      return sendCsv(res, exportFilename(`${req.event.slug}-survey`), csv);
    } catch (err) {
      return next(err);
    }
  });

// --- prices ------------------------------------------------------------------
router.put('/events/:id/prices',
  requirePermission('summit.update'),
  validate({ params: schema.idParam, body: schema.pricesSchema }),
  loadSummitEvent,
  async (req, res, next) => {
    try {
      const eventId = req.params.id;

      await eventService.assertCurrenciesStillCovered(
        eventId,
        req.body.prices.map((p) => p.currency),
      );

      await sequelize.transaction(async (transaction) => {
        await EventPrice.destroy({ where: { event_id: eventId }, transaction });
        await EventPrice.bulkCreate(
          req.body.prices.map((p) => ({
            event_id: eventId,
            tier: p.tier,
            label: p.label,
            attendance_mode: p.attendanceMode,
            audience: p.audience,
            amount_minor: toMinor(p.amount, p.currency),
            currency: p.currency,
            priority: p.priority,
            is_default: p.isDefault,
            available_from: p.availableFrom,
            available_until: p.availableUntil,
          })),
          { transaction },
        );
        await audit({
          actor: actorOf(req),
          action: 'event.prices_updated',
          resourceType: 'event',
          resourceId: eventId,
          after: { prices: req.body.prices.map((p) => `${p.label} ${p.amount} ${p.currency}`) },
          context: contextOf(req),
        }, { transaction });
      });

      const event = await eventService.findById(eventId);
      return ok(res, serialiseAdminEvent(event), 'Prices saved.');
    } catch (err) {
      return next(err);
    }
  });

// --- sessions and speakers ----------------------------------------------------
router.put('/events/:id/sessions',
  requirePermission('summit.update'),
  validate({ params: schema.idParam, body: schema.sessionsSchema }),
  loadSummitEvent,
  async (req, res, next) => {
    try {
      const eventId = req.params.id;
      await sequelize.transaction(async (transaction) => {
        await EventSession.destroy({ where: { event_id: eventId }, transaction });
        if (req.body.sessions.length) {
          await EventSession.bulkCreate(req.body.sessions.map((s, i) => ({
            event_id: eventId,
            title: s.title,
            description: s.description,
            start_at: s.startAt,
            end_at: s.endAt,
            location: s.location,
            is_required_for_attendance: s.requiredForAttendance,
            sort_order: s.sortOrder || (i + 1) * 10,
            track_id: s.trackId ?? null,
          })), { transaction });
        }
      });
      return ok(res, serialiseAdminEvent(await eventService.findById(eventId)), 'Sessions saved.');
    } catch (err) {
      return next(err);
    }
  });

router.put('/events/:id/speakers',
  requirePermission('summit.update'),
  validate({ params: schema.idParam, body: schema.speakersSchema }),
  loadSummitEvent,
  async (req, res, next) => {
    try {
      const eventId = req.params.id;
      await sequelize.transaction(async (transaction) => {
        await EventSpeaker.destroy({ where: { event_id: eventId }, transaction });
        if (req.body.speakers.length) {
          await EventSpeaker.bulkCreate(req.body.speakers.map((s, i) => ({
            event_id: eventId,
            name: s.name,
            title: s.title,
            organization: s.organization,
            bio: s.bio,
            role: s.role,
            photo_file_id: s.photoFileId ?? null,
            sort_order: s.sortOrder || (i + 1) * 10,
          })), { transaction });
        }
      });
      return ok(res, serialiseAdminEvent(await eventService.findById(eventId)), 'Speakers saved.');
    } catch (err) {
      return next(err);
    }
  });

/** Who CARISCA is running this with. Replaces the whole set in one call. */
router.put('/events/:id/partners',
  requirePermission('summit.update'),
  validate({ params: schema.idParam, body: schema.eventPartnersSchema }),
  loadSummitEvent,
  async (req, res, next) => {
    try {
      const eventId = req.params.id;

      await sequelize.transaction(async (transaction) => {
        await EventPartner.destroy({ where: { event_id: eventId }, transaction });
        if (req.body.partners.length) {
          await EventPartner.bulkCreate(
            req.body.partners.map((p, i) => ({
              event_id: eventId,
              partner_id: p.partnerId,
              role: p.role,
              sort_order: p.sortOrder || (i + 1) * 10,
              sponsorship_tier_id: p.sponsorshipTierId ?? null,
            })),
            { transaction },
          );
        }
        await audit({
          actor: actorOf(req),
          action: 'event.partners_updated',
          resourceType: 'event',
          resourceId: eventId,
          after: { partners: req.body.partners.length },
          context: contextOf(req),
        }, { transaction });
      });

      return ok(res, serialiseAdminEvent(await eventService.findById(eventId)), 'Partners saved.');
    } catch (err) {
      return next(err);
    }
  });

/**
 * The Summit's agenda tracks — a pure grouping label for parallel sessions.
 * Same whole-list-replace pattern as questions and prices.
 */
router.put('/events/:id/tracks',
  requirePermission('summit.update'),
  validate({ params: schema.idParam, body: schema.tracksSchema }),
  loadSummitEvent,
  async (req, res, next) => {
    try {
      const eventId = req.params.id;
      await sequelize.transaction(async (transaction) => {
        await EventTrack.destroy({ where: { event_id: eventId }, transaction });
        if (req.body.tracks.length) {
          await EventTrack.bulkCreate(req.body.tracks.map((t, i) => ({
            event_id: eventId,
            name: t.name,
            description: t.description,
            color: t.color,
            sort_order: t.sortOrder || (i + 1) * 10,
          })), { transaction });
        }
        await audit({
          actor: actorOf(req),
          action: 'event.tracks_updated',
          resourceType: 'event',
          resourceId: eventId,
          after: { tracks: req.body.tracks.map((t) => t.name) },
          context: contextOf(req),
        }, { transaction });
      });
      return ok(res, serialiseAdminEvent(await eventService.findById(eventId)), 'Tracks saved.');
    } catch (err) {
      return next(err);
    }
  });

/**
 * The Summit's sponsorship levels — Platinum, Gold, Silver — with their own
 * benefits text. `EventPartner.sponsorship_tier_id` refers to rows here;
 * removing a tier a partner still uses ungroups that partner rather than
 * failing, since the FK is ON DELETE SET NULL.
 */
router.put('/events/:id/sponsorship-tiers',
  requirePermission('summit.update'),
  validate({ params: schema.idParam, body: schema.sponsorshipTiersSchema }),
  loadSummitEvent,
  async (req, res, next) => {
    try {
      const eventId = req.params.id;
      await sequelize.transaction(async (transaction) => {
        await EventSponsorshipTier.destroy({ where: { event_id: eventId }, transaction });
        if (req.body.tiers.length) {
          await EventSponsorshipTier.bulkCreate(req.body.tiers.map((t, i) => ({
            event_id: eventId,
            name: t.name,
            benefits: t.benefits,
            price_amount_minor: t.price && t.currency ? toMinor(t.price, t.currency) : null,
            currency: t.price && t.currency ? t.currency : null,
            sort_order: t.sortOrder || (i + 1) * 10,
          })), { transaction });
        }
        await audit({
          actor: actorOf(req),
          action: 'event.sponsorship_tiers_updated',
          resourceType: 'event',
          resourceId: eventId,
          after: { tiers: req.body.tiers.map((t) => t.name) },
          context: contextOf(req),
        }, { transaction });
      });
      return ok(res, serialiseAdminEvent(await eventService.findById(eventId)), 'Sponsorship tiers saved.');
    } catch (err) {
      return next(err);
    }
  });

export default router;
