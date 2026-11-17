import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as client from 'openid-client';
import { browser, POST_LOGOUT, REDIRECT, startTunnus } from './helpers/harness.js';

const RP_WITH_REFRESH = {
  client_id: 'rp',
  client_secret: 'rp-secret',
  redirect_uris: [REDIRECT],
  post_logout_redirect_uris: [POST_LOGOUT],
  token_endpoint_auth_method: 'client_secret_post',
  grant_types: ['authorization_code', 'refresh_token'],
  first_party: true,
  always_include_groups: true,
};

/** Sign in or sign up through the browser; returns the browser with a session. */
async function signIn(
  /** @type {any} */ t,
  /** @type {any} */ b,
  /** @type {string} */ email,
  name = 'Test Person',
) {
  const { page, verifier, state } = await t.startAuth(b, {
    scope: 'openid email profile offline_access',
    prompt: 'consent',
  });
  const path = /** @type {string} */ (t.interactionPath(page.body));
  const before = t.mails.length;
  await b.post(`${t.origin}${path}/email`, { email });
  await vi.waitFor(() => expect(t.mails.length).toBe(before + 1));
  let done = await b.post(`${t.origin}${path}/code`, { code: t.mails.at(-1)?.code });
  if (!done.finalUrl.startsWith(REDIRECT)) {
    done = await b.post(`${t.origin}${path}/name`, { name });
  }
  // A new interaction may ask for consent to offline_access; the test accepts it.
  if (!done.finalUrl.startsWith(REDIRECT)) {
    const consent = /** @type {string} */ (
      t.interactionPath(
        done.res.status === 200 ? done.body || (await b.go(done.finalUrl)).body : '',
      )
    );
    done = await b.post(`${t.origin}${consent}/confirm`, {});
  }
  const tokens = await t.exchange(done.finalUrl, verifier, state);
  return { tokens, path };
}

const activity = (/** @type {any} */ t, /** @type {string} */ email) =>
  t.pool.query('SELECT last_login_at, inactive_warned_at FROM users WHERE email = $1', [email]);

/** @type {Awaited<ReturnType<typeof startTunnus>>} */
let t;
beforeAll(async () => {
  t = await startTunnus({ schema: 'tunnus_signin_details_test' });
});
afterAll(async () => {
  await t.close();
});

describe('continue as a session user', () => {
  it('treats a session for a disabled account as expired', async () => {
    const b = browser();
    await signIn(t, b, 'session.disabled@example.org');
    const again = await t.startAuth(b);
    expect(again.page.body).toContain('Continue as');
    const path = /** @type {string} */ (t.interactionPath(again.page.body));
    await t.pool.query("UPDATE users SET status = 'disabled' WHERE email = $1", [
      'session.disabled@example.org',
    ]);
    const cont = await b.post(`${t.origin}${path}/continue`, {});
    expect(cont.res.status).toBe(400);
    expect(cont.finalUrl.startsWith(REDIRECT)).toBe(false);
    await t.pool.query("UPDATE users SET status = 'active' WHERE email = $1", [
      'session.disabled@example.org',
    ]);
  });
});

describe('email address validation on the sign-in page', () => {
  it('rejects an address the old pattern accepted, with the invalid-email message, and sends nothing', async () => {
    const b = browser();
    const { page } = await t.startAuth(b);
    const path = /** @type {string} */ (t.interactionPath(page.body));
    const before = t.mails.length;
    const res = await b.post(`${t.origin}${path}/email`, { email: 'anna@example.org;x' });
    expect(res.body).toContain('Enter a valid email address.');
    expect(t.mails.length).toBe(before);
  });
});

describe('name step unique violation', () => {
  it('shows the expired page, not a server error, when the address was taken meanwhile', async () => {
    const b = browser();
    const email = 'race.name@example.org';
    const { page } = await t.startAuth(b);
    const path = /** @type {string} */ (t.interactionPath(page.body));
    const before = t.mails.length;
    await b.post(`${t.origin}${path}/email`, { email });
    await vi.waitFor(() => expect(t.mails.length).toBe(before + 1));
    await b.post(`${t.origin}${path}/code`, { code: /** @type {any} */ (t.mails.at(-1)).code });
    // Another request inserts the address after the check in the name step and before its insert.
    await t.pool.query(`
      CREATE FUNCTION taken_meanwhile() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE unique_violation USING MESSAGE = 'duplicate key value violates unique constraint';
      END $$;
      CREATE TRIGGER taken_meanwhile BEFORE INSERT ON users
        FOR EACH ROW WHEN (NEW.email = '${email}') EXECUTE FUNCTION taken_meanwhile();
    `);
    try {
      const named = await b.post(`${t.origin}${path}/name`, { name: 'Late' });
      expect(named.res.status).toBe(400);
      expect(named.body).toContain('This link is not valid any more');
    } finally {
      await t.pool.query(`DROP TRIGGER taken_meanwhile ON users; DROP FUNCTION taken_meanwhile();`);
    }
  });
});

describe('last login bookkeeping', () => {
  it('refreshes last_login_at and clears the inactivity warning on a silent authorization', async () => {
    const b = browser();
    const email = 'silent.activity@example.org';
    await signIn(t, b, email);
    await t.pool.query(
      "UPDATE users SET last_login_at = now() - interval '2 hours', inactive_warned_at = now() WHERE email = $1",
      [email],
    );
    const silent = await t.startAuth(b, { prompt: 'none' });
    expect(new URL(silent.page.finalUrl).searchParams.get('code')).toBeTruthy();
    const row = (await activity(t, email)).rows[0];
    expect(Date.now() - new Date(row.last_login_at).getTime()).toBeLessThan(60 * 60 * 1000);
    expect(row.inactive_warned_at).toBeNull();
  });

  it('does not write again within an hour', async () => {
    const b = browser();
    const email = 'throttle.activity@example.org';
    await signIn(t, b, email);
    await t.pool.query(
      "UPDATE users SET last_login_at = now() - interval '30 minutes', inactive_warned_at = now() WHERE email = $1",
      [email],
    );
    const before = (await activity(t, email)).rows[0];
    await t.startAuth(b, { prompt: 'none' });
    const after = (await activity(t, email)).rows[0];
    expect(new Date(after.last_login_at).getTime()).toBe(new Date(before.last_login_at).getTime());
    expect(after.inactive_warned_at).not.toBeNull();
  });
});

describe('last login bookkeeping on refresh tokens', () => {
  /** @type {Awaited<ReturnType<typeof startTunnus>>} */
  let r;
  beforeAll(async () => {
    r = await startTunnus({ schema: 'tunnus_signin_refresh_test', clients: [RP_WITH_REFRESH] });
  });
  afterAll(async () => {
    await r.close();
  });

  it('counts a refresh token grant as activity', async () => {
    const b = browser();
    const email = 'refresh.activity@example.org';
    const { tokens } = await signIn(r, b, email);
    expect(tokens.refresh_token).toBeTruthy();
    await r.pool.query(
      "UPDATE users SET last_login_at = now() - interval '2 hours', inactive_warned_at = now() WHERE email = $1",
      [email],
    );
    await client.refreshTokenGrant(r.rp, /** @type {string} */ (tokens.refresh_token));
    const row = (
      await r.pool.query('SELECT last_login_at, inactive_warned_at FROM users WHERE email = $1', [
        email,
      ])
    ).rows[0];
    expect(Date.now() - new Date(row.last_login_at).getTime()).toBeLessThan(60 * 60 * 1000);
    expect(row.inactive_warned_at).toBeNull();
  });
});
