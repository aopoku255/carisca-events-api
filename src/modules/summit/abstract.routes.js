import { Router } from 'express';
import { z } from 'zod';
import { models } from '../../database/models/index.js';
import * as abstractService from '../../core/summit/abstract.service.js';
import * as storage from '../../core/files/storage.service.js';
import { serialiseFile } from '../../core/files/storage.service.js';
import { ok, created, paginated } from '../../lib/response.js';
import { toCsv, exportFilename, sendCsv } from '../../lib/csv.js';
import { record as audit } from '../../core/audit/audit.service.js';
import { validate } from '../../middleware/validate.js';
import {
  authenticate, requireStaff, loadPermissions, requirePermission,
} from '../../middleware/authenticate.js';
import { NotFoundError } from '../../lib/errors.js';

const { AbstractSubmission, Event, EventTrack } = models;

/**
 * Abstract submission and review.
 *
 * Deliberately its own router rather than folded into summit.routes.js,
 * which blanket-gates every route as staff-only. The routes below are a
 * genuine mix — a participant acts on their own submission by ownership, no
 * permission required, while staff review routes are permission-gated
 * per-route — the same shape registration.routes.js already uses for the
 * same reason.
 */
const router = Router();

const contextOf = (req) => ({ ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id });
const actorOf = (req) => ({ id: req.user.id, email: req.user.email });

const authorSchema = z.object({
  name: z.string().trim().min(1).max(160),
  affiliation: z.string().trim().max(200).optional(),
  email: z.string().email().max(190).optional(),
});

const submitSchema = z.object({
  eventId: z.coerce.number().int().positive(),
  title: z.string().trim().min(3).max(255),
  abstractText: z.string().trim().min(20).max(20_000),
  trackId: z.coerce.number().int().positive().nullable().optional(),
  coAuthors: z.array(authorSchema).max(20).optional(),
  paperFileId: z.coerce.number().int().positive().nullable().optional(),
});

// eventId is fixed at submission and never revisited on edit.
const updateSchema = submitSchema.omit({ eventId: true }).partial();

const idParam = z.object({ id: z.coerce.number().int().positive() });

function serialiseSubmission(s, { includeReviewNotes = false } = {}) {
  const out = {
    id: String(s.id),
    reference: s.reference,
    title: s.title,
    abstractText: s.abstract_text,
    status: s.status,
    coAuthors: s.co_authors ?? [],
    submittedAt: s.submitted_at,
    decidedAt: s.decided_at ?? null,
    track: s.track ? { id: String(s.track.id), name: s.track.name } : null,
    paper: serialiseFile(s.paper),
  };
  if (s.event) {
    out.event = { id: String(s.event.id), title: s.event.title, slug: s.event.slug };
  }
  if (s.author) {
    out.author = {
      id: String(s.author.id),
      name: `${s.author.first_name} ${s.author.last_name}`.trim(),
      email: s.author.email,
    };
  }
  if (includeReviewNotes) {
    out.reviewNotes = s.review_notes ?? null;
    out.decidedBy = s.decidedBy
      ? { id: String(s.decidedBy.id), name: `${s.decidedBy.first_name} ${s.decidedBy.last_name}`.trim() }
      : null;
  }
  return out;
}

// --- participant routes -------------------------------------------------------
router.post('/abstracts',
  authenticate,
  validate({ body: submitSchema }),
  async (req, res, next) => {
    try {
      const submission = await abstractService.submit(req.body, {
        user: req.user, context: contextOf(req),
      });
      return created(res, serialiseSubmission(submission), 'Submission received.');
    } catch (err) {
      return next(err);
    }
  });

router.get('/abstracts/mine',
  authenticate,
  async (req, res, next) => {
    try {
      const rows = await AbstractSubmission.findAll({
        where: { user_id: req.user.id },
        include: [{ model: Event, as: 'event' }, { model: EventTrack, as: 'track' }],
        order: [['created_at', 'DESC']],
      });
      return ok(res, rows.map((s) => serialiseSubmission(s)));
    } catch (err) {
      return next(err);
    }
  });

/** Ownership is enforced inside the service — a mismatch 404s, same reasoning
 *  registration.routes.js uses: whether someone else's submission exists is
 *  not something an unrelated caller should be able to probe for. */
router.get('/abstracts/mine/:id',
  authenticate,
  validate({ params: idParam }),
  async (req, res, next) => {
    try {
      const submission = await abstractService.findById(req.params.id);
      if (String(submission.user_id) !== String(req.user.id)) throw new NotFoundError('Submission');
      return ok(res, serialiseSubmission(submission));
    } catch (err) {
      return next(err);
    }
  });

router.patch('/abstracts/mine/:id',
  authenticate,
  validate({ params: idParam, body: updateSchema }),
  async (req, res, next) => {
    try {
      const submission = await abstractService.update(req.params.id, req.body, {
        user: req.user, context: contextOf(req),
      });
      return ok(res, serialiseSubmission(submission), 'Submission updated.');
    } catch (err) {
      return next(err);
    }
  });

router.post('/abstracts/mine/:id/withdraw',
  authenticate,
  validate({ params: idParam }),
  async (req, res, next) => {
    try {
      const submission = await abstractService.withdraw(req.params.id, {
        user: req.user, context: contextOf(req),
      });
      return ok(res, serialiseSubmission(submission), 'Submission withdrawn.');
    } catch (err) {
      return next(err);
    }
  });

