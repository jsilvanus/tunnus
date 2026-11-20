import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

const RATE_LIMIT_REASONS = new Set(['email', 'ip', 'daily']);

/**
 * @param {string} value
 * @returns {Buffer}
 */
const sha256 = (value) => createHash('sha256').update(value).digest();

/**
 * Metrics for one app instance. Counters are derived from audit actions (see
 * `countAuditAction`); gauges are read at scrape time from the database.
 */
export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'tunnus_' });

  /** @type {import('pg').Pool | null} */
  let scrapePool = null;

  const signIns = new Counter({
    name: 'tunnus_sign_ins_total',
    help: 'Sign-ins completed for an existing user',
    registers: [registry],
  });
  const signUps = new Counter({
    name: 'tunnus_sign_ups_total',
    help: 'Accounts created through self sign-up',
    registers: [registry],
  });
  const codeFailures = new Counter({
    name: 'tunnus_code_failures_total',
    help: 'Rejected sign-in codes and links',
    registers: [registry],
  });
  const mailErrors = new Counter({
    name: 'tunnus_mail_errors_total',
    help: 'Sign-in mails that failed to send',
    registers: [registry],
  });
  const rateLimitHits = new Counter({
    name: 'tunnus_rate_limit_hits_total',
    help: 'Requests refused by a sign-in rate limit',
    labelNames: ['reason'],
    registers: [registry],
  });
  const adminAuthFailures = new Counter({
    name: 'tunnus_admin_auth_failures_total',
    help: 'Admin API requests with a missing or invalid token',
    registers: [registry],
  });
  const adminRequests = new Counter({
    name: 'tunnus_admin_requests_total',
    help: 'Admin API operations performed',
    registers: [registry],
  });
  const usersDeletedInactive = new Counter({
    name: 'tunnus_users_deleted_inactive_total',
    help: 'Accounts deleted by the inactivity cleanup',
    registers: [registry],
  });
  const inactiveWarnings = new Counter({
    name: 'tunnus_inactive_warnings_sent_total',
    help: 'Inactivity warning mails sent',
    registers: [registry],
  });
  const mailRelayed = new Counter({
    name: 'tunnus_mail_relayed_total',
    help: 'Mails sent through the mail relay endpoint',
    registers: [registry],
  });
  const mailRelayAuthFailures = new Counter({
    name: 'tunnus_mail_relay_auth_failures_total',
    help: 'Mail relay requests with a missing or invalid token',
    registers: [registry],
  });

  /** @type {Gauge<'status'>} */
  const users = new Gauge({
    name: 'tunnus_users',
    help: 'Accounts by status',
    labelNames: ['status'],
    registers: [registry],
    collect: async () => {
      if (!scrapePool) return;
      const { rows } = await scrapePool.query(
        'SELECT status, count(*)::int AS n FROM users GROUP BY status',
      );
      users.reset();
      for (const row of rows) users.set({ status: row.status }, row.n);
    },
  });

  const signingKeyAge = new Gauge({
    name: 'tunnus_signing_key_age_seconds',
    help: 'Age of the active signing key, in seconds (0 when there is none)',
    registers: [registry],
    collect: async () => {
      if (!scrapePool) return;
      const { rows } = await scrapePool.query(
        `SELECT EXTRACT(EPOCH FROM (now() - COALESCE(activated_at, created_at)))::float8 AS age
           FROM signing_keys WHERE status = 'active' LIMIT 1`,
      );
      signingKeyAge.set(rows[0]?.age ?? 0);
    },
  });

  const cleanupLastSuccess = new Gauge({
    name: 'tunnus_cleanup_last_success_timestamp_seconds',
    help: 'Unix time of the last successful cleanup run (0 before the first run)',
    registers: [registry],
  });

  /**
   * Count an audit event. Called by `audit()` after the row is written.
   * @param {string} action
   * @param {Record<string, unknown>} [details]
   */
  function countAuditAction(action, details = {}) {
    switch (action) {
      case 'signin':
      case 'signin_continue':
        return signIns.inc();
      case 'signup':
        return signUps.inc();
      case 'code_failed':
        return codeFailures.inc();
      case 'mail_error':
        return mailErrors.inc();
      case 'rate_limited': {
        const reason = typeof details.reason === 'string' ? details.reason : '';
        return rateLimitHits.inc({ reason: RATE_LIMIT_REASONS.has(reason) ? reason : 'other' });
      }
      case 'admin.auth_failed':
        return adminAuthFailures.inc();
      case 'user.deleted_inactive':
        return usersDeletedInactive.inc();
      case 'user.inactive_warned':
        return inactiveWarnings.inc();
      case 'mail_relay.sent':
        return mailRelayed.inc();
      case 'mail_relay.auth_failed':
        return mailRelayAuthFailures.inc();
      default:
        if (action.startsWith('admin.')) adminRequests.inc();
    }
  }

  /** @param {Date} date */
  function setCleanupSuccess(date) {
    cleanupLastSuccess.set(date.getTime() / 1000);
  }

  /**
   * The `/metrics` route. Off (404) when `token` is empty.
   * @param {{ pool: import('pg').Pool, token: string }} options
   */
  function router({ pool, token }) {
    scrapePool = pool;
    const expected = token ? sha256(token) : null;
    const r = express.Router();
    r.get('/metrics', async (req, res) => {
      if (expected === null) return void res.status(404).type('text/plain').send('Not found');
      const match = /^Bearer (.+)$/.exec(req.get('authorization') ?? '');
      if (!match || !timingSafeEqual(sha256(match[1]), expected)) {
        res.set('WWW-Authenticate', 'Bearer');
        return void res.status(401).type('text/plain').send('Unauthorized');
      }
      try {
        const body = await registry.metrics();
        res.set('Cache-Control', 'no-store');
        res.type(registry.contentType).send(body);
      } catch {
        res.status(500).type('text/plain').send('Metrics unavailable');
      }
    });
    return r;
  }

  return { registry, countAuditAction, setCleanupSuccess, router };
}

/** @typedef {ReturnType<typeof createMetrics>} Metrics */
