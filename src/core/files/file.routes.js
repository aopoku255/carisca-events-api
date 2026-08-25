import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import * as storage from './storage.service.js';
import { models } from '../../database/models/index.js';
import { ok, created } from '../../lib/response.js';
import { validate } from '../../middleware/validate.js';
import {
  authenticate, requireStaff, loadPermissions, loadPermissionsOptional,
  requirePermission, optionalAuthenticate,
} from '../../middleware/authenticate.js';
import { record as audit } from '../audit/audit.service.js';
import { AuthorizationError, NotFoundError, ValidationError } from '../../lib/errors.js';

const { Registration } = models;

const router = Router();

/**
 * Uploads are buffered in memory rather than written to a temp directory: the
 * file has to be read in full to verify its type before it is trusted, and the
 * per-purpose limits are small enough that memory is the simpler, safer place
 * for it to live.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // hard ceiling; per-purpose limits are tighter
    files: 1,
  },
});

router.post('/upload',
  authenticate,
  requireStaff,
  loadPermissions,
  requirePermission('files.upload'),
  upload.single('file'),
  validate({
    body: z.object({
      purpose: z.enum(Object.keys(storage.PURPOSES)),
    }),
  }),
  async (req, res, next) => {
    try {
      if (!req.file) {
        throw new ValidationError([{ field: 'file', message: 'Choose a file to upload.' }]);
      }

      const file = await storage.store({
        buffer: req.file.buffer,
        originalName: req.file.originalname,
        declaredMime: req.file.mimetype,
        purpose: req.body.purpose,
        uploadedBy: req.user.id,
      });

      await audit({
        actor: { id: req.user.id, email: req.user.email },
        action: 'file.uploaded',
        resourceType: 'file',
        resourceId: file.id,
        after: { purpose: file.purpose, mime: file.mime_type, bytes: Number(file.size_bytes) },
        context: { ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id },
      });

      return created(res, storage.serialiseFile(file), 'Uploaded.');
    } catch (err) {
      return next(err);
    }
  });

/**
 * Decides whether this caller may read this file.
 *
 * PUBLIC files — event banners, speaker photos — are open, because they appear
 * on pages that require no account. Everything else is checked: a scanned
 * student ID belongs to the participant who uploaded it and to staff with a
 * reason to see it, and to nobody else.
 */
async function mayRead(file, req) {
  if (file.visibility === 'PUBLIC') return true;
  if (!req.user) return false;

  if (String(file.uploaded_by) === String(req.user.id)) return true;

  // Evidence attached to a registration follows that registration's rules.
  if (file.purpose === 'registration_evidence') {
    const owner = await Registration.findOne({ where: { evidence_file_id: file.id } });
    if (owner && String(owner.user_id) === String(req.user.id)) return true;
  }

  const permissions = req.permissions ?? new Set();
  return permissions.has('files.manage') || permissions.has('cpd.registration.view');
}

router.get('/:id',
  optionalAuthenticate,
  loadPermissionsOptional,
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  async (req, res, next) => {
    try {
      const file = await storage.find(req.params.id);

      if (!await mayRead(file, req)) {
        // 404 rather than 403: whether a private file exists is itself
        // information an anonymous caller should not be able to probe for.
        throw new NotFoundError('File');
      }

      const stream = await storage.streamFor(file);

      res.setHeader('Content-Type', file.mime_type);
      res.setHeader('Content-Length', String(file.size_bytes));
      // The browser must not second-guess the type we verified on upload.
      res.setHeader('X-Content-Type-Options', 'nosniff');

      // SVG can carry script, so it is never rendered inline from our origin.
      const inlineSafe = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
      res.setHeader(
        'Content-Disposition',
        inlineSafe.includes(file.mime_type)
          ? 'inline'
          : `attachment; filename="${encodeURIComponent(file.original_name)}"`,
      );

      res.setHeader(
        'Cache-Control',
        file.visibility === 'PUBLIC'
          // Content is immutable — a replacement gets a new id.
          ? 'public, max-age=31536000, immutable'
          : 'no-store, private',
      );

      /*
       * A PUBLIC file exists to be embedded by the public website, which is a
       * separate app on a separate origin — and, once the API is on its own
       * domain rather than a subdomain, a separate site too. The app-wide
       * same-site policy set in app.js blocks exactly that, so an event
       * banner silently fails to load with ERR_BLOCKED_BY_RESPONSE.NotSameSite
       * while every other request succeeds.
       *
       * Only PUBLIC files are opened up. Anything private keeps the stricter
       * app-wide policy, so a certificate or a piece of registration evidence
       * still cannot be embedded from somewhere else.
       */
      if (file.visibility === 'PUBLIC') {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      }

      stream.on('error', () => next(new NotFoundError('File')));
      return stream.pipe(res);
    } catch (err) {
      return next(err);
    }
  });

router.delete('/:id',
  authenticate,
  requireStaff,
  loadPermissions,
  requirePermission('files.manage'),
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  async (req, res, next) => {
    try {
      const file = await storage.find(req.params.id);
      await audit({
        actor: { id: req.user.id, email: req.user.email },
        action: 'file.deleted',
        resourceType: 'file',
        resourceId: file.id,
        before: { purpose: file.purpose, originalName: file.original_name },
        context: { ip: req.ip, requestId: req.id },
      });
      await storage.remove(file);
      return ok(res, null, 'Deleted.');
    } catch (err) {
      return next(err);
    }
  });

export default router;
