import { Router } from 'express';
import authRoutes from './core/auth/auth.routes.js';
import adminRoutes from './core/admin/admin.routes.js';
import userRoutes from './core/users/user.routes.js';
import publicEventRoutes from './core/events/public-event.routes.js';
import registrationRoutes from './core/registrations/registration.routes.js';
import certificateRoutes from './core/certificates/certificate.routes.js';
import attendanceRoutes from './core/attendance/attendance.routes.js';
import fileRoutes from './core/files/file.routes.js';
import partnerRoutes from './core/partners/partner.routes.js';
import cpdRoutes from './modules/cpd/cpd.routes.js';
import summitRoutes from './modules/summit/summit.routes.js';
import abstractRoutes from './modules/summit/abstract.routes.js';
import businessForumRoutes from './modules/business-forum/business-forum.routes.js';

/**
 * The one place modules are wired into the API. A new module is a directory
 * plus a line here — nothing in core needs to change.
 */
const router = Router();

router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);

// Self-service profile. Only ever acts on the caller's own record.
router.use('/users', userRoutes);

// Public discovery — no authentication. Mounted at the root so event listings
// live at /api/v1/events regardless of which module owns them.
router.use('/', publicEventRoutes);

// Registration is shared: every module registers people the same way.
router.use('/registrations', registrationRoutes);

// Certificate verification — public, reached only via the QR code or code
// printed on a certificate, never through the registration owner's session.
router.use('/certificates', certificateRoutes);

// Attendance is shared: the scanner works for any event type.
router.use('/attendance', attendanceRoutes);

// Upload and serving. Access is decided per file, not per route.
router.use('/files', fileRoutes);

// Partner organizations — a shared library, reused across every module.
router.use('/partners', partnerRoutes);

router.use('/cpd', cpdRoutes);
/*
 * abstractRoutes first, deliberately. summitRoutes' very first line is a
 * blanket `router.use(authenticate, requireStaff, loadPermissions)` with no
 * path of its own — Express runs that for every request under this prefix
 * before it ever checks which specific route matches, so it would 403 a
 * participant hitting /summit/abstracts before the request got anywhere
 * near abstractRoutes' own per-route auth. Mounting abstractRoutes first
 * means Express tries its routes (each with their own explicit auth) before
 * summitRoutes' blanket staff gate ever runs; anything it doesn't define a
 * route for falls through to summitRoutes untouched.
 */
router.use('/summit', abstractRoutes);
router.use('/summit', summitRoutes);
router.use('/business-forum', businessForumRoutes);

export default router;
