import { Router } from 'express';
import { z } from 'zod';
import * as attendance from './attendance.service.js';
import * as eventService from '../events/event.service.js';
import { ok } from '../../lib/response.js';
import { validate } from '../../middleware/validate.js';
import {
  authenticate, requireStaff, loadPermissions, requirePermission,
} from '../../middleware/authenticate.js';
import { toCsv, exportFilename, sendCsv } from '../../lib/csv.js';
import { record as audit } from '../audit/audit.service.js';

const router = Router();

router.use(authenticate, requireStaff, loadPermissions);

const contextOf = (req) => ({ ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id });
const actorOf = (req) => ({ id: req.user.id, email: req.user.email });

const identifier = z.object({
  qrToken: z.string().trim().length(32).optional(),
  reference: z.string().trim().max(48).optional(),
  registrationId: z.coerce.number().int().positive().optional(),
  sessionId: z.coerce.number().int().positive().nullable().optional(),
}).refine((d) => d.qrToken || d.reference || d.registrationId, {
  message: 'Provide a QR code, a reference or a registration.',
});

/**
 * What the scanner sends.
 *
 * The response is shaped for a person holding a phone at a door: a clear
 * verdict, the participant's name so staff can greet them, and any warning
 * that needs acting on — not a bare 200.
 */
router.post('/scan',
  requirePermission('attendance.mark'),
  validate({
    body: identifier.innerType().extend({
      deviceInfo: z.string().trim().max(255).optional(),
      // The scanner queues offline and replays later; this is when the scan
      // actually happened, not when the request arrived.
      scannedAt: z.string().datetime({ offset: true }).optional(),
    }).refine((d) => d.qrToken || d.reference || d.registrationId, {
      message: 'Provide a QR code, a reference or a registration.',
    }),
  }),
  async (req, res, next) => {
    try {
      const { registration, record, created, warnings } = await attendance.checkIn({
        ...req.body,
        sessionId: req.body.sessionId ?? null,
        method: req.body.qrToken ? 'QR' : 'MANUAL',
        actor: actorOf(req),
        context: contextOf(req),
      });

      const name = `${registration.user?.first_name ?? ''} ${registration.user?.last_name ?? ''}`.trim();

      return ok(res, {
        result: created ? 'CHECKED_IN' : 'ALREADY_CHECKED_IN',
        participant: {
          name,
          organization: registration.user?.organization ?? null,
          reference: registration.reference,
          attendanceMode: registration.attendance_mode,
        },
        checkedInAt: record.check_in_at,
        warnings,
      }, created
        ? `${name} checked in.`
        : `${name} was already checked in.`);
    } catch (err) {
      return next(err);
    }
  });

router.post('/check-out',
  requirePermission('attendance.mark'),
  validate({ body: identifier }),
  async (req, res, next) => {
    try {
      const { registration, record, alreadyOut } = await attendance.checkOut({
        ...req.body,
        sessionId: req.body.sessionId ?? null,
        actor: actorOf(req),
        context: contextOf(req),
      });

      const name = `${registration.user?.first_name ?? ''} ${registration.user?.last_name ?? ''}`.trim();
      return ok(res, {
        result: alreadyOut ? 'ALREADY_CHECKED_OUT' : 'CHECKED_OUT',
        participant: { name, reference: registration.reference },
        checkedOutAt: record.check_out_at,
      }, alreadyOut ? `${name} had already checked out.` : `${name} checked out.`);
    } catch (err) {
      return next(err);
    }
  });

/**
 * Look someone up without admitting them — the fallback when a QR code will
 * not scan, or a badge was left at home.
 */
router.get('/lookup',
  requirePermission('attendance.view'),
  validate({
    query: z.object({
      eventId: z.coerce.number().int().positive(),
      q: z.string().trim().max(120).optional(),
      status: z.enum(['checked_in', 'not_arrived']).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
  }),
  async (req, res, next) => {
    try {
      const { eventId, q, status, limit } = req.validatedQuery;
      const rows = await attendance.rosterFor(eventId, { q, status, limit });

      return ok(res, rows.map((r) => ({
        registrationId: String(r.id),
        reference: r.reference,
        name: `${r.first_name} ${r.last_name}`.trim(),
        email: r.email,
        organization: r.organization,
        registrationStatus: r.status,
        attendanceMode: r.attendance_mode,
        checkedIn: !!r.attendance_id,
        checkedInAt: r.check_in_at,
        checkedOutAt: r.check_out_at,
      })));
    } catch (err) {
      return next(err);
    }
  });

router.get('/summary',
  requirePermission('attendance.view'),
  validate({ query: z.object({ eventId: z.coerce.number().int().positive() }) }),
  async (req, res, next) => {
    try {
      return ok(res, await attendance.summaryFor(req.validatedQuery.eventId));
    } catch (err) {
      return next(err);
    }
  });

/** Closes the register: everyone with no record becomes ABSENT. */
router.post('/finalise',
  requirePermission('attendance.mark'),
  validate({ body: z.object({ eventId: z.coerce.number().int().positive() }) }),
  async (req, res, next) => {
    try {
      const result = await attendance.finaliseAttendance(req.body.eventId, {
        actor: actorOf(req), context: contextOf(req),
      });
      return ok(res, result,
        `${result.present} attended, ${result.markedAbsent} marked absent.`);
    } catch (err) {
      return next(err);
    }
  });

router.get('/export',
  requirePermission('attendance.export'),
  validate({ query: z.object({ eventId: z.coerce.number().int().positive() }) }),
  async (req, res, next) => {
    try {
      const { eventId } = req.validatedQuery;
      const event = await eventService.findById(eventId, { includeDetail: false });
      const rows = await attendance.rosterFor(eventId, { limit: 5000 });

      const csv = toCsv([
        { header: 'Reference', map: (r) => r.reference },
        { header: 'First name', map: (r) => r.first_name },
        { header: 'Last name', map: (r) => r.last_name },
        { header: 'Email', map: (r) => r.email },
        { header: 'Organization', map: (r) => r.organization ?? '' },
        { header: 'Attending', map: (r) => (r.attendance_mode === 'VIRTUAL' ? 'Online' : 'In person') },
        { header: 'Registration status', map: (r) => r.status },
        { header: 'Attended', map: (r) => (r.attendance_id ? 'Yes' : 'No') },
        { header: 'Checked in at', map: (r) => r.check_in_at ?? '' },
        { header: 'Checked out at', map: (r) => r.check_out_at ?? '' },
      ], rows);

      await audit({
        actor: actorOf(req),
        action: 'attendance.exported',
        resourceType: 'event',
        resourceId: eventId,
        metadata: { rows: rows.length },
        context: contextOf(req),
      });

      return sendCsv(res, exportFilename(`${event.slug}-attendance`), csv);
    } catch (err) {
      return next(err);
    }
  });

export default router;
