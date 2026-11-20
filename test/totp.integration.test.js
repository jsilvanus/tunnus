import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as client from 'openid-client';
import { startAdmin } from './helpers/admin.js';
import { REDIRECT, browser } from './helpers/harness.js';
import { base32Decode, totpCode } from '../src/totp.js';

const RP = {
  client_id: 'rp',
  client_secret: 'rp-secret',
  redirect_uris: [REDIRECT],
  token_endpoint_auth_method: 'client_secret_post',
  grant_types: ['authorization_code'],
  first_party: true,
  always_include_groups: true,
};

/** @type {Awaited<ReturnType<typeof startAdmin>>} */
let t;
/** @type {Awaited<ReturnType<typeof client.discovery>>} */
let oidcConfig;

beforeAll(async () => {
  t = await startAdmin({ schema: 'tunnus_totp_test', clients: [RP] });
  oidcConfig = await client.discovery(
    new URL(t.issuer),
    RP.client_id,
    RP.client_secret,
    undefined,
    {
      execute: [client.allowInsecureRequests],
    },
  );
});

afterAll(async () => {
  await t.close();
});

/**
 * @param {string} method
 * @param {string} path
 * @param {Record<string, unknown>} [body]
 */
const api = (method, path, body) => t.api(method, path, { token: t.token, body });

/**
 * @param {{ body: string, finalUrl: string }} page
 * @param {string} [suffix]
 */
function formAction(page, suffix = '') {
  const re = suffix ? new RegExp(`action="([^"]*${suffix})"`) : /action="([^"]*)"/;
  const match = page.body.match(re);
  expect(match?.[1]).toBeTruthy();
  return new URL(/** @type {string} */ (match?.[1]), page.finalUrl).href;
}

/**
 * Start an OIDC authorization request and submit the email address.
 * @param {string} email
 */
