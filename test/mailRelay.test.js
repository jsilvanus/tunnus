import { once } from 'node:events';
import http from 'node:http';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createBrevoTransport, createConsoleTransport, createMailer } from '../src/mail.js';
import { createMailRelayRouter, validateMailRelayBody } from '../src/web/mailRelay.js';

/**
 * Send one HTTP request to `app` on an ephemeral port.
 * @param {express.Express} app
 * @param {string} path
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [opts]
 */
async function request(app, path, { method = 'POST', headers = {}, body } = {}) {
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, text, body: json };
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

/**
 * Send a JSON POST request to `app`.
 * @param {express.Express} app
 * @param {string} path
 * @param {unknown} payload
 * @param {Record<string, string>} [headers]
 */
const postJson = (app, path, payload, headers = {}) =>
  request(app, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });

/** Fake pool that records `audit_events` inserts. */
function fakePool() {
  /** @type {{ action: string, ip: string | null, details: any }[]} */
  const audits = [];
  const pool = {
    query: vi.fn(async (_sql, params) => {
      audits.push({
        action: params[1],
        ip: params[4],
        details: params[5],
      });
      return { rows: [] };
    }),
  };
  return { pool: /** @type {any} */ (pool), audits };
}

const VALID_PAYLOAD = {
  from: 'app@example.org',
  to: ['keeper@example.org'],
  subject: '[App] Notification (depleted): Pencils',
  text: 'Notification (depleted): Pencils\nMain storage — Empty\n\nhttps://app.example.org/manage',
  html: '<p>Notification (depleted): Pencils</p>',
  templateId: 42,
  params: {
    title: 'Notification (depleted): Pencils',
    body: 'Main storage — Empty',
    kind: 'depleted',
    targetName: 'Pencils',
    storageName: 'Main storage',
    url: 'https://app.example.org/manage',
  },
};

describe('validateMailRelayBody', () => {
  it('accepts a full payload with html, templateId and params', () => {
    const res = validateMailRelayBody(VALID_PAYLOAD);
    expect(res).toEqual({
      ok: true,
      message: {
        from: 'app@example.org',
        to: ['keeper@example.org'],
        subject: VALID_PAYLOAD.subject,
        text: VALID_PAYLOAD.text,
        html: VALID_PAYLOAD.html,
        template: { id: 42, params: VALID_PAYLOAD.params },
      },
    });
  });

  it('accepts a minimal plain-text payload and Display Name <addr@host> in from', () => {
    const res = validateMailRelayBody({
      from: 'App Service <app@example.org>',
      to: [' first@example.org ', 'second@example.org'],
      subject: 'Hello',
      text: 'Plain body',
    });
    expect(res).toEqual({
      ok: true,
      message: {
        from: 'App Service <app@example.org>',
        to: ['first@example.org', 'second@example.org'],
        subject: 'Hello',
        text: 'Plain body',
      },
    });
  });

  it('defaults params to an empty object when templateId is given without params', () => {
    const res = validateMailRelayBody({
      from: 'app@example.org',
      to: ['keeper@example.org'],
      subject: 'Hello',
      text: 'Body',
      templateId: 7,
    });
    expect(res).toEqual({
      ok: true,
      message: {
        from: 'app@example.org',
        to: ['keeper@example.org'],
        subject: 'Hello',
        text: 'Body',
        template: { id: 7, params: {} },
      },
    });
  });

  it('rejects non-objects, unknown fields, and invalid email addresses or types', () => {
    expect(validateMailRelayBody(null).ok).toBe(false);
    expect(validateMailRelayBody([]).ok).toBe(false);

    const unknown = validateMailRelayBody({ ...VALID_PAYLOAD, extraField: true });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.details).toEqual([{ path: '/extraField', message: 'unknown property' }]);
    }

    const badFields = validateMailRelayBody({
      from: 'not-an-email',
      to: ['valid@example.org', 'bad address'],
      subject: 'Line\nbreak',
      text: '   ',
      html: 123,
      templateId: 0,
      params: ['not-object'],
    });
    expect(badFields.ok).toBe(false);
    if (!badFields.ok) {
      expect(badFields.details.map((d) => d.path)).toEqual([
        '/from',
        '/to/1',
        '/subject',
        '/text',
        '/html',
        '/templateId',
        '/params',
      ]);
    }
  });
});

