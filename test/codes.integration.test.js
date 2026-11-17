import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueCode } from '../src/codes.js';
import { startTunnus } from './helpers/harness.js';

const SECRET = 'test-key-encryption-secret-0123456789';
/** @type {Awaited<ReturnType<typeof startTunnus>>} */
let t;
beforeAll(async () => {
  t = await startTunnus({
    schema: 'tunnus_codes_test',
    env: { RATE_LIMIT_EMAIL_PER_HOUR: '5', RATE_LIMIT_IP_PER_HOUR: '100', MAIL_DAILY_CAP: '1000' },
  });
});
afterAll(async () => {
  await t.close();
});

/** @param {string} email @param {string} uid @param {{ purpose?: 'signup' | 'login', ip?: string | null }} [o] */
const issue = (email, uid, { purpose = 'signup', ip = '10.0.0.1' } = {}) =>
  issueCode(t.pool, {
    secret: SECRET,
    limits: t.config.limits,
    email,
    uid,
    ip,
    purpose,
  });

/** Insert a code row with a number of failed attempts, created `minutesAgo` minutes ago. */
/**
 * @param {string} email
 * @param {number} attempts
 * @param {number} [minutesAgo]
 */
async function insertFailed(email, attempts, minutesAgo = 0) {
  await t.pool.query(
    `INSERT INTO email_codes (email, code_hash, code_enc, link_token_hash, purpose, interaction_uid, ip, attempts, created_at, expires_at)
     VALUES ($1, 'x', 'x', 'x', 'login', $2, NULL, $3, now() - $4 * interval '1 minute', now() + interval '10 minutes')`,
    [email, `failed-${email}-${minutesAgo}-${attempts}`, attempts, minutesAgo],
  );
}

describe('issueCode limits', () => {
  it('serialises concurrent requests for one address so the per-email limit holds', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => issue('race@example.org', `race-${i}`)),
    );
    expect(results.filter((r) => r.ok).length).toBe(t.config.limits.perEmailPerHour);
    expect(
      results.filter((r) => !r.ok).every((r) => r.reason === 'email' || r.reason === 'daily'),
    ).toBe(true);
  });

  it('locks an address after 10 failed attempts across interactions in the last hour', async () => {
    const email = 'lockout@example.org';
    await insertFailed(email, 6, 5);
    await insertFailed(email, 4, 30);
    const refused = await issue(email, 'lockout-1', { ip: '10.9.9.9' });
    expect(refused).toEqual({ ok: false, reason: 'email' });
  });

  it('ignores failed attempts older than an hour', async () => {
    const email = 'old-failures@example.org';
    await insertFailed(email, 10, 61);
    const ok = await issue(email, 'old-failures-1', { ip: '10.8.8.8' });
    expect(ok.ok).toBe(true);
  });
});

describe('issueCode daily cap', () => {
  it('stops sign-up codes at the cap and lets login codes continue to 1.5 times it', async () => {
    const capped = await startTunnus({
      schema: 'tunnus_codes_daily_test',
      env: { RATE_LIMIT_EMAIL_PER_HOUR: '50', RATE_LIMIT_IP_PER_HOUR: '100', MAIL_DAILY_CAP: '4' },
    });
    try {
      const go = (
        /** @type {string} */ email,
        /** @type {string} */ uid,
        /** @type {'signup' | 'login'} */ purpose,
      ) =>
        issueCode(capped.pool, {
          secret: SECRET,
          limits: capped.config.limits,
          email,
          uid,
          ip: '10.0.0.1',
          purpose,
        });
      for (let i = 0; i < 4; i++) {
        expect((await go(`new${i}@example.org`, `s${i}`, 'signup')).ok).toBe(true);
      }
      expect(await go('fifth@example.org', 's5', 'signup')).toEqual({ ok: false, reason: 'daily' });
      // 1.5 x 4 = 6 codes in the day in total; login codes take the remaining two.
      expect((await go('known1@example.org', 'l1', 'login')).ok).toBe(true);
      expect((await go('known2@example.org', 'l2', 'login')).ok).toBe(true);
      expect(await go('known3@example.org', 'l3', 'login')).toEqual({ ok: false, reason: 'daily' });
    } finally {
      await capped.close();
    }
  });
});
