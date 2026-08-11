import { Router } from 'express';

/**
 * Business Forum module.
 *
 * Scaffold only. Same shape as the Summit module.
 */
const router = Router();

router.get('/', (req, res) => res.json({
  success: true,
  message: 'Business Forum module is registered but not yet implemented.',
  data: { module: 'business-forum', status: 'scaffold' },
}));

export default router;
