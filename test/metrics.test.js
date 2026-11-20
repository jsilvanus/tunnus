import { describe, it, expect } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import http from 'node:http';

/**
 * Serve `app` on an ephemeral port for one request.
 * @param {any} app
 * @param {string} path
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{ status: number, headers: Headers, text: string, body: any }>}
 */
async function get(app, path, headers = {}) {
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, headers: res.headers, text, body };
  } finally {
    server.closeAllConnections();
    server.close();
  }
}
import { createMetrics } from '../src/metrics.js';

/** Fake pool answering the three scrape-time queries. */
const pool = {
  query: (/** @type {string} */ sql) => {
    if (sql.includes('FROM users'))
      return Promise.resolve({
        rows: [
          { status: 'active', n: 3 },
          { status: 'disabled', n: 1 },
        ],
      });
    if (sql.includes('signing_keys')) return Promise.resolve({ rows: [{ age: 120.5 }] });
    return Promise.resolve({ rows: [] });
  },
};

/**
 * @param {ReturnType<typeof createMetrics>} metrics
 * @param {string} token
 */
function appFor(metrics, token) {
  const app = express();
  app.use(metrics.router({ pool: /** @type {any} */ (pool), token }));
  return app;
}

/** Value of the first sample line for `name` (with optional label text), or undefined. */
const sample = (/** @type {string} */ text, /** @type {string} */ name) => {
  const line = text.split('\n').find((l) => l.startsWith(name + ' ') || l.startsWith(name + '{'));
  return line === undefined ? undefined : Number(line.split(' ').at(-1));
};

describe('metrics auth', () => {
  it('is off (404) when the token is empty', async () => {
    const res = await get(appFor(createMetrics(), ''), '/metrics');
    expect(res.status).toBe(404);
  });

  it('refuses a missing or wrong token with 401 and a Bearer challenge', async () => {
    const app = appFor(createMetrics(), 'scrape-secret');
    const none = await get(app, '/metrics');
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe('Bearer');
    const wrong = await get(app, '/metrics', { authorization: 'Bearer nope' });
    expect(wrong.status).toBe(401);
    const basic = await get(app, '/metrics', { authorization: 'Basic c2NyYXBl' });
    expect(basic.status).toBe(401);
  });

  it('serves the metrics with the right token', async () => {
    const res = await get(appFor(createMetrics(), 'scrape-secret'), '/metrics', {
      authorization: 'Bearer scrape-secret',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.text).toContain('# TYPE tunnus_sign_ins_total counter');
    expect(res.text).toContain('tunnus_process_cpu_user_seconds_total');
  });
});

describe('audit action counters', () => {
  it('maps audit actions to counters', async () => {
    const metrics = createMetrics();
    metrics.countAuditAction('signin');
    metrics.countAuditAction('signin');
    metrics.countAuditAction('signup');
    metrics.countAuditAction('code_failed', { locked: false });
    metrics.countAuditAction('mail_error');
    metrics.countAuditAction('admin.auth_failed', { reason: 'missing' });
    metrics.countAuditAction('admin.createUser');
    metrics.countAuditAction('user.deleted_inactive');
    metrics.countAuditAction('user.inactive_warned');
    metrics.countAuditAction('mail_relay.sent', { recipients: 2 });
    metrics.countAuditAction('mail_relay.auth_failed', { reason: 'invalid' });
    const text = await metrics.registry.metrics();
    expect(sample(text, 'tunnus_sign_ins_total')).toBe(2);
    expect(sample(text, 'tunnus_sign_ups_total')).toBe(1);
    expect(sample(text, 'tunnus_code_failures_total')).toBe(1);
    expect(sample(text, 'tunnus_mail_errors_total')).toBe(1);
    expect(sample(text, 'tunnus_admin_auth_failures_total')).toBe(1);
    expect(sample(text, 'tunnus_admin_requests_total')).toBe(1);
    expect(sample(text, 'tunnus_users_deleted_inactive_total')).toBe(1);
    expect(sample(text, 'tunnus_inactive_warnings_sent_total')).toBe(1);
    expect(sample(text, 'tunnus_mail_relayed_total')).toBe(1);
    expect(sample(text, 'tunnus_mail_relay_auth_failures_total')).toBe(1);
  });

  it('labels rate limit hits by reason, using other for unknown reasons', async () => {
    const metrics = createMetrics();
    metrics.countAuditAction('rate_limited', { reason: 'email' });
    metrics.countAuditAction('rate_limited', { reason: 'ip' });
    metrics.countAuditAction('rate_limited', { reason: 'daily' });
    metrics.countAuditAction('rate_limited', { reason: 'something-else' });
    metrics.countAuditAction('rate_limited');
    const text = await metrics.registry.metrics();
    expect(sample(text, 'tunnus_rate_limit_hits_total{reason="email"}')).toBe(1);
    expect(sample(text, 'tunnus_rate_limit_hits_total{reason="ip"}')).toBe(1);
    expect(sample(text, 'tunnus_rate_limit_hits_total{reason="daily"}')).toBe(1);
    expect(sample(text, 'tunnus_rate_limit_hits_total{reason="other"}')).toBe(2);
  });

  it('counts "Continue as" sign-ins with the other sign-ins', async () => {
    const metrics = createMetrics();
    metrics.countAuditAction('signin');
    metrics.countAuditAction('signin_continue');
    const text = await metrics.registry.metrics();
    expect(sample(text, 'tunnus_sign_ins_total')).toBe(2);
  });

  it('ignores unrelated actions', async () => {
    const metrics = createMetrics();
    metrics.countAuditAction('cleanup.run', { payloads: 3 });
    metrics.countAuditAction('something.else');
    const text = await metrics.registry.metrics();
    expect(sample(text, 'tunnus_sign_ins_total')).toBe(0);
    expect(sample(text, 'tunnus_admin_requests_total')).toBe(0);
  });
});

describe('gauges', () => {
  it('reads user counts and signing key age at scrape time', async () => {
    const res = await get(appFor(createMetrics(), 't'), '/metrics', { authorization: 'Bearer t' });
    expect(res.text).toContain('tunnus_users{status="active"} 3');
    expect(res.text).toContain('tunnus_users{status="disabled"} 1');
    expect(res.text).toContain('tunnus_signing_key_age_seconds 120.5');
  });

  it('exposes the cleanup timestamp, 0 before the first run', async () => {
    const metrics = createMetrics();
    expect(
      sample(await metrics.registry.metrics(), 'tunnus_cleanup_last_success_timestamp_seconds'),
    ).toBe(0);
    metrics.setCleanupSuccess(new Date('2026-11-01T03:00:00Z'));
    expect(
      sample(await metrics.registry.metrics(), 'tunnus_cleanup_last_success_timestamp_seconds'),
    ).toBe(Date.parse('2026-11-01T03:00:00Z') / 1000);
  });
});
