import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, startTunnus } from './helpers/harness.js';

/** @type {Awaited<ReturnType<typeof startTunnus>>} */
let t;
beforeAll(async () => {
  t = await startTunnus({
    schema: 'tunnus_ratelimit_test',
    env: { RATE_LIMIT_EMAIL_PER_HOUR: '2', RATE_LIMIT_IP_PER_HOUR: '3', MAIL_DAILY_CAP: '100' },
  });
});
afterAll(async () => {
  await t.close();
});

describe('rate limits', () => {
  it('stops sending after the per-email limit, with the same response and an audit row', async () => {
    const b = browser();
    const { page } = await t.startAuth(b);
    const path = t.interactionPath(page.body);
    const responses = [];
    for (let i = 0; i < 3; i++) {
      responses.push(await b.post(`${t.origin}${path}/email`, { email: 'limited@example.org' }));
    }
    expect(t.mails.length).toBe(2);
    expect(new Set(responses.map((r) => r.body)).size).toBe(1);
    const { rows } = await t.pool.query(
      "SELECT details FROM audit_events WHERE action = 'rate_limited'",
    );
    expect(rows[0].details.reason).toBe('email');
    // No email address in audit details.
    expect(JSON.stringify(rows)).not.toContain('limited@');
  });

  it('limits per IP across addresses', async () => {
    const b = browser();
    const { page } = await t.startAuth(b);
    const path = t.interactionPath(page.body);
    const before = t.mails.length;
    for (const who of ['a1', 'a2', 'a3', 'a4']) {
      await b.post(`${t.origin}${path}/email`, { email: `${who}@example.org` });
    }
    // 2 codes were already issued to this IP above; limit is 3 per hour.
    expect(t.mails.length - before).toBe(1);
  });
});
