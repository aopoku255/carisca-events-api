import { Router } from 'express';

/**
 * CPD module.
 *
 * Events, registration, attendance, certificates and evaluation for CPD. Built in Week 1 on top of the shared core services.
 */
const router = Router();

router.get('/', (req, res) => res.json({
  success: true,
  message: 'CPD module is registered but not yet implemented.',
  data: { module: 'cpd', status: 'scaffold' },
}));

export default router;
