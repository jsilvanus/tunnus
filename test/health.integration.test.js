import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTunnus } from './helpers/harness.js';

/** @type {Awaited<ReturnType<typeof startTunnus>>} */
let t;

beforeAll(async () => {
  t = await startTunnus({ schema: 'health_it' });
});
afterAll(async () => {
  await t.close();
});

describe('GET /health', () => {
  it('returns 200 with both checks ok, no auth and no-store caching', async () => {
    const res = await fetch(`${t.issuer}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({ database: 'ok', signing_key: 'ok' });
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns 503 with signing_key missing when no active key exists, and 200 again after it returns', async () => {
    const { rows } = await t.pool.query(
      "UPDATE signing_keys SET status = 'retired', retired_at = now() WHERE status = 'active' RETURNING kid",
    );
    try {
      const res = await fetch(`${t.issuer}/health`);
      expect(res.status).toBe(503);
      expect((await res.json()).checks.signing_key).toBe('missing');
    } finally {
      await t.pool.query(
        "UPDATE signing_keys SET status = 'active', retired_at = NULL WHERE kid = $1",
        [rows[0].kid],
      );
    }
    const back = await fetch(`${t.issuer}/health`);
    expect(back.status).toBe(200);
  });
});