async function startLogin(email) {
  const b = browser();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const authUrl = client.buildAuthorizationUrl(oidcConfig, {
    redirect_uri: REDIRECT,
    scope: 'openid email profile',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  const loginPage = await b.go(authUrl.href);
  const emailRes = await b.post(formAction(loginPage, '/email'), { email });
  return { b, emailRes, codeVerifier };
}

describe('TOTP sign-in and admin provisioning', () => {
  it('enables TOTP via admin API, signs in without email, and blocks replay', async () => {
    const email = 'totp-user@example.org';
    const created = await api('POST', '/users', { email });
    expect(created.status).toBe(201);
    const userId = /** @type {any} */ (created.body).id;

    // Freshly admin-created user has no last_email_verified_at yet; set it to now for the first TOTP test.
    await t.pool.query('UPDATE users SET last_email_verified_at = now() WHERE id = $1', [userId]);

    const prov = await api('POST', `/users/${userId}/totp`);
    expect(prov.status).toBe(200);
    const { secret, otpauth_uri } = /** @type {{ secret: string, otpauth_uri: string }} */ (
      prov.body
    );
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(otpauth_uri).toContain(`secret=${secret}`);

    const userRes = await api('GET', `/users/${userId}`);
    expect(/** @type {any} */ (userRes.body).totp_enabled).toBe(true);

    const sentBefore = t.mails.length;
    const { b, emailRes } = await startLogin(email);
    expect(emailRes.res.status).toBe(200);
    // No email should have been sent for a TOTP-eligible user.
    expect(t.mails.length).toBe(sentBefore);

    const code = totpCode(base32Decode(secret));
    const done = await b.post(formAction(emailRes, '/code'), { code });
    expect(done.finalUrl.startsWith(REDIRECT)).toBe(true);

    // Replaying the same TOTP code in a new login must fail.
    const second = await startLogin(email);
    const replay = await second.b.post(formAction(second.emailRes, '/code'), { code });
    expect(replay.res.status).toBe(400);
  });

  it('requires email re-verification after TOTP_EMAIL_REVERIFY_DAYS and refreshes it on email login', async () => {
    const email = 'reverify@example.org';
    const created = await api('POST', '/users', { email });
    const userId = /** @type {any} */ (created.body).id;
    const prov = await api('POST', `/users/${userId}/totp`);
    const { secret } = /** @type {{ secret: string }} */ (prov.body);

    // Simulate last_email_verified_at 8 days ago (> 7 day default).
    await t.pool.query(
      "UPDATE users SET last_email_verified_at = now() - interval '8 days' WHERE id = $1",
      [userId],
    );

    const sentBefore = t.mails.length;
    const { b, emailRes } = await startLogin(email);
    // Email code must be sent when re-verification is overdue.
    expect(t.mails.length).toBe(sentBefore + 1);
    const mail = t.mails[t.mails.length - 1];

    // TOTP code should be rejected while re-verification is overdue.
    const totpAttempt = await b.post(formAction(emailRes, '/code'), {
      code: totpCode(base32Decode(secret)),
    });
    expect(totpAttempt.res.status).toBe(400);

    // Email code succeeds and refreshes last_email_verified_at.
    const emailAttempt = await b.post(formAction(totpAttempt, '/code'), { code: mail.code });
    expect(emailAttempt.finalUrl.startsWith(REDIRECT)).toBe(true);

    const sentAfter = t.mails.length;
    const nextLogin = await startLogin(email);
    expect(t.mails.length).toBe(sentAfter);
    // Reset totp_last_step so the same 30s window isn't treated as a replay in fast tests.
    await t.pool.query('UPDATE users SET totp_last_step = NULL WHERE id = $1', [userId]);
    const okTotp = await nextLogin.b.post(formAction(nextLogin.emailRes, '/code'), {
      code: totpCode(base32Decode(secret)),
    });
    expect(okTotp.finalUrl.startsWith(REDIRECT)).toBe(true);
  });

  it('supports resend fallback, locks TOTP after 5 failures, and disables TOTP via admin API', async () => {
    const email = 'lockout@example.org';
    const created = await api('POST', '/users', { email });
    const userId = /** @type {any} */ (created.body).id;
    await t.pool.query('UPDATE users SET last_email_verified_at = now() WHERE id = $1', [userId]);
    await api('POST', `/users/${userId}/totp`);

    const { b, emailRes } = await startLogin(email);
    let page = emailRes;
    for (let i = 0; i < 5; i++) {
      page = await b.post(formAction(page, '/code'), { code: '000000' });
      expect(page.res.status).toBe(400);
    }

    // Trigger resend fallback via the secondary form action.
    const sentBefore = t.mails.length;
    const resent = await b.post(formAction(page, '/resend'), {});
    expect(resent.res.status).toBe(200);
    expect(t.mails.length).toBe(sentBefore + 1);
    const mail = t.mails[t.mails.length - 1];

    const done = await b.post(formAction(resent, '/code'), { code: mail.code });
    expect(done.finalUrl.startsWith(REDIRECT)).toBe(true);

    const del = await api('DELETE', `/users/${userId}/totp`);
    expect(del.status).toBe(204);
    const userRes = await api('GET', `/users/${userId}`);
    expect(/** @type {any} */ (userRes.body).totp_enabled).toBe(false);
  });

  it('allows self-service TOTP enrollment and removal on /account with confirmation', async () => {
    const email = 'selfservice@example.org';
    const created = await api('POST', '/users', { email });
    expect(created.status).toBe(201);

    const b = browser();
    const acctPage = await b.go(`${t.issuer}/account`);
    expect(acctPage.res.status).toBe(200);

    const sentBefore = t.mails.length;
    const codeForm = await b.post(formAction(acctPage, '/account/login'), { email });
    expect(t.mails.length).toBe(sentBefore + 1);
    const mail = t.mails[t.mails.length - 1];

    const signedIn = await b.post(formAction(codeForm, '/account/login/code'), { code: mail.code });
    expect(signedIn.res.status).toBe(200);
    expect(signedIn.body).toContain(email);

    const csrf = signedIn.body.match(/name="csrf" value="([^"]+)"/)?.[1];
    expect(csrf).toBeTruthy();

    // Start TOTP setup (gets QR code + Base32 secret)
    const setupPage = await b.post(formAction(signedIn, '/account/totp/start'), {
      csrf: /** @type {string} */ (csrf),
    });
    expect(setupPage.res.status).toBe(200);
    expect(setupPage.body).toContain('data:image/svg+xml;base64,');
    const secret = setupPage.body.match(/<code>([A-Z2-7]+)<\/code>/)?.[1];
    expect(secret).toBeTruthy();

    // Invalid confirmation code must fail (400) without enabling TOTP
    const badConfirm = await b.post(formAction(setupPage, '/account/totp/confirm'), {
      csrf: /** @type {string} */ (csrf),
      code: '000000',
    });
    expect(badConfirm.res.status).toBe(400);

    // Valid confirmation code enables TOTP
    const okConfirm = await b.post(formAction(badConfirm, '/account/totp/confirm'), {
      csrf: /** @type {string} */ (csrf),
      code: totpCode(base32Decode(/** @type {string} */ (secret))),
    });
    expect(okConfirm.res.status).toBe(200);
    expect(okConfirm.body).toContain('Enabled');

    // Disable TOTP from /account
    const afterDisable = await b.post(formAction(okConfirm, '/account/totp/disable'), {
      csrf: /** @type {string} */ (csrf),
    });
    expect(afterDisable.res.status).toBe(200);
    expect(afterDisable.body).toContain('Not enabled');
  });
});
