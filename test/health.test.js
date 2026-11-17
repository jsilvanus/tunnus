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
import { createHealthRouter } from '../src/health.js';

/**
 * Fake pool. `keys` is the result of the signing key query; `fail` names the check that throws.
 * @param {{ keys?: unknown[], fail?: 'database' | 'keys', hang?: boolean }} [opts]
 */
function fakePool({ keys = [{ '?column?': 1 }], fail, hang } = {}) {
  return {
    query: (/** @type {string} */ sql) => {
      if (hang) return new Promise(() => {});
      if (sql.includes('signing_keys')) {
        if (fail === 'keys') return Promise.reject(new Error('relation missing secret detail'));
        return Promise.resolve({ rows: keys });
      }
      if (fail === 'database') return Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5'));
      return Promise.resolve({ rows: [{ '?column?': 1 }] });
    },
  };
}

/** @param {any} pool @param {number} [timeoutMs] */
const appWith = (pool, timeoutMs) => {
  const app = express();
  app.use(createHealthRouter({ pool, version: '9.9.9', timeoutMs }));
  return app;
};

describe('health endpoint', () => {
  it('returns 200 with ok checks when the database answers and an active key exists', async () => {
    const res = await get(appWith(fakePool()), '/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      version: '9.9.9',
      checks: { database: 'ok', signing_key: 'ok' },
    });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('returns 503 with signing_key missing when no active key exists', async () => {
    const res = await get(appWith(fakePool({ keys: [] })), '/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('fail');
    expect(res.body.checks).toEqual({ database: 'ok', signing_key: 'missing' });
  });

  it('returns 503 with database fail and no error text when the database query fails', async () => {
    const res = await get(appWith(fakePool({ fail: 'database' })), '/health');
    expect(res.status).toBe(503);
    expect(res.body.checks.database).toBe('fail');
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
  });

  it('reports signing_key fail when the key query throws, without the error message', async () => {
    const res = await get(appWith(fakePool({ fail: 'keys' })), '/health');
    expect(res.status).toBe(503);
    expect(res.body.checks.signing_key).toBe('fail');
    expect(JSON.stringify(res.body)).not.toContain('secret detail');
  });

  it('marks the database as fail when the query exceeds the timeout', async () => {
    const started = Date.now();
    const res = await get(appWith(fakePool({ hang: true }), 50), '/health');
    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ database: 'fail', signing_key: 'fail' });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('healthcheck script URL', () => {
  it('uses the loopback address, the port and the issuer path prefix', async () => {
    const { healthcheckUrl } = await import('../bin/healthcheck.js');
    expect(healthcheckUrl({ ISSUER: 'https://id.example.org', PORT: '8080' })).toBe(
      'http://127.0.0.1:8080/health',
    );
    expect(healthcheckUrl({ ISSUER: 'https://example.org/sso/tunnus' })).toBe(
      'http://127.0.0.1:3000/sso/tunnus/health',
    );
  });

  it('rejects a missing issuer and a non-numeric port', async () => {
    const { healthcheckUrl } = await import('../bin/healthcheck.js');
    expect(() => healthcheckUrl({})).toThrow('ISSUER is required');
    expect(() => healthcheckUrl({ ISSUER: 'https://id.example.org', PORT: 'abc' })).toThrow(
      'PORT must be a number',
    );
  });
});