// --- staff review routes -------------------------------------------------------
const eventIdParam = z.object({ id: z.coerce.number().int().positive() });
const abstractIdParam = z.object({ id: z.coerce.number().int().positive(), abstractId: z.coerce.number().int().positive() });
const decideSchema = z.object({
  decision: z.enum(['ACCEPTED', 'REJECTED']),
  notes: z.string().trim().max(5000).optional(),
});
const claimSchema = z.object({
  notes: z.string().trim().max(5000).optional(),
});

/** Confirms the event exists and is a Summit before any staff review route acts. */
async function loadSummitEventParam(req, res, next) {
  try {
    const event = await Event.findByPk(req.params.id, { include: [{ model: models.EventType, as: 'type' }] });
    if (!event || event.type?.key !== 'summit') throw new NotFoundError('Event');
    req.summitEvent = event;
    return next();
  } catch (err) {
    return next(err);
  }
}

router.get('/events/:id/abstracts',
  authenticate, requireStaff, loadPermissions, requirePermission('abstract.view'),
  validate({
    params: eventIdParam,
    query: z.object({ status: z.string().trim().max(64).optional(), trackId: z.coerce.number().int().positive().optional() }),
  }),
  loadSummitEventParam,
  async (req, res, next) => {
    try {
      const where = { event_id: req.params.id };
      if (req.validatedQuery.status) {
        where.status = req.validatedQuery.status.split(',').map((s) => s.trim().toUpperCase());
      }
      if (req.validatedQuery.trackId) where.track_id = req.validatedQuery.trackId;

      const rows = await AbstractSubmission.findAll({
        where,
        include: [{ model: EventTrack, as: 'track' }, { model: models.User, as: 'author' }],
        order: [['submitted_at', 'ASC']],
      });
      return paginated(res, rows.map((s) => serialiseSubmission(s, { includeReviewNotes: true })), {
        page: 1, limit: rows.length, total: rows.length, totalPages: 1,
      });
    } catch (err) {
      return next(err);
    }
  });

/*
 * Registered before the /:abstractId route below, deliberately — Express
 * matches routes in registration order, and :abstractId's own validator
 * coerces to a number, so "export" arriving there instead of here would
 * fail as an invalid id rather than reach this handler.
 */
router.get('/events/:id/abstracts/export',
  authenticate, requireStaff, loadPermissions, requirePermission('abstract.export'),
  validate({ params: eventIdParam }),
  loadSummitEventParam,
  async (req, res, next) => {
    try {
      const rows = await AbstractSubmission.findAll({
        where: { event_id: req.params.id },
        include: [{ model: EventTrack, as: 'track' }, { model: models.User, as: 'author' }],
        order: [['submitted_at', 'ASC']],
      });

      const csv = toCsv([
        { header: 'Reference', map: (s) => s.reference },
        { header: 'Title', map: (s) => s.title },
        { header: 'Author', map: (s) => `${s.author?.first_name ?? ''} ${s.author?.last_name ?? ''}`.trim() },
        { header: 'Author email', map: (s) => s.author?.email ?? '' },
        { header: 'Track', map: (s) => s.track?.name ?? '' },
        { header: 'Status', map: (s) => s.status },
        { header: 'Submitted at', map: (s) => s.submitted_at },
      ], rows);

      await audit({
        actor: actorOf(req),
        action: 'abstract.exported',
        resourceType: 'event',
        resourceId: req.params.id,
        after: { rows: rows.length },
        context: contextOf(req),
      });

      return sendCsv(res, exportFilename(`${req.summitEvent.slug}-abstracts`), csv);
    } catch (err) {
      return next(err);
    }
  });

router.get('/events/:id/abstracts/:abstractId',
  authenticate, requireStaff, loadPermissions, requirePermission('abstract.view'),
  validate({ params: abstractIdParam }),
  loadSummitEventParam,
  async (req, res, next) => {
    try {
      const submission = await abstractService.findById(req.params.abstractId);
      if (String(submission.event_id) !== String(req.params.id)) throw new NotFoundError('Submission');
      return ok(res, serialiseSubmission(submission, { includeReviewNotes: true }));
    } catch (err) {
      return next(err);
    }
  });

router.post('/events/:id/abstracts/:abstractId/claim',
  authenticate, requireStaff, loadPermissions, requirePermission('abstract.review'),
  validate({ params: abstractIdParam, body: claimSchema }),
  loadSummitEventParam,
  async (req, res, next) => {
    try {
      const submission = await abstractService.claim(req.params.abstractId, {
        actor: actorOf(req), notes: req.body.notes, context: contextOf(req),
      });
      return ok(res, serialiseSubmission(submission, { includeReviewNotes: true }), 'Claimed for review.');
    } catch (err) {
      return next(err);
    }
  });

router.post('/events/:id/abstracts/:abstractId/decide',
  authenticate, requireStaff, loadPermissions, requirePermission('abstract.decide'),
  validate({ params: abstractIdParam, body: decideSchema }),
  loadSummitEventParam,
  async (req, res, next) => {
    try {
      const submission = await abstractService.decide(req.params.abstractId, {
        actor: actorOf(req), decision: req.body.decision, notes: req.body.notes, context: contextOf(req),
      });
      return ok(res, serialiseSubmission(submission, { includeReviewNotes: true }), 'Decision recorded.');
    } catch (err) {
      return next(err);
    }
  });

export default router;
