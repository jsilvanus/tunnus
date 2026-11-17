import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAdmin } from './helpers/admin.js';

/** @type {Awaited<ReturnType<typeof startAdmin>>} */
let t;
beforeAll(async () => {
  t = await startAdmin({ schema: 'tunnus_admin_ratelimit_test' });
});
afterAll(async () => {
  await t.close();
});

describe('failed-auth rate limit', () => {
  it('returns 429 once an IP has more than 20 failures in 10 minutes, and stops auditing', async () => {
    const bad = `tun_${'b'.repeat(43)}`;
    for (let i = 0; i < 21; i++) {
      expect((await t.api('GET', '/me', { token: bad })).status).toBe(401);
    }
    const limited = await t.api('GET', '/me', { token: bad });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
    // The good token is refused too while the IP is blocked.
    expect((await t.api('GET', '/me')).status).toBe(429);
    const { rows } = await t.pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'admin.auth_failed'",
    );
    expect(rows[0].n).toBe(21);
  });
});
