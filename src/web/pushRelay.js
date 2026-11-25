import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { sendError } from '../admin/errors.js';
import { audit } from '../audit.js';
import { errorFields, logger } from '../logger.js';
import {
  savePushSubscription,
  deletePushSubscription,
  getSubscriptionsForUser,
  sendPushNotification,
} from '../push.js';

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest();

/**
 * Validate subscription payload from client.
 * @param {any} body
 */
export function validateSubscriptionBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, message: 'expected a JSON object' };
  }
  if (typeof body.endpoint !== 'string' || !body.endpoint.startsWith('https://')) {
    return { ok: false, message: 'endpoint must be a valid HTTPS URL' };
  }
  if (!body.keys || typeof body.keys !== 'object') {
    return { ok: false, message: 'keys object required' };
  }
  if (typeof body.keys.p256dh !== 'string' || !body.keys.p256dh) {
    return { ok: false, message: 'keys.p256dh is required' };
  }
  if (typeof body.keys.auth !== 'string' || !body.keys.auth) {
    return { ok: false, message: 'keys.auth is required' };
  }
  return { ok: true };
}

/**
 * Web Push router providing:
 * - GET  /api/push/key         (public, returns VAPID public key)
 * - POST /api/push/subscribe   (register or update subscription)
 * - POST /api/push/unsubscribe (remove subscription)
 * - POST /api/push/send        (authorized relay endpoint for apps using Bearer token)
 *
 * @param {{
 *   pool: import('pg').Pool,
 *   token: string,
 *   vapidPublicKey: string,
 *   failureLimit?: number,
 *   windowMs?: number,
 * }} deps
 * @returns {express.Router}
 */
export function createPushRouter({
  pool,
  token,
  vapidPublicKey,
  failureLimit = 20,
  windowMs = 10 * 60 * 1000,
}) {
  const router = express.Router();
  const expected = token ? sha256(token) : null;
  const parseJson = express.json({ limit: '64kb' });
  /** @type {Map<string, number[]>} */
  const failures = new Map();

  function recent(key, now) {
    const kept = (failures.get(key) ?? []).filter((t) => now - t < windowMs);
    if (kept.length) failures.set(key, kept);
    else failures.delete(key);
    return kept;
  }

  const jsonBody = (req, res, next) => {
    parseJson(req, res, (err) => {
      if (err) return void sendError(res, 400, 'invalid_request', 'Invalid JSON body');
      next();
    });
  };

  // 1. GET /api/push/key
  router.get('/api/push/key', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    if (!vapidPublicKey) {
      return void sendError(res, 404, 'not_found', 'Web push not configured');
    }
    res.json({ publicKey: vapidPublicKey });
  });

  // 2. POST /api/push/subscribe (client subscription)
  router.post('/api/push/subscribe', jsonBody, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const checked = validateSubscriptionBody(req.body);
    if (!checked.ok) {
      return void sendError(res, 400, 'invalid_request', checked.message);
    }

    try {
      const userAgent = req.headers['user-agent'] || '';
      // If user is authenticated in Tunnus session or client provided an identified userId
      const userId = req.body.userId || null;
      const sub = await savePushSubscription(pool, {
        userId,
        endpoint: req.body.endpoint,
        p256dh: req.body.keys.p256dh,
        auth: req.body.keys.auth,
        userAgent,
      });
      res.status(200).json({ ok: true, id: sub.id });
    } catch (err) {
      logger.error({ err: errorFields(err) }, 'push subscription save failed');
      sendError(res, 500, 'internal_error', 'Failed to save push subscription');
    }
  });

  // 3. POST /api/push/unsubscribe
  router.post('/api/push/unsubscribe', jsonBody, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== 'string' || !endpoint) {
      return void sendError(res, 400, 'invalid_request', 'endpoint is required');
    }
    try {
      await deletePushSubscription(pool, endpoint);
      res.status(200).json({ ok: true });
    } catch (err) {
      logger.error({ err: errorFields(err) }, 'push subscription removal failed');
      sendError(res, 500, 'internal_error', 'Failed to remove push subscription');
    }
  });

  // 4. POST /api/push/send (relay send for applications)
  const handleRelaySend = async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (expected === null) {
      return void sendError(res, 404, 'not_found', 'Push relay not enabled');
    }

    const ip = req.ip ?? null;
    const key = ip ?? 'unknown';

    const failAuth = async (reason) => {
      const now = Date.now();
      if (recent(key, now).length > failureLimit) {
        return void sendError(res, 429, 'rate_limited', 'Too many failed attempts');
      }
      failures.set(key, [...recent(key, now), now]);
      await audit(pool, { action: 'push_relay.auth_failed', ip, details: { reason } });
      res.set('WWW-Authenticate', 'Bearer');
      sendError(res, 401, 'unauthorized', 'Missing or invalid push relay token');
    };

    const header = req.headers.authorization;
    if (!header) return void (await failAuth('missing'));
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const value = match?.[1];
    if (!value) return void (await failAuth('malformed'));
    if (!timingSafeEqual(sha256(value), expected)) return void (await failAuth('invalid'));

    const { userId, endpoint, notification } = req.body || {};
    if (!notification || typeof notification !== 'object' || !notification.title) {
      return void sendError(res, 400, 'invalid_request', 'notification.title is required');
    }

    if (!userId && !endpoint) {
      return void sendError(res, 400, 'invalid_request', 'Either userId or endpoint is required');
    }

    try {
      let targets = [];
      if (endpoint) {
        // Direct endpoint send
        const { rows } = await pool.query(
          'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE endpoint = $1',
          [endpoint]
        );
        targets = rows;
      } else if (userId) {
        // All active endpoints for that user
        targets = await getSubscriptionsForUser(pool, userId);
      }

      if (targets.length === 0) {
        return void res.status(200).json({ ok: true, delivered: 0, reason: 'no_subscriptions' });
      }

      let delivered = 0;
      let expired = 0;

      for (const target of targets) {
        try {
          const result = await sendPushNotification(pool, target, notification);
          if (result.ok) delivered++;
          if (result.expired) expired++;
        } catch {
          // sendPushNotification logs details
        }
      }

      await audit(pool, {
        action: 'push_relay.sent',
        ip,
        details: { userId, count: targets.length, delivered, expired },
      });

      res.status(200).json({ ok: true, total: targets.length, delivered, expired });
    } catch (err) {
      logger.error({ err: errorFields(err) }, 'push relay processing error');
      sendError(res, 500, 'internal_error', 'Push dispatch failed');
    }
  };

  router.post(['/api/push/send', '/admin/api/v1/push/send'], jsonBody, handleRelaySend);

  return router;
}
