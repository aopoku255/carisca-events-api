import { Router } from 'express';
import { z } from 'zod';
import { models } from '../../database/models/index.js';
import { ok } from '../../lib/response.js';
import { validate } from '../../middleware/validate.js';
import { NotFoundError } from '../../lib/errors.js';

const { Certificate } = models;

const router = Router();

/**
 * Public, unauthenticated by design — this is the endpoint the QR code on a
 * certificate points at. Anyone holding a certificate (or its code) can
 * confirm it's genuine without an account; nothing here requires knowing
 * who's asking.
 *
 * Deliberately doesn't leak more than the certificate itself already shows:
 * the participant's name, the event, and the date. Whether a `Certificate`
 * row exists at all for a code that was never issued isn't distinguished
 * from a wrong guess — both are a 404.
 */
router.get('/verify/:code',
  validate({ params: z.object({ code: z.string().trim().min(1).max(64) }) }),
  async (req, res, next) => {
    try {
      const certificate = await Certificate.findOne({
        where: { verification_code: req.params.code },
      });
      if (!certificate) throw new NotFoundError('Certificate');

      const snapshot = certificate.issued_snapshot || {};
      return ok(res, {
        valid: certificate.status === 'ISSUED',
        status: certificate.status,
        verificationCode: certificate.verification_code,
        participantName: snapshot.participantName,
        eventTitle: snapshot.eventTitle,
        dateLabel: snapshot.dateLabel,
        venue: snapshot.venue,
        issuedAt: certificate.issued_at,
        revokedAt: certificate.revoked_at,
        revokedReason: certificate.status === 'REVOKED' ? certificate.revoked_reason : undefined,
      });
    } catch (err) {
      return next(err);
    }
  });

export default router;
