import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { sendError } from '../admin/errors.js';
import { audit } from '../audit.js';
import { isValidEmail } from '../emailAddress.js';
import { errorFields, logger } from '../logger.js';
import { parseFrom } from '../mail.js';

const ALLOWED_KEYS = new Set(['from', 'to', 'subject', 'text', 'html', 'templateId', 'params']);
const MAX_RECIPIENTS = 100;
const MAX_SUBJECT_LENGTH = 500;
const MAX_TEXT_LENGTH = 100_000;
const MAX_HTML_LENGTH = 200_000;

/**
 * @param {string} value
 * @returns {Buffer}
 */
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest();

/**
 * Validate and normalise a mail relay request body into a `Message` for the transport.
 * @param {unknown} raw
 * @returns {{ ok: true, message: import('../mail.js').Message } | { ok: false, details: { path: string, message: string }[] }}
 */
export function validateMailRelayBody(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, details: [{ path: '/', message: 'expected a JSON object' }] };
  }
  const body = /** @type {Record<string, unknown>} */ (raw);
  /** @type {{ path: string, message: string }[]} */
  const details = [];

  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(key)) {
      details.push({ path: `/${key}`, message: 'unknown property' });
    }
  }

  let from = '';
  if (typeof body.from !== 'string' || body.from.trim() === '') {
    details.push({ path: '/from', message: 'must be a non-empty email address' });
  } else if (/[\r\n]/.test(body.from)) {
    details.push({ path: '/from', message: 'must not contain line breaks' });
  } else {
    const parsedFrom = parseFrom(body.from);
    if (!isValidEmail(parsedFrom.email)) {
      details.push({ path: '/from', message: 'must be a valid email address' });
    } else {
      from = body.from.trim();
    }
  }

  /** @type {string[]} */
  const to = [];
  if (!Array.isArray(body.to) || body.to.length === 0) {
    details.push({ path: '/to', message: 'must be a non-empty array of email addresses' });
  } else if (body.to.length > MAX_RECIPIENTS) {
    details.push({ path: '/to', message: `must have at most ${MAX_RECIPIENTS} recipients` });
  } else {
    for (let i = 0; i < body.to.length; i++) {
      const item = body.to[i];
      const addr = typeof item === 'string' ? item.trim() : '';
      if (!isValidEmail(addr)) {
        details.push({ path: `/to/${i}`, message: 'must be a valid email address' });
      } else {
        to.push(addr);
      }
    }
  }

  let subject = '';
  if (typeof body.subject !== 'string' || body.subject.trim() === '') {
    details.push({ path: '/subject', message: 'must be a non-empty string' });
  } else if (/[\r\n]/.test(body.subject)) {
    details.push({ path: '/subject', message: 'must not contain line breaks' });
  } else if (body.subject.length > MAX_SUBJECT_LENGTH) {
    details.push({
      path: '/subject',
      message: `must be at most ${MAX_SUBJECT_LENGTH} characters`,
    });
  } else {
    subject = body.subject;
  }

  let text = '';
  if (typeof body.text !== 'string' || body.text.trim() === '') {
    details.push({ path: '/text', message: 'must be a non-empty string' });
  } else if (body.text.length > MAX_TEXT_LENGTH) {
    details.push({ path: '/text', message: `must be at most ${MAX_TEXT_LENGTH} characters` });
  } else {
    text = body.text;
  }

  /** @type {string | undefined} */
  let html;
  if (body.html !== undefined && body.html !== null) {
    if (typeof body.html !== 'string') {
      details.push({ path: '/html', message: 'must be a string' });
    } else if (body.html.length > MAX_HTML_LENGTH) {
      details.push({ path: '/html', message: `must be at most ${MAX_HTML_LENGTH} characters` });
    } else if (body.html !== '') {
      html = body.html;
    }
  }

  /** @type {number | undefined} */
  let templateId;
  if (body.templateId !== undefined && body.templateId !== null) {
    if (
      typeof body.templateId !== 'number' ||
      !Number.isSafeInteger(body.templateId) ||
      body.templateId < 1
    ) {
      details.push({ path: '/templateId', message: 'must be a positive integer' });
    } else {
      templateId = body.templateId;
    }
  }

  /** @type {Record<string, unknown>} */
  let params = {};
  if (body.params !== undefined && body.params !== null) {
    if (typeof body.params !== 'object' || Array.isArray(body.params)) {
      details.push({ path: '/params', message: 'must be an object' });
    } else {
      params = /** @type {Record<string, unknown>} */ (body.params);
    }
  }

  if (details.length > 0) return { ok: false, details };

  /** @type {import('../mail.js').Message} */
  const message = {
    from,
    to,
    subject,
    text,
    ...(html !== undefined ? { html } : {}),
    ...(templateId !== undefined ? { template: { id: templateId, params } } : {}),
  };
  return { ok: true, message };
}

