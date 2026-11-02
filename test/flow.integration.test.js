import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as client from 'openid-client';
import { POST_LOGOUT, REDIRECT, browser, startTunnus } from './helpers/harness.js';

/** @type {Awaited<ReturnType<typeof startTunnus>>} */
let t;

beforeAll(async () => {
  t = await startTunnus({ schema: 'tunnus_flow_test' });
});
afterAll(async () => {
  await t.close();
});

/**
 * Walk a fresh browser through email and code; returns the page after the code step.
 * @param {string} email
 * @param {ReturnType<typeof browser>} [b]
 * @param {Record<string, string>} [extra]
 */
async function signInUntilCode(email, b = browser(), extra) {
  const { page, verifier, state } = await t.startAuth(b, extra);
  const path = t.interactionPath(page.body);
  expect(path, page.body).toBeTruthy();
  const sent = await b.post(`${t.origin}${path}/email`, { email });
  expect(sent.res.status).toBe(200);
  const mail = t.mails.at(-1);
  const done = await b.post(`${t.origin}${path}/code`, { code: /** @type {any} */ (mail).code });
  return {
    b,
    path: /** @type {string} */ (path),
    done,
    verifier,
    state,
    mail: /** @type {any} */ (mail),
  };
}

describe('sign-up and token issue', () => {
  it('signs a new user up with an editable name, issues tokens with groups and ends the session', async () => {
    const { b, path, done, verifier, state } = await signInUntilCode('anna.virtanen@example.org');
    // New users get a name step prefilled from the email.
    expect(done.body).toContain('value="Anna Virtanen"');
    const named = await b.post(`${t.origin}${path}/name`, { name: 'Anna V.' });
    expect(named.finalUrl.startsWith(REDIRECT)).toBe(true);

    const tokens = await t.exchange(named.finalUrl, verifier, state);
    const claims = /** @type {any} */ (tokens.claims());
    expect(claims.iss).toBe(t.issuer);
    expect(claims.email).toBe('anna.virtanen@example.org');
    expect(claims.email_verified).toBe(true);
    expect(claims.name).toBe('Anna V.');
    expect(claims.groups).toEqual(['all']); // always_include_groups

    const info = await client.fetchUserInfo(t.rp, tokens.access_token, claims.sub);
    expect(info.email).toBe('anna.virtanen@example.org');

    const endUrl = client.buildEndSessionUrl(t.rp, {
      id_token_hint: /** @type {string} */ (tokens.id_token),
      post_logout_redirect_uri: POST_LOGOUT,
    });
    const logout = await b.go(endUrl.href);
    const action = /action="([^"]+)"/.exec(logout.body)?.[1];
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(logout.body)?.[1] ?? '';
    const bye = await b.post(
      new URL(/** @type {string} */ (action).replace(/&amp;/g, '&'), t.issuer).href,
      {
        xsrf,
        logout: 'yes',
      },
    );
    expect(bye.finalUrl.startsWith(POST_LOGOUT)).toBe(true);

    const { rows } = await t.pool.query(
      "SELECT action, ip FROM audit_events WHERE action IN ('signup')",
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('signs an existing user in without the name step, and offers "continue as" on the next request', async () => {
    const { b, done, verifier, state } = await signInUntilCode('anna.virtanen@example.org');
    expect(done.finalUrl.startsWith(REDIRECT)).toBe(true);
    const tokens = await t.exchange(done.finalUrl, verifier, state);
    expect(/** @type {any} */ (tokens.claims()).name).toBe('Anna V.');

    // Same browser, new request: a session exists, so the user is asked to confirm the account.
    const second = await t.startAuth(b);
    expect(second.page.body).toContain('Continue as Anna V.');
    const path = t.interactionPath(second.page.body);
    const cont = await b.post(`${t.origin}${path}/continue`, {});
    expect(cont.finalUrl.startsWith(REDIRECT)).toBe(true);

    // prompt=none succeeds silently with the session.
    const silent = await t.startAuth(b, { prompt: 'none' });
    expect(silent.page.finalUrl.startsWith(REDIRECT)).toBe(true);
    expect(new URL(silent.page.finalUrl).searchParams.get('code')).toBeTruthy();

    // prompt=login forces a fresh email prompt.
    const forced = await t.startAuth(b, { prompt: 'login' });
    expect(forced.page.body).toContain('name="email"');
    expect(forced.page.body).not.toContain('Continue as');
  });

  it('chooses another account from the continue page', async () => {
    const { b } = await signInUntilCode('ben.korhonen@example.org');
    const second = await t.startAuth(b);
    const path = t.interactionPath(second.page.body);
    const other = await b.post(`${t.origin}${path}/other`, {});
    expect(other.body).toContain('name="email"');
  });
});

describe('codes', () => {
  it('locks a code after 5 wrong attempts, even for the right code', async () => {
    const b = browser();
    const { page } = await t.startAuth(b);
    const path = t.interactionPath(page.body);
    await b.post(`${t.origin}${path}/email`, { email: 'lock.test@example.org' });
    const good = /** @type {any} */ (t.mails.at(-1)).code;
    const bad = good === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const r = await b.post(`${t.origin}${path}/code`, { code: bad });
      expect(r.res.status).toBe(400);
    }
    const r = await b.post(`${t.origin}${path}/code`, { code: good });
    expect(r.res.status).toBe(400);
    const { rows } = await t.pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'code_failed'",
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(5);
  });

  it('does not accept a code twice', async () => {
    const { b, path, mail } = await signInUntilCode('twice.test@example.org');
    const again = await b.post(`${t.origin}${path}/code`, { code: mail.code });
    expect(again.res.status).toBe(400);
  });

  it('sends no code for denied addresses but responds the same', async () => {
    const before = t.mails.length;
    const b = browser();
    const { page } = await t.startAuth(b);
    const path = t.interactionPath(page.body);
    const denied = await b.post(`${t.origin}${path}/email`, { email: 'ext-guest@example.org' });
    const other = await b.post(`${t.origin}${path}/email`, { email: 'nobody@elsewhere.test' });
    expect(denied.res.status).toBe(200);
    expect(denied.body).toBe(other.body);
    expect(t.mails.length).toBe(before);
  });
});

