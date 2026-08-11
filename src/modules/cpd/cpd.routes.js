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
import * as schema from './cpd.validation.js';

const { Event, EventType, EventPrice, EventSession, EventSpeaker, RegistrationQuestion } = models;

const MODULE_KEY = 'cpd';

/**
 * The CPD module.
 *
 * Everything here is business rules and wiring — lifecycle, slugs, publication
 * checks and pricing all live in core, so Summit will mount an almost identical
 * router without any of that being rewritten.
 */
const router = Router();

router.use(authenticate, requireStaff, loadPermissions);

const contextOf = (req) => ({ ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id });
const actorOf = (req) => ({ id: req.user.id, email: req.user.email });

/** Confirms the event exists and is actually a CPD before any CPD route acts. */
async function loadCpdEvent(req, res, next) {
  try {
    const event = await eventService.findById(req.params.id);
    if (event.type?.key !== MODULE_KEY) {
      return next(Object.assign(new Error('Not a CPD event'), { status: 404 }));
    }
    req.event = event;
    return next();
  } catch (err) {
    return next(err);
  }
}

// --- listing ----------------------------------------------------------------
router.get('/events',
  requirePermission('cpd.view'),
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
  requirePermission('cpd.view'),
  validate({ params: schema.idParam }),
  loadCpdEvent,
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

// --- create and edit --------------------------------------------------------
const toColumns = (b) => ({
  title: b.title,
  short_description: b.shortDescription,
  description: b.description,
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
  cpd: b.cpd && {
    cpd_credits: b.cpd.cpdCredits,
    accrediting_body: b.cpd.accreditingBody,
    learning_objectives: b.cpd.learningObjectives,
    target_audience: b.cpd.targetAudience,
    requirements: b.cpd.requirements,
  },
});

const defined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

router.post('/events',
  requirePermission('cpd.create'),
  validate({ body: schema.createEventSchema }),
  async (req, res, next) => {
    try {
      const event = await eventService.create(defined(toColumns(req.body)), {
        actor: actorOf(req), moduleKey: MODULE_KEY, context: contextOf(req),
      });
      return created(res, serialiseAdminEvent(event), 'CPD created as a draft.');
    } catch (err) {
      return next(err);
    }
  });

router.patch('/events/:id',
  requirePermission('cpd.update'),
  validate({ params: schema.idParam, body: schema.updateEventSchema }),
  loadCpdEvent,
  async (req, res, next) => {
    try {
      const event = await eventService.update(req.params.id, defined(toColumns(req.body)), {
        actor: actorOf(req), context: contextOf(req),
      });
      return ok(res, serialiseAdminEvent(event), 'CPD updated.');
    } catch (err) {
      return next(err);
    }
  });

// --- lifecycle ---------------------------------------------------------------
const LIFECYCLE = [
  ['submit-for-approval', 'submitForApproval', 'cpd.update'],
  ['publish', 'publish', 'cpd.publish'],
  ['unpublish', 'unpublish', 'cpd.publish'],
  ['open-registration', 'openRegistration', 'cpd.publish'],
  ['close-registration', 'closeRegistration', 'cpd.update'],
  ['start', 'start', 'cpd.update'],
  ['complete', 'complete', 'cpd.update'],
  ['cancel', 'cancel', 'cpd.cancel'],
  ['archive', 'archive', 'cpd.archive'],
];

for (const [path, transition, permission] of LIFECYCLE) {
  router.post(`/events/:id/${path}`,
    requirePermission(permission),
    validate({ params: schema.idParam, body: schema.transitionSchema }),
    loadCpdEvent,
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
/**
 * Replaces the whole question set in one call. Questions already answered are
 * soft-deleted rather than removed, so existing answers keep their labels.
 */
router.put('/events/:id/questions',
  requirePermission('cpd.question.manage'),
  validate({ params: schema.idParam, body: schema.questionsSchema }),
  loadCpdEvent,
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

// --- prices ------------------------------------------------------------------
router.put('/events/:id/prices',
  requirePermission('cpd.update'),
  validate({ params: schema.idParam, body: schema.pricesSchema }),
  loadCpdEvent,
  async (req, res, next) => {
    try {
      const eventId = req.params.id;

      // Refuse to withdraw a currency people are currently registered at.
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
            // Converted here, against the currency's own exponent.
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
  requirePermission('cpd.update'),
  validate({ params: schema.idParam, body: schema.sessionsSchema }),
  loadCpdEvent,
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
          })), { transaction });
        }
      });
      return ok(res, serialiseAdminEvent(await eventService.findById(eventId)), 'Sessions saved.');
    } catch (err) {
      return next(err);
    }
  });

router.put('/events/:id/speakers',
  requirePermission('cpd.update'),
  validate({ params: schema.idParam, body: schema.speakersSchema }),
  loadCpdEvent,
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
            sort_order: s.sortOrder || (i + 1) * 10,
          })), { transaction });
        }
      });
      return ok(res, serialiseAdminEvent(await eventService.findById(eventId)), 'Speakers saved.');
    } catch (err) {
      return next(err);
    }
  });

export default router;
