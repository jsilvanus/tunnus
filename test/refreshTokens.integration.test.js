import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { browser, POST_LOGOUT, REDIRECT, signInThrough, startTunnus } from './helpers/harness.js';

const REFRESH_CLIENT = {
  client_id: 'rp',
  client_secret: 'rp-secret',
  redirect_uris: [REDIRECT],
  post_logout_redirect_uris: [POST_LOGOUT],
  token_endpoint_auth_method: 'client_secret_post',
  grant_types: ['authorization_code', 'refresh_token'],
  first_party: true,
};

/**
 * Sign in with offline_access and return the token set.
 * @param {Awaited<ReturnType<typeof startTunnus>>} t
 * @param {string} email
 */
async function tokensWithOfflineAccess(t, email) {
  const b = browser();
  // offline_access is only kept when the request asks for prompt=consent (oidc-provider).
  const { page, verifier, state } = await t.startAuth(b, {
    scope: 'openid email profile offline_access',
    prompt: 'consent',
  });
  const done = await signInThrough(
    t,
    b,
    /** @type {string} */ (t.interactionPath(page.body)),
    email,
  );
  return t.exchange(done.finalUrl, verifier, state);
}

describe('offline_access needs the refresh_token grant type', () => {
  /** @type {Awaited<ReturnType<typeof startTunnus>>} */
  let plain;
  /** @type {Awaited<ReturnType<typeof startTunnus>>} */
  let refreshing;
  beforeAll(async () => {
    plain = await startTunnus({ schema: 'tunnus_refresh_plain_test' });
    refreshing = await startTunnus({
      schema: 'tunnus_refresh_grant_test',
      clients: [REFRESH_CLIENT],
    });
  });
  afterAll(async () => {
    await plain.close();
    await refreshing.close();
  });

  it('issues no refresh token to a client without the refresh_token grant', async () => {
    const tokens = await tokensWithOfflineAccess(plain, 'plain.refresh@example.org');
    expect(tokens.refresh_token).toBeUndefined();
  });

  it('issues a refresh token to a client that has the refresh_token grant', async () => {
    const tokens = await tokensWithOfflineAccess(refreshing, 'refresh.grant@example.org');
    expect(tokens.refresh_token).toBeTruthy();
  });
});

describe('clients.example.json', () => {
  it('lists the grant types the refresh token flow needs', () => {
    const file = fileURLToPath(new URL('../clients.example.json', import.meta.url));
    const [client] = JSON.parse(readFileSync(file, 'utf8'));
    expect(client.grant_types).toEqual(['authorization_code', 'refresh_token']);
  });
});