describe('sign-in link', () => {
  it('never signs in on GET, and completes on POST in the same browser', async () => {
    const b = browser();
    const { page, verifier, state } = await t.startAuth(b);
    const path = t.interactionPath(page.body);
    await b.post(`${t.origin}${path}/email`, { email: 'link.user@example.org' });
    const link = /** @type {any} */ (t.mails.at(-1)).link;
    expect(link.startsWith(`${t.issuer}/interaction/`)).toBe(true);

    const opened = await b.go(link);
    expect(opened.res.status).toBe(200);
    expect(opened.body).toContain('<button>');
    expect(opened.finalUrl.startsWith(REDIRECT)).toBe(false);

    const confirmed = await b.post(link, {});
    // New user: the name step follows.
    expect(confirmed.body).toContain('name="name"');
    const named = await b.post(`${t.origin}${path}/name`, { name: 'Link User' });
    expect(named.finalUrl.startsWith(REDIRECT)).toBe(true);
    await t.exchange(named.finalUrl, verifier, state);
  });

  it('shows the code when opened in another browser', async () => {
    const b = browser();
    const { page } = await t.startAuth(b);
    const path = t.interactionPath(page.body);
    await b.post(`${t.origin}${path}/email`, { email: 'other.browser@example.org' });
    const mail = /** @type {any} */ (t.mails.at(-1));
    const elsewhere = await browser().go(mail.link);
    expect(elsewhere.body).toContain(mail.code);
    // The original browser can still use the code.
    const done = await b.post(`${t.origin}${path}/code`, { code: mail.code });
    expect(done.body).toContain('name="name"');
  });

  it('rejects a wrong token', async () => {
    const b = browser();
    const { page } = await t.startAuth(b);
    const path = t.interactionPath(page.body);
    await b.post(`${t.origin}${path}/email`, { email: 'wrong.token@example.org' });
    const bad = await b.go(`${t.origin}${path}/link/not-the-token`);
    expect(bad.res.status).toBe(400);
  });
});

describe('accounts', () => {
  it('does not let a disabled user sign in', async () => {
    const first = await signInUntilCode('disabled.user@example.org');
    await first.b.post(`${t.origin}${first.path}/name`, { name: 'Disabled User' });
    expect(
      (await t.pool.query("SELECT 1 FROM users WHERE email = 'disabled.user@example.org'"))
        .rowCount,
    ).toBe(1);
    await t.pool.query(
      "UPDATE users SET status = 'disabled' WHERE email = 'disabled.user@example.org'",
    );
    const before = t.mails.length;
    const b = browser();
    const { page } = await t.startAuth(b);
    const path = t.interactionPath(page.body);
    const r = await b.post(`${t.origin}${path}/email`, { email: 'disabled.user@example.org' });
    expect(r.res.status).toBe(200);
    expect(t.mails.length).toBe(before);
  });
});

describe('pages', () => {
  it('sets security headers and no inline scripts', async () => {
    const b = browser();
    const { page } = await t.startAuth(b);
    const h = page.res.headers;
    expect(h.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(h.get('content-security-policy')).not.toContain('script-src');
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('cache-control')).toBe('no-store');
    expect(page.body).not.toContain('<script');
  });

  it('renders in the browser language, with Finnish mail text', async () => {
    const b = browser('fi');
    const { page } = await t.startAuth(b);
    expect(page.body).toContain('Sähköpostiosoite');
    const path = t.interactionPath(page.body);
    await b.post(`${t.origin}${path}/email`, { email: 'suomi.kayttaja@example.org' });
    expect(/** @type {any} */ (t.mails.at(-1)).locale).toBe('fi');
  });
});
