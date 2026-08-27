import { Router } from 'express';
import { z } from 'zod';
import { models } from '../../database/models/index.js';
import { serialiseFile } from '../files/storage.service.js';
import { renderCertificateHtml, WIDTH, HEIGHT } from './certificate.template.js';
import { resolveSignatureTwo } from './certificate.service.js';
import { getPage } from './browser.js';
import { ok, created } from '../../lib/response.js';
import { validate } from '../../middleware/validate.js';
import {
  authenticate, requireStaff, loadPermissions, requirePermission,
} from '../../middleware/authenticate.js';
import { record as audit } from '../audit/audit.service.js';
import { NotFoundError } from '../../lib/errors.js';

const { CertificateTemplate, File, Event } = models;

/**
 * Second-signatory templates. A template is a saved name/title/department/
 * signature-image profile applied to CARISCA's one fixed certificate design
 * — see the doc comment at the top of `certificate.template.js` for what
 * this does and doesn't cover.
 *
 * Every route sits behind `certificate_templates.manage`, including the
 * list — nobody who needs to see the list (to populate the picker on the
 * CPD/Summit edit form) lacks the permission to also manage it, so a
 * separate `.view` grant (the shape `partners.view`/`partners.manage` use)
 * would just be extra ceremony with no real access-control difference here.
 */
const router = Router();

router.use(authenticate, requireStaff, loadPermissions, requirePermission('certificate_templates.manage'));

const contextOf = (req) => ({ ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id });
const actorOf = (req) => ({ id: req.user.id, email: req.user.email });

function serialiseCertificateTemplate(template) {
  if (!template) return null;
  return {
    id: String(template.id),
    name: template.name,
    description: template.description ?? null,
    signatoryName: template.signatory_name ?? null,
    signatoryTitle: template.signatory_title ?? null,
    signatoryDepartment: template.signatory_department ?? null,
    signatureFile: serialiseFile(template.signatureFile),
    isDefault: !!template.is_default,
    isActive: !!template.is_active,
    createdAt: template.created_at,
  };
}

const templateBody = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(255).nullish(),
  signatoryName: z.string().trim().max(160).nullish(),
  signatoryTitle: z.string().trim().max(160).nullish(),
  signatoryDepartment: z.string().trim().max(255).nullish(),
  signatureFileId: z.coerce.number().int().positive().nullish(),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

const toColumns = (b) => ({
  name: b.name,
  description: b.description || null,
  signatory_name: b.signatoryName || null,
  signatory_title: b.signatoryTitle || null,
  signatory_department: b.signatoryDepartment || null,
  signature_file_id: b.signatureFileId ?? null,
  is_default: b.isDefault,
  is_active: b.isActive,
});

router.get('/', async (req, res, next) => {
  try {
    const templates = await CertificateTemplate.findAll({
      include: [{ model: File, as: 'signatureFile' }],
      order: [['name', 'ASC']],
    });
    return ok(res, templates.map(serialiseCertificateTemplate));
  } catch (err) {
    return next(err);
  }
});

