import { Router } from 'express';

/**
 * CARISCA Summit module.
 *
 * Scaffold only. Registration, payments, attendance and certificates already work through the shared core; this module adds Summit-specific rules when the work starts.
 */
const router = Router();

router.get('/', (req, res) => res.json({
  success: true,
  message: 'CARISCA Summit module is registered but not yet implemented.',
  data: { module: 'summit', status: 'scaffold' },
}));

export default router;
