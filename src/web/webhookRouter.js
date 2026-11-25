import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { sendError } from '../admin/errors.js';
import { audit } from '../audit.js';
import { errorFields, logger } from '../logger.js';
import { dispatchWebhookEvent } from '../webhooks.js';

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest();

/**
 * Webhook Router:
 * - POST /api/events or /api/v1/events (dispatch domain events to matching hooks)
 * - GET  /api/v1/notifications/hooks (list hooks)
 * - POST /api/v1/notifications/hooks (register hook)
 * - PUT  /api/v1/notifications/hooks/:id (update hook)
 * - DELETE /api/v1/notifications/hooks/:id (delete hook)
 * - POST /api/v1/notifications/hooks/:id/test (trigger test dispatch)
 * - GET  /api/v1/notifications/deliveries (list deliveries)
 *
 * @param {{
 *   pool: import('pg').Pool,
 *   token: string,
 *   failureLimit?: number,
 *   windowMs?: number,
 * }} deps
 */
export function createWebhookRouter({
  pool,
  token,
  failureLimit = 20,
  windowMs = 10 * 60 * 1000,
}) {
  const router = express.Router();
  const expected = token ? sha256(token) : null;
  const parseJson = express.json({ limit: '256kb' });
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

  const requireAuth = async (req, res, next) => {
    if (expected === null) {
      return void sendError(res, 404, 'not_found', 'Webhook service not configured');
    }
    const ip = req.ip ?? null;
    const key = ip ?? 'unknown';

    const fail = async (reason) => {
      const now = Date.now();
      if (recent(key, now).length > failureLimit) {
        return void sendError(res, 429, 'rate_limited', 'Too many failed attempts');
      }
      failures.set(key, [...recent(key, now), now]);
      await audit(pool, { action: 'webhooks.auth_failed', ip, details: { reason } });
      res.set('WWW-Authenticate', 'Bearer');
      sendError(res, 401, 'unauthorized', 'Missing or invalid bearer token');
    };

    const header = req.headers.authorization;
    if (!header) return void (await fail('missing'));
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const value = match?.[1];
    if (!value) return void (await fail('malformed'));
    if (!timingSafeEqual(sha256(value), expected)) return void (await fail('invalid'));
    next();
  };

  // 1. Ingest & Dispatch Domain Event: POST /api/events or /api/v1/events
  const handleEventDispatch = async (req, res) => {
    const { event, parishSlug, tenant, asset, context } = req.body || {};
    if (!event || typeof event !== 'string') {
      return void sendError(res, 400, 'invalid_request', 'event name is required');
    }

    const effectiveTenant = String(tenant || parishSlug || '').trim();
    const payload = {
      event,
      timestamp: req.body.timestamp || new Date().toISOString(),
      parishSlug: effectiveTenant,
      tenant: effectiveTenant,
      asset: asset || {},
      context: context || {},
    };

    try {
      const results = await dispatchWebhookEvent(pool, effectiveTenant, event, payload);
      await audit(pool, {
        action: 'webhooks.event_dispatched',
        ip: req.ip,
        details: { event, tenant: effectiveTenant, hookCount: results.length },
      });
      res.status(200).json({ ok: true, dispatched: results.length, results });
    } catch (err) {
      logger.error({ err: errorFields(err) }, 'webhook event dispatch failed');
      sendError(res, 500, 'internal_error', 'Event dispatch failed');
    }
  };

  router.post(['/api/events', '/api/v1/events', '/admin/api/v1/events'], jsonBody, requireAuth, handleEventDispatch);

  // 2. GET /api/v1/notifications/hooks (list hooks)
  router.get('/api/v1/notifications/hooks', requireAuth, async (req, res) => {
    const tenant = String(req.query.tenant || req.query.parishSlug || '').trim();
    try {
      const query = tenant
        ? `SELECT h.*, count(d.id)::int as deliveries_count
           FROM notification_hooks h
           LEFT JOIN notification_deliveries d ON d.hook_id = h.id
           WHERE h.tenant = $1 OR h.tenant = ''
           GROUP BY h.id ORDER BY h.created_at DESC`
        : `SELECT h.*, count(d.id)::int as deliveries_count
           FROM notification_hooks h
           LEFT JOIN notification_deliveries d ON d.hook_id = h.id
           GROUP BY h.id ORDER BY h.created_at DESC`;
      const params = tenant ? [tenant] : [];
      const { rows } = await pool.query(query, params);
      res.status(200).json(rows);
    } catch (err) {
      logger.error({ err: errorFields(err) }, 'failed to list notification hooks');
      sendError(res, 500, 'internal_error', 'Failed to list hooks');
    }
  });

  // 3. POST /api/v1/notifications/hooks (create hook)
  router.post('/api/v1/notifications/hooks', jsonBody, requireAuth, async (req, res) => {
    const { name, url, events, secret, tenant, parishSlug } = req.body || {};
    if (!name || typeof name !== 'string' || !url || typeof url !== 'string') {
      return void sendError(res, 400, 'invalid_request', 'name and url are required');
    }

    try {
      new URL(url);
    } catch {
      return void sendError(res, 400, 'invalid_request', 'Invalid webhook URL');
    }

    const effectiveTenant = String(tenant || parishSlug || '').trim();
    const eventList = Array.isArray(events) ? events : [];

    try {
      const { rows } = await pool.query(
        `INSERT INTO notification_hooks (tenant, name, url, events, secret, active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, now(), now())
         RETURNING *`,
        [effectiveTenant, name.trim(), url.trim(), eventList, secret?.trim() || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      logger.error({ err: errorFields(err) }, 'failed to create notification hook');
      sendError(res, 500, 'internal_error', 'Failed to create hook');
    }
  });

  // 4. PUT /api/v1/notifications/hooks/:id (update hook)
  router.put('/api/v1/notifications/hooks/:id', jsonBody, requireAuth, async (req, res) => {
    const { id } = req.params;
    const { name, url, events, secret, active } = req.body || {};

    try {
      const { rows: existing } = await pool.query('SELECT * FROM notification_hooks WHERE id = $1', [id]);
      if (existing.length === 0) {
        return void sendError(res, 404, 'not_found', 'Hook not found');
      }

      const prev = existing[0];
      const newName = name !== undefined ? String(name).trim() : prev.name;
      const newUrl = url !== undefined ? String(url).trim() : prev.url;
      const newEvents = Array.isArray(events) ? events : prev.events;
      const newSecret = secret !== undefined ? (secret ? String(secret).trim() : null) : prev.secret;
      const newActive = active !== undefined ? Boolean(active) : prev.active;

      const { rows } = await pool.query(
        `UPDATE notification_hooks
         SET name = $1, url = $2, events = $3, secret = $4, active = $5, updated_at = now()
         WHERE id = $6
         RETURNING *`,
        [newName, newUrl, newEvents, newSecret, newActive, id]
      );
      res.status(200).json(rows[0]);
    } catch (err) {
      logger.error({ err: errorFields(err) }, 'failed to update notification hook');
      sendError(res, 500, 'internal_error', 'Failed to update hook');
    }
  });

  // 5. DELETE /api/v1/notifications/hooks/:id (delete hook)
  router.delete('/api/v1/notifications/hooks/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
      const { rowCount } = await pool.query('DELETE FROM notification_hooks WHERE id = $1', [id]);
      if (rowCount === 0) return void sendError(res, 404, 'not_found', 'Hook not found');
      res.status(200).json({ ok: true, deleted: true });
    } catch (err) {
      logger.error({ err: errorFields(err) }, 'failed to delete notification hook');
      sendError(res, 500, 'internal_error', 'Failed to delete hook');
    }
  });

  // 6. POST /api/v1/notifications/hooks/:id/test (trigger test dispatch)
  router.post('/api/v1/notifications/hooks/:id/test', jsonBody, requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
      const { rows } = await pool.query('SELECT * FROM notification_hooks WHERE id = $1', [id]);
      if (rows.length === 0) return void sendError(res, 404, 'not_found', 'Hook not found');
      const hook = rows[0];

      const testPayload = {
        event: 'asset.created',
        timestamp: new Date().toISOString(),
        parishSlug: hook.tenant || 'test-seurakunta',
        tenant: hook.tenant || 'test-seurakunta',
        asset: {
          id: '00000000-0000-0000-0000-000000000000',
          title: 'Testilogo (Webhook Testi)',
          format: 'svg',
          kind: 'logo',
        },
        context: {
          channel: 'test_dispatch',
        },
      };

      const results = await dispatchWebhookEvent(pool, hook.tenant, 'asset.created', testPayload);
      res.status(200).json({ ok: true, test: true, results });
    } catch (err) {
      logger.error({ err: errorFields(err) }, 'test dispatch failed');
      sendError(res, 500, 'internal_error', 'Test dispatch failed');
    }
  });

  // 7. GET /api/v1/notifications/deliveries (delivery log history)
  router.get('/api/v1/notifications/deliveries', requireAuth, async (req, res) => {
    const hookId = req.query.hookId ? String(req.query.hookId) : null;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);

    try {
      const query = hookId
        ? 'SELECT * FROM notification_deliveries WHERE hook_id = $1 ORDER BY created_at DESC LIMIT $2'
        : 'SELECT * FROM notification_deliveries ORDER BY created_at DESC LIMIT $1';
      const params = hookId ? [hookId, limit] : [limit];
      const { rows } = await pool.query(query, params);
      res.status(200).json(rows);
    } catch (err) {
      logger.error({ err: errorFields(err) }, 'failed to list deliveries');
      sendError(res, 500, 'internal_error', 'Failed to list deliveries');
    }
  });

  return router;
}