router.post('/', validate({ body: templateBody }), async (req, res, next) => {
  try {
    const template = await CertificateTemplate.create({
      ...toColumns(req.body),
      created_by: req.user.id,
    });
    await template.reload({ include: [{ model: File, as: 'signatureFile' }] });

    await audit({
      actor: actorOf(req),
      action: 'certificate_template.created',
      resourceType: 'certificate_template',
      resourceId: template.id,
      after: { name: template.name },
      context: contextOf(req),
    });

    return created(res, serialiseCertificateTemplate(template), `${template.name} added.`);
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id',
  validate({ params: z.object({ id: z.coerce.number().int().positive() }), body: templateBody.partial() }),
  async (req, res, next) => {
    try {
      const template = await CertificateTemplate.findByPk(req.params.id, {
        include: [{ model: File, as: 'signatureFile' }],
      });
      if (!template) throw new NotFoundError('Certificate template');

      const before = serialiseCertificateTemplate(template);
      const fieldMap = {
        name: 'name',
        description: 'description',
        signatory_name: 'signatoryName',
        signatory_title: 'signatoryTitle',
        signatory_department: 'signatoryDepartment',
        signature_file_id: 'signatureFileId',
        is_default: 'isDefault',
        is_active: 'isActive',
      };
      const patch = {};
      for (const [column, field] of Object.entries(fieldMap)) {
        if (req.body[field] !== undefined) patch[column] = toColumns(req.body)[column];
      }
      await template.update(patch);
      await template.reload({ include: [{ model: File, as: 'signatureFile' }] });

      await audit({
        actor: actorOf(req),
        action: 'certificate_template.updated',
        resourceType: 'certificate_template',
        resourceId: template.id,
        before,
        after: serialiseCertificateTemplate(template),
        context: contextOf(req),
      });

      return ok(res, serialiseCertificateTemplate(template), 'Saved.');
    } catch (err) {
      return next(err);
    }
  });

router.delete('/:id',
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  async (req, res, next) => {
    try {
      const template = await CertificateTemplate.findByPk(req.params.id);
      if (!template) throw new NotFoundError('Certificate template');

      // Unlike a partner credited on an event, losing a template is not a
      // record of anything — an event pointing at it just falls back to the
      // artwork's own default signature, so deletion is never blocked, only
      // reported. The FK is ON DELETE SET NULL, but `CertificateTemplate` is
      // paranoid (soft-delete) — `destroy()` never issues the real SQL
      // DELETE that trigger depends on, so events are released explicitly
      // here instead of relying on it.
      const [attached] = await Event.update(
        { certificate_template_id: null },
        { where: { certificate_template_id: template.id } },
      );

      await audit({
        actor: actorOf(req),
        action: 'certificate_template.deleted',
        resourceType: 'certificate_template',
        resourceId: template.id,
        before: { name: template.name },
        context: contextOf(req),
      });
      await template.destroy();

      return ok(
        res,
        null,
        attached > 0
          ? `${template.name} removed. ${attached} event${attached === 1 ? '' : 's'} will use the default signature.`
          : `${template.name} removed.`,
      );
    } catch (err) {
      return next(err);
    }
  });

/**
 * Renders a sample certificate from whatever's currently in the form —
 * saved or not — using the exact same renderer the real download uses, so
 * what an admin previews is pixel-identical to what a participant will get.
 */
router.post('/preview',
  validate({
    body: z.object({
      signatoryName: z.string().trim().min(1).max(160),
      signatoryTitle: z.string().trim().max(160).nullish(),
      signatoryDepartment: z.string().trim().max(255).nullish(),
      signatureFileId: z.coerce.number().int().positive(),
    }),
  }),
  async (req, res, next) => {
    try {
      // resolveSignatureTwo() only returns null for incomplete input, and
      // the schema above already requires both fields it checks for.
      const signatureTwo = await resolveSignatureTwo({
        signatory_name: req.body.signatoryName,
        signatory_title: req.body.signatoryTitle,
        signatory_department: req.body.signatoryDepartment,
        signature_file_id: req.body.signatureFileId,
      });

      const html = renderCertificateHtml({
        participantName: 'Jane Sample Participant',
        eventTitle: 'A Sample CARISCA Workshop',
        dateLabel: '15th September, 2026',
        venue: 'KNUST School of Business',
        verificationCode: 'CARISCA-PREVIEW-0000-0000',
        qrDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        ...signatureTwo,
      });

      const page = await getPage();
      try {
        await page.setViewport({ width: WIDTH, height: HEIGHT });
        await page.setContent(html, { waitUntil: 'load' });
        const screenshot = await page.screenshot({ type: 'png' });
        // Not a plain `.toString('base64')` — Puppeteer's return here isn't
        // guaranteed to be a real Buffer (vs. a Uint8Array, whose own
        // toString() ignores the encoding argument and silently falls back
        // to a comma-joined list of byte values). Buffer.from() coerces it.
        const imageDataUrl = `data:image/png;base64,${Buffer.from(screenshot).toString('base64')}`;
        return ok(res, { imageDataUrl });
      } finally {
        await page.close();
      }
    } catch (err) {
      return next(err);
    }
  });

export default router;