describe('createMailRelayRouter', () => {
  /**
   * @param {{ token?: string, send?: (m: any) => Promise<void>, failureLimit?: number }} [opts]
   */
  function setup({ token = 'relay-secret', send = async () => {}, failureLimit = 20 } = {}) {
    const { pool, audits } = fakePool();
    /** @type {any[]} */
    const sent = [];
    const mailer = {
      sendCode: async () => {},
      sendInactiveWarning: async () => {},
      send: async (/** @type {any} */ m) => {
        sent.push(m);
        await send(m);
      },
    };
    const app = express();
    app.use(createMailRelayRouter({ pool, token, mailer, failureLimit }));
    return { app, audits, sent };
  }

  it('is off (404) when MAIL_RELAY_TOKEN is empty', async () => {
    const { app } = setup({ token: '' });
    const res = await postJson(app, '/api/mail', VALID_PAYLOAD, {
      authorization: 'Bearer anything',
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });

  it('refuses missing, malformed or wrong tokens with 401 and audits the failure', async () => {
    const { app, audits } = setup({ token: 'relay-secret' });

    const missing = await postJson(app, '/api/mail', VALID_PAYLOAD);
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');

    const malformed = await postJson(app, '/api/mail', VALID_PAYLOAD, {
      authorization: 'Basic abc',
    });
    expect(malformed.status).toBe(401);

    const wrong = await postJson(app, '/api/mail', VALID_PAYLOAD, {
      authorization: 'Bearer wrong-secret',
    });
    expect(wrong.status).toBe(401);

    expect(audits).toEqual([
      { action: 'mail_relay.auth_failed', ip: '127.0.0.1', details: { reason: 'missing' } },
      { action: 'mail_relay.auth_failed', ip: '127.0.0.1', details: { reason: 'malformed' } },
      { action: 'mail_relay.auth_failed', ip: '127.0.0.1', details: { reason: 'invalid' } },
    ]);
  });

  it('rate-limits repeated auth failures from an IP with 429, while still accepting a valid token', async () => {
    const { app, audits, sent } = setup({ token: 'relay-secret', failureLimit: 2 });
    for (let i = 0; i < 3; i++) {
      const r = await postJson(app, '/api/mail', VALID_PAYLOAD, {
        authorization: 'Bearer wrong',
      });
      expect(r.status).toBe(401);
    }
    const limited = await postJson(app, '/api/mail', VALID_PAYLOAD, {
      authorization: 'Bearer wrong',
    });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
    expect(audits).toHaveLength(3);

    // Valid token is still accepted even when the IP is over the failure limit.
    const ok = await postJson(app, '/api/mail', VALID_PAYLOAD, {
      authorization: 'Bearer relay-secret',
    });
    expect(ok.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('relays the message on POST /api/mail and POST /admin/api/v1/mail and audits counts only', async () => {
    const { app, audits, sent } = setup({ token: 'relay-secret' });

    const r1 = await postJson(app, '/api/mail', VALID_PAYLOAD, {
      authorization: 'Bearer relay-secret',
    });
    expect(r1.status).toBe(200);
    expect(r1.body).toEqual({ ok: true });

    const r2 = await postJson(
      app,
      '/admin/api/v1/mail',
      {
        from: 'app@example.org',
        to: ['one@example.org', 'two@example.org'],
        subject: 'Plain subject',
        text: 'Plain text',
      },
      { authorization: 'Bearer relay-secret' },
    );
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual({ ok: true });

    expect(sent).toHaveLength(2);
    expect(audits).toEqual([
      {
        action: 'mail_relay.sent',
        ip: '127.0.0.1',
        details: { recipients: 1, templateId: 42 },
      },
      {
        action: 'mail_relay.sent',
        ip: '127.0.0.1',
        details: { recipients: 2 },
      },
    ]);
    // Audit events must never contain email addresses or message content.
    expect(JSON.stringify(audits)).not.toContain('example.org');
    expect(JSON.stringify(audits)).not.toContain('Pencils');
  });

  it('rejects malformed JSON, an empty body, or invalid fields with 400', async () => {
    const { app } = setup({ token: 'relay-secret' });
    const auth = { authorization: 'Bearer relay-secret' };

    const badJson = await request(app, '/api/mail', {
      headers: { ...auth, 'content-type': 'application/json' },
      body: '{bad',
    });
    expect(badJson.status).toBe(400);
    expect(badJson.body.error.code).toBe('invalid_request');

    const empty = await request(app, '/api/mail', { headers: auth });
    expect(empty.status).toBe(400);

    const invalid = await postJson(app, '/api/mail', { from: 'bad', to: [] }, auth);
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details.length).toBeGreaterThan(0);
  });

  it('returns 502 mail_error when the transport fails and audits only the error name', async () => {
    const { app, audits } = setup({
      token: 'relay-secret',
      send: async () => {
        throw new TypeError('Brevo rejected keeper@example.org');
      },
    });
    const res = await postJson(app, '/api/mail', VALID_PAYLOAD, {
      authorization: 'Bearer relay-secret',
    });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: { code: 'mail_error', message: 'Mail delivery failed' },
    });
    expect(audits).toEqual([
      {
        action: 'mail_error',
        ip: '127.0.0.1',
        details: { kind: 'relay', error: 'TypeError' },
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain('keeper@example.org');
  });

  it('forwards custom from, multiple recipients, html, templateId and params to Brevo with 4xx fallback', async () => {
    /** @type {any[]} */
    const brevoBodies = [];
    const statuses = [400, 201];
    let call = 0;
    const transport = createBrevoTransport(
      'brevo-key',
      'Tunnus <no-reply@example.org>',
      async (_url, init) => {
        brevoBodies.push(JSON.parse(/** @type {string} */ (init?.body)));
        const status = statuses[Math.min(call++, statuses.length - 1)];
        return new Response('{}', { status });
      },
      { info() {}, debug() {}, warn() {} },
    );
    const mailer = createMailer(/** @type {any} */ ({}), transport);
    const { pool } = fakePool();
    const app = express();
    app.use(createMailRelayRouter({ pool, token: 'relay-secret', mailer }));

    const res = await postJson(
      app,
      '/api/mail',
      {
        ...VALID_PAYLOAD,
        to: ['keeper1@example.org', 'keeper2@example.org'],
      },
      { authorization: 'Bearer relay-secret' },
    );
    expect(res.status).toBe(200);
    expect(brevoBodies).toHaveLength(2);
    // First attempt: template send with custom sender and multiple recipients
    expect(brevoBodies[0]).toEqual({
      sender: { email: 'app@example.org' },
      to: [{ email: 'keeper1@example.org' }, { email: 'keeper2@example.org' }],
      templateId: 42,
      params: VALID_PAYLOAD.params,
    });
    // Fallback on 4xx: plain text + htmlContent with custom sender and multiple recipients
    expect(brevoBodies[1]).toEqual({
      sender: { email: 'app@example.org' },
      to: [{ email: 'keeper1@example.org' }, { email: 'keeper2@example.org' }],
      subject: VALID_PAYLOAD.subject,
      textContent: VALID_PAYLOAD.text,
      htmlContent: VALID_PAYLOAD.html,
    });
  });

  it('logs from and html when relaying through the console transport', async () => {
    const info = vi.fn();
    const debug = vi.fn();
    const transport = createConsoleTransport({ info, debug, warn() {} });
    const mailer = createMailer(/** @type {any} */ ({}), transport);
    const { pool } = fakePool();
    const app = express();
    app.use(createMailRelayRouter({ pool, token: 'relay-secret', mailer }));

    const res = await postJson(app, '/api/mail', VALID_PAYLOAD, {
      authorization: 'Bearer relay-secret',
    });
    expect(res.status).toBe(200);
    expect(info).toHaveBeenCalledWith(
      {
        from: VALID_PAYLOAD.from,
        to: VALID_PAYLOAD.to,
        subject: VALID_PAYLOAD.subject,
        text: VALID_PAYLOAD.text,
        html: VALID_PAYLOAD.html,
      },
      'mail (console provider)',
    );
    expect(debug).toHaveBeenCalledWith(
      { templateId: 42 },
      'mail template (console provider, unused)',
    );
  });
});
