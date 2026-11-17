import { createServer } from 'node:http';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { errorFields } from '../src/logger.js';
import { errorHandler } from '../src/web/errorHandler.js';
import { logPath, requestLog } from '../src/web/requestLog.js';
import { loadConfig } from '../src/config.js';

/**
 * Serve an app on an ephemeral port for one request helper call.
 * @param {express.Express} app
 * @param {(url: string) => Promise<any>} fn
 */
async function withServer(app, fn) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * @param {express.Express} app
 * @param {string} path
 * @param {Record<string, string>} [headers]
 */
const get = (app, path, headers = {}) =>
  withServer(app, async (base) => {
    const res = await fetch(base + path, { headers, redirect: 'manual' });
    return { status: res.status, headers: res.headers, text: await res.text() };
  });

/** A logger that keeps what it is given. */
function recorder() {
  /** @type {{ level: string, fields: any, msg: string }[]} */
  const lines = [];
  return {
    lines,
    info: (/** @type {any} */ fields, /** @type {string} */ msg) =>
      lines.push({ level: 'info', fields, msg }),
    error: (/** @type {any} */ fields, /** @type {string} */ msg) =>
      lines.push({ level: 'error', fields, msg }),
  };
}

describe('logPath', () => {
  it('drops the query string', () => {
    expect(logPath('/id/interaction/abc/email?email=a%40b.org&x=1')).toBe(
      '/id/interaction/abc/email',
    );
  });

  it('redacts link tokens in the path', () => {
    expect(logPath('/id/interaction/abc/link/SECRET-TOKEN_123?t=1')).toBe(
      '/id/interaction/abc/link/:token',
    );
  });
});

describe('errorFields', () => {
  it('keeps the name, the code and the frames, never the message', () => {
    const err = Object.assign(new Error('duplicate key (email)=(someone@example.org)'), {
      name: 'DatabaseError',
      code: '23505',
    });
    const fields = errorFields(err);
    expect(fields.name).toBe('DatabaseError');
    expect(fields.code).toBe('23505');
    expect(fields.frames.length).toBeGreaterThan(0);
    expect(JSON.stringify(fields)).not.toContain('someone@example.org');
  });

  it('copes with a value that is not an error', () => {
    expect(errorFields('boom')).toEqual({ name: 'string', code: undefined, frames: [] });
  });
});

describe('requestLog', () => {
  /** @param {ReturnType<typeof recorder>} log */
  const appWith = (log) => {
    const app = express();
    app.use(requestLog(log));
    app.get('/page/:x', (_req, res) => res.send('ok'));
    return app;
  };

  it('sets a random request id when the client sends none', async () => {
    const res = await get(appWith(recorder()), '/page/1');
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('passes a safe X-Request-Id through and rejects an unsafe one', async () => {
    const app = appWith(recorder());
    const kept = await get(app, '/page/1', { 'X-Request-Id': 'trace-42.a_b' });
    expect(kept.headers.get('x-request-id')).toBe('trace-42.a_b');
    const replaced = await get(app, '/page/1', { 'X-Request-Id': 'forged id with spaces' });
    expect(replaced.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs method, path without query, status, duration and request id', async () => {
    const log = recorder();
    await get(appWith(log), '/page/abc?secret=1', { 'X-Request-Id': 'rid-1' });
    expect(log.lines).toHaveLength(1);
    const { fields, msg } = log.lines[0];
    expect(msg).toBe('request');
    expect(fields).toMatchObject({
      reqId: 'rid-1',
      method: 'GET',
      path: '/page/abc',
      status: 200,
    });
    expect(typeof fields.durationMs).toBe('number');
    expect(JSON.stringify(log.lines)).not.toContain('secret');
  });
});

describe('errorHandler', () => {
  const config = loadConfig({
    ISSUER: 'https://id.example.org',
    DATABASE_URL: 'postgres://x',
    KEY_ENCRYPTION_SECRET: 'test-key-encryption-secret-0123456789',
    COOKIE_SECRETS: 'cookie-secret-0123',
    ALLOW_CONSOLE_MAIL: 'true',
    DEFAULT_LOCALE: 'fi',
  });

  /** @param {ReturnType<typeof recorder>} log */
  const appWith = (log) => {
    const app = express();
    app.use(requestLog(log));
    app.get('/interaction/:uid/link/:token', () => {
      throw Object.assign(new Error('secret-link-token and someone@example.org'), {
        name: 'BoomError',
      });
    });
    app.get('/admin/api/v1/boom', () => {
      throw new Error('admin failure');
    });
    app.use(errorHandler({ config, logger: log }));
    return app;
  };

  it('returns the branded error page in the requested locale, status 500', async () => {
    const res = await get(appWith(recorder()), '/interaction/u1/link/tok-123?x=1', {
      'Accept-Language': 'fi',
    });
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.text).toContain('Jotain meni vikaan');
    expect(res.text).toContain('<html lang="fi">');
  });

  it('logs the error without its message, the query string or the link token', async () => {
    const log = recorder();
    await get(appWith(log), '/interaction/u1/link/tok-123?x=1');
    const failure = log.lines.find((l) => l.msg === 'request failed');
    expect(failure?.level).toBe('error');
    expect(failure?.fields.path).toBe('/interaction/u1/link/:token');
    expect(failure?.fields.err.name).toBe('BoomError');
    const everything = JSON.stringify(log.lines);
    expect(everything).not.toContain('tok-123');
    expect(everything).not.toContain('someone@example.org');
    expect(everything).not.toContain('secret-link-token');
  });

  it('answers JSON under the admin API', async () => {
    const res = await get(appWith(recorder()), '/admin/api/v1/boom');
    expect(res.status).toBe(500);
    expect(JSON.parse(res.text)).toEqual({
      error: { code: 'internal', message: 'Internal error' },
    });
  });
});
