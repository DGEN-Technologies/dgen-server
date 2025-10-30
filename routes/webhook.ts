import { db, g, s } from "../lib/db";
import { emit } from "../lib/sockets";
import { bail } from "../lib/utils";

export default {
  // This is what Breez calls when someone pays username@breez.fun
  async notify(req, res) {
    try {
      const { user: userId } = req.query;
      const payload = req.body;

      console.log('[Webhook] Received from Breez:', { userId, payload });

      // Store webhook request in Redis with 5 min expiry
      const requestId = crypto.randomUUID();
      await s(`webhook:${requestId}`, {
        userId,
        payload,
        timestamp: Date.now()
      });
      await db.expire(`webhook:${requestId}`, 300);

      // Send WebSocket event to browser
      emit(userId, 'webhook-request', { requestId, payload });

      // Wait for browser response (30 second timeout)
      for (let i = 0; i < 30; i++) {
        const response = await g(`webhook:${requestId}:response`);
        if (response) {
          console.log('[Webhook] Browser responded:', response);
          return res.send(response);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      console.log('[Webhook] Timeout waiting for browser');
      res.code(408).send({
        status: 'ERROR',
        reason: 'User offline or timeout'
      });
    } catch (e) {
      console.error('[Webhook] Error:', e);
      bail(res, e.message);
    }
  },

  // Browser posts response here
  async respond(req, res) {
    try {
      const { requestId, response } = req.body;

      console.log('[Webhook] Browser responding to:', requestId);

      // Store response in Redis (1 min expiry)
      await s(`webhook:${requestId}:response`, response);
      await db.expire(`webhook:${requestId}:response`, 60);

      res.send({ status: 'ok' });
    } catch (e) {
      bail(res, e.message);
    }
  }
};
