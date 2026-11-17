import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as client from 'openid-client';
import { browser, POST_LOGOUT, signInThrough, startTunnus } from './helpers/harness.js';

/** @type {Awaited<ReturnType<typeof startTunnus>>} */
let t;
beforeAll(async () => {
  t = await startTunnus({ schema: 'tunnus_logout_test' });
});
afterAll(async () => {
  await t.close();
});

/** Sign a browser in and return what the logout tests need. */
async function signedIn(/** @type {string} */ email) {
  const b = browser();
  const { page, verifier, state } = await t.startAuth(b);
  const done = await signInThrough(
    t,
    b,
    /** @type {string} */ (t.interactionPath(page.body)),
    email,
  );
  const tokens = await t.exchange(done.finalUrl, verifier, state);
  return { b, idToken: /** @type {string} */ (tokens.id_token), accessToken: tokens.access_token };
}

/** The logout confirmation page for an id token. */
async function logoutPage(
  /** @type {any} */ b,
  /** @type {string} */ idToken,
  /** @type {Record<string, string>} */ extra = {},
) {
  const url = client.buildEndSessionUrl(t.rp, { id_token_hint: idToken, ...extra });
  return b.go(url.href);
}

/** The form action and xsrf value of a logout page. */
function formOf(/** @type {string} */ body) {
  const action = /** @type {string} */ (
    /<form id="op\.logoutForm"[^>]*action="([^"]+)"/.exec(body)?.[1]
  );
  const xsrf = /name="xsrf" value="([^"]+)"/.exec(body)?.[1] ?? '';
  return { action: action.replace(/&amp;/g, '&'), xsrf };
}

describe('logout pages', () => {
  it('renders the branded confirmation page under the CSP, with no script and no outside resources', async () => {
    const { b, idToken } = await signedIn('logout.page@example.org');
    const page = await logoutPage(b, idToken, { post_logout_redirect_uri: POST_LOGOUT });
    expect(page.res.status).toBe(200);
    expect(page.res.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(page.res.headers.get('content-type')).toContain('text/html');
    expect(page.body).toContain('<title>Sign out · Tunnus</title>');
    expect(page.body).toContain('Do you want to sign out?');
    expect(page.body).toContain('name="logout" value="yes"');
    expect(page.body).toContain('form="op.logoutForm"');
    expect(page.body).toContain('name="xsrf"');
    expect(page.body).not.toMatch(/<script/i);
    expect(page.body).not.toContain('googleapis');
  });

  it('keeps the session when the user cancels', async () => {
    const { b, idToken } = await signedIn('logout.cancel@example.org');
    const page = await logoutPage(b, idToken, { post_logout_redirect_uri: POST_LOGOUT });
    const { action, xsrf } = formOf(page.body);
    // The cancel button submits the same form without `logout`.
    await b.post(new URL(action, t.issuer).href, { xsrf });
    const silent = await t.startAuth(b, { prompt: 'none' });
    expect(new URL(silent.page.finalUrl).searchParams.get('code')).toBeTruthy();
  });

  it('signs out on confirm and redirects to the post-logout URI', async () => {
    const { b, idToken } = await signedIn('logout.confirm@example.org');
    const page = await logoutPage(b, idToken, { post_logout_redirect_uri: POST_LOGOUT });
    const { action, xsrf } = formOf(page.body);
    const bye = await b.post(new URL(action, t.issuer).href, { xsrf, logout: 'yes' });
    expect(bye.finalUrl.startsWith(POST_LOGOUT)).toBe(true);
    const silent = await t.startAuth(b, { prompt: 'none' });
    expect(new URL(silent.page.finalUrl).searchParams.get('error')).toBe('login_required');
  });

  it('shows the branded signed-out page when there is no post-logout URI', async () => {
    const { b, idToken } = await signedIn('logout.done@example.org');
    const page = await logoutPage(b, idToken);
    const { action, xsrf } = formOf(page.body);
    const bye = await b.post(new URL(action, t.issuer).href, { xsrf, logout: 'yes' });
    expect(bye.body).toContain('You have signed out');
    expect(bye.body).not.toMatch(/<script/i);
  });
});

describe('token revocation', () => {
  it('is advertised and revokes an access token', async () => {
    const discovery = await (await fetch(`${t.issuer}/.well-known/openid-configuration`)).json();
    expect(discovery.revocation_endpoint).toBeTruthy();

    const { accessToken } = await signedIn('logout.revoke@example.org');
    const userinfo = discovery.userinfo_endpoint;
    const info = await fetch(userinfo, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(info.status).toBe(200);
    const revoked = await fetch(discovery.revocation_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: accessToken,
        client_id: 'rp',
        client_secret: 'rp-secret',
      }),
    });
    expect(revoked.status).toBe(200);
    const after = await fetch(userinfo, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(after.status).toBe(401);
  });
});