/**
 * Mail relay endpoint for relying parties (`POST <issuer>/api/mail`, also served at
 * `POST <issuer>/admin/api/v1/mail`). Off (404) when `token` (`MAIL_RELAY_TOKEN`) is empty.
 * @param {{
 *   pool: import('pg').Pool,
 *   token: string,
 *   mailer: import('../mail.js').Mailer,
 *   failureLimit?: number,
 *   windowMs?: number,
 * }} deps
 * @returns {express.Router}
 */
export function createMailRelayRouter({
  pool,
  token,
  mailer,
  failureLimit = 20,
  windowMs = 10 * 60 * 1000,
}) {
  const expected = token ? sha256(token) : null;
  const parseJson = express.json({ limit: '100kb' });
  /** @type {Map<string, number[]>} */
  const failures = new Map();

  /**
   * @param {string} key
   * @param {number} now
   */
  function recent(key, now) {
    const kept = (failures.get(key) ?? []).filter((t) => now - t < windowMs);
    if (kept.length) failures.set(key, kept);
    else failures.delete(key);
    return kept;
  }

  /** @type {import('express').RequestHandler} */
  const jsonBody = (req, res, next) => {
    parseJson(req, res, (/** @type {any} */ err) => {
      if (err) {
        const message =
          err.type === 'entity.too.large' ? 'Request body too large' : 'Invalid JSON body';
        return void sendError(res, 400, 'invalid_request', message);
      }
      next();
    });
  };

  /** @type {import('express').RequestHandler} */
  const handlePost = async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (expected === null) {
      return void sendError(res, 404, 'not_found', 'Not found');
    }

    const ip = req.ip ?? null;
    const key = ip ?? 'unknown';

    /** @param {'missing' | 'malformed' | 'invalid'} reason */
    const failAuth = async (reason) => {
      const now = Date.now();
      if (recent(key, now).length > failureLimit) {
        return void sendError(
          res,
          429,
          'rate_limited',
          'Too many failed attempts; try again later',
        );
      }
      failures.set(key, [...recent(key, now), now]);
      await audit(pool, { action: 'mail_relay.auth_failed', ip, details: { reason } });
      res.set('WWW-Authenticate', 'Bearer');
      sendError(res, 401, 'unauthorized', 'Missing or invalid mail relay token');
    };

    const header = req.headers.authorization;
    if (header === undefined) return void (await failAuth('missing'));
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const value = match?.[1];
    if (!value) return void (await failAuth('malformed'));
    if (!timingSafeEqual(sha256(value), expected)) return void (await failAuth('invalid'));

    const sent =
      Number(req.headers['content-length'] ?? 0) > 0 ||
      req.headers['transfer-encoding'] !== undefined;
    if (!sent || req.body === undefined) {
      return void sendError(res, 400, 'invalid_request', 'Request body required', [
        { path: '/', message: 'required' },
      ]);
    }

    const checked = validateMailRelayBody(req.body);
    if (!checked.ok) {
      return void sendError(res, 400, 'invalid_request', 'Invalid request', checked.details);
    }

    const { message } = checked;
    const recipients = Array.isArray(message.to) ? message.to.length : 1;
    try {
      if (!mailer.send) throw new Error('Mailer does not support relay send');
      await mailer.send(message);
    } catch (err) {
      const name = /** @type {any} */ (err)?.name;
      const error = typeof name === 'string' ? name : 'Error';
      logger.error({ err: errorFields(err) }, 'mail relay send failed');
      await audit(pool, {
        action: 'mail_error',
        ip,
        details: { kind: 'relay', error },
      }).catch(() => {});
      return void sendError(res, 502, 'mail_error', 'Mail delivery failed');
    }

    await audit(pool, {
      action: 'mail_relay.sent',
      ip,
      details: {
        recipients,
        ...(message.template ? { templateId: message.template.id } : {}),
      },
    });
    res.status(200).json({ ok: true });
  };

  const router = express.Router();
  router.post(['/api/mail', '/admin/api/v1/mail'], jsonBody, handlePost);
  return router;
}
