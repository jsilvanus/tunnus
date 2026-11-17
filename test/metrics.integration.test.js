import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, startTunnus } from './helpers/harness.js';

const TOKEN = 'scrape-secret-for-tests';

/** @type {Awaited<ReturnType<typeof startTunnus>>} */
let t;

beforeAll(async () => {
  t = await startTunnus({ schema: 'metrics_it', env: { METRICS_BEARER_TOKEN: TOKEN } });
});
afterAll(async () => {
  await t.close();
});

/**
 * Request an email code for `email` in a fresh browser; returns the browser, path and mail.
 * @param {string} email
 */
async function requestCode(email) {
  const b = browser();
  const { page } = await t.startAuth(b);
  const path = /** @type {string} */ (t.interactionPath(page.body));
  const sent = await b.post(`${t.origin}${path}/email`, { email });
  expect(sent.res.status).toBe(200);
  return { b, path, mail: /** @type {any} */ (t.mails.at(-1)) };
}

/** Scrape /metrics with the token and return the text. */
async function scrape() {
  const res = await fetch(`${t.issuer}/metrics`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(200);
  return res.text();
}

/** Value of an unlabelled or labelled sample. */
const value = (/** @type {string} */ text, /** @type {string} */ sample) => {
  const line = text.split('\n').find((l) => l.startsWith(`${sample} `));
  if (!line) throw new Error(`no sample ${sample}`);
  return Number(line.split(' ').at(-1));
};

describe('GET /metrics', () => {
  it('refuses requests without the bearer token', async () => {
    const none = await fetch(`${t.issuer}/metrics`);
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe('Bearer');
    const wrong = await fetch(`${t.issuer}/metrics`, {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(wrong.status).toBe(401);
  });

  it('counts sign-up, sign-in and a failed code from the real flow', async () => {
    // Sign-up: code, then the name step.
    const anna = await requestCode('anna.virtanen@example.org');
    const verified = await anna.b.post(`${t.origin}${anna.path}/code`, { code: anna.mail.code });
    expect(verified.body).toContain('value="Anna Virtanen"');
    await anna.b.post(`${t.origin}${anna.path}/name`, { name: 'Anna V.' });

    // Failed code for a new address: counted, no account created.
    const cara = await requestCode('cara.lindqvist@example.org');
    const wrong = cara.mail.code === '000000' ? '111111' : '000000';
    const rejected = await cara.b.post(`${t.origin}${cara.path}/code`, { code: wrong });
    expect(rejected.res.status).toBe(400);

    // Sign-in for the existing user: code only, no name step.
    const again = await requestCode('anna.virtanen@example.org');
    await again.b.post(`${t.origin}${again.path}/code`, { code: again.mail.code });

    const text = await scrape();
    expect(value(text, 'tunnus_sign_ups_total')).toBe(1);
    expect(value(text, 'tunnus_sign_ins_total')).toBe(1);
    expect(value(text, 'tunnus_code_failures_total')).toBe(1);
    expect(value(text, 'tunnus_users{status="active"}')).toBe(1);
    expect(value(text, 'tunnus_signing_key_age_seconds')).toBeGreaterThanOrEqual(0);

    // The counters agree with the audit log they are derived from.
    const { rows } = await t.pool.query(
      "SELECT action, count(*)::int AS n FROM audit_events WHERE action IN ('signin', 'signup', 'code_failed') GROUP BY action",
    );
    const counts = Object.fromEntries(rows.map((r) => [r.action, r.n]));
    expect(counts).toEqual({ signin: 1, signup: 1, code_failed: 1 });
  });
});
