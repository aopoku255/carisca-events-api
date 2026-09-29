import { Router } from 'express';
import { verifyPaystackSignature } from './paystack.client.js';
import { verifyOgatewaySignature } from './ogateway.client.js';
import { processWebhookEvent, processOgatewayWebhook } from './payment.service.js';
import { logger } from '../../lib/logger.js';

const router = Router();

/**
 * `req.body` is the raw `Buffer` `app.js` arranges for everything under
 * `/api/v1/webhooks` — signature verification hashes those exact bytes, so
 * parsing happens only after the signature checks out.
 *
 * Always answers 200 once the event is recognised as Paystack's, even for
 * an event type this system doesn't act on — Paystack retries on anything
 * else, and there is nothing to retry into.
 */
router.post('/paystack', async (req, res) => {
  const rawBody = req.body;
  const signature = req.get('x-paystack-signature');
  const signatureValid = verifyPaystackSignature(rawBody, signature);

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    logger.warn('paystack webhook: body was not valid JSON');
    return res.status(400).json({ success: false, message: 'Invalid payload.' });
  }

  const eventType = payload?.event;
  const data = payload?.data;
  // Paystack sends no dedicated event-id field; the transaction's own
  // numeric id is stable across a retried delivery of the same event.
  const providerEventId = `${eventType}:${data?.id ?? data?.reference ?? 'unknown'}`;

  try {
    await processWebhookEvent({
      eventType, data, providerEventId, rawPayload: payload, signatureValid,
    });
  } catch (err) {
    // Logged, not surfaced as a 5xx — Paystack would just retry an event
    // that already failed for a reason retrying won't fix, and the
    // reconciliation sweep is the real safety net here.
    logger.error({ err: err.message, eventType, providerEventId }, 'paystack webhook processing failed');
  }

  return res.status(200).json({ success: true });
});

/**
 * OGateway callbacks. Same raw-body arrangement as above; the signature is an
 * HMAC-SHA512 of the exact bytes in `x-ogateway-signature`. Answers 200 for
 * anything it recognises as JSON so a permanent failure isn't retried.
 */
router.post('/ogateway', async (req, res) => {
  const rawBody = req.body;
  const signatureValid = verifyOgatewaySignature(rawBody, req.get('x-ogateway-signature'));

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    logger.warn('ogateway webhook: body was not valid JSON');
    return res.status(400).json({ success: false, message: 'Invalid payload.' });
  }

  try {
    await processOgatewayWebhook({ payload, signatureValid });
  } catch (err) {
    logger.error({ err: err.message, id: payload?.id }, 'ogateway webhook processing failed');
  }

  return res.status(200).json({ success: true });
});

export default router;
