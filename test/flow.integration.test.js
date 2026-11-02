import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as client from 'openid-client';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, migrate } from '../src/db.js';
import { ensureSigningKey } from '../src/oidc/keys.js';

const SCHEMA = 'tunnus_flow_test';
const REDIRECT = 'https://rp.example.org/cb';
const POST_LOGOUT = 'https://rp.example.org/bye';

/** Minimal cookie-aware fetch that follows redirects until it reaches the RP. */
function browser() {
  /** @type {Map<string, string>} */
  const jar = new Map();
  /** @param {Response} res */
  const store = (res) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(name);
      else jar.set(name, value);
    }
  };
  /**
   * @param {string} url
   * @param {RequestInit} [init]
   * @returns {Promise<{ res: Response, finalUrl: string, body: string }>}
   */
  async function go(url, init = {}) {
    for (let i = 0; i < 15; i++) {
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(url, {
        ...init,
        redirect: 'manual',
        headers: { ...init.headers, cookie },
      });
      store(res);
      const loc = res.headers.get('location');
      if (loc) {
        const next = new URL(loc, url).href;
        if (next.startsWith(REDIRECT) || next.startsWith(POST_LOGOUT))
          return { res, finalUrl: next, body: '' };
        url = next;
        init = {};
        continue;
      }
      return { res, finalUrl: url, body: await res.text() };
    }
    throw new Error('too many redirects');
  }
  return { go };
}

describe('authorization code flow with PKCE', () => {
  /** @type {http.Server} */ let server;
  /** @type {pg.Pool} */ let pool;
  let issuer = '';
  /** @type {string[]} */ const codes = [];

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
    await admin.end();

    server = http.createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
    const port = /** @type {any} */ (server.address()).port;
    issuer = `http://127.0.0.1:${port}/id`;

    const config = loadConfig({
      ISSUER: issuer,
      DATABASE_URL: /** @type {string} */ (process.env.DATABASE_URL),
      KEY_ENCRYPTION_SECRET: 'test-secret',
      COOKIE_SECRETS: 'cookie-secret',
      SIGNUP_EMAIL_ALLOW: '*@example.org',
      SIGNUP_EMAIL_DENY: 'ext-*@example.org',
      DEFAULT_GROUPS: 'all',
    });
    pool = createPool(config.databaseUrl, SCHEMA);
    await migrate(pool);
    await ensureSigningKey(pool, config.keyEncryptionSecret);
    const { app } = await createApp({
      config,
      pool,
      clients: [
        {
          client_id: 'rp',
          client_secret: 'rp-secret',
          redirect_uris: [REDIRECT],
          post_logout_redirect_uris: [POST_LOGOUT],
          token_endpoint_auth_method: 'client_secret_post',
          first_party: true,
          always_include_groups: true,
        },
      ],
      mailer: { sendCode: async (_to, code) => void codes.push(code) },
    });
    server.on('request', app);
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  /** Sign in with the given email in a fresh browser; returns callback URL. */
  async function signIn(
    /** @type {string} */ email,
    /** @type {client.Configuration} */ cfg,
    /** @type {any} */ b,
  ) {
    const verifier = client.randomPKCECodeVerifier();
    const challenge = await client.calculatePKCECodeChallenge(verifier);
    const state = client.randomState();
    const url = client.buildAuthorizationUrl(cfg, {
      redirect_uri: REDIRECT,
      scope: 'openid email profile',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });
    const page = await b.go(url.href);
    const uid = /action="([^"]+)\/email"/.exec(page.body)?.[1];
    expect(uid).toBeTruthy();
    const origin = new URL(issuer).origin;
    const sent = await b.go(`${origin}${uid}/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email }),
    });
    expect(sent.res.status).toBe(200);
    const code = codes.at(-1);
    const done = await b.go(`${origin}${uid}/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: /** @type {string} */ (code) }),
    });
    return { done, verifier, state };
  }

  it('signs a new user up, issues tokens with groups and ends the session', async () => {
    const cfg = await client.discovery(
      new URL(issuer),
      'rp',
      { client_secret: 'rp-secret' },
      client.ClientSecretPost('rp-secret'),
      {
        execute: [client.allowInsecureRequests],
      },
    );
    expect(cfg.serverMetadata().issuer).toBe(issuer);

    const b = browser();
    const { done, verifier, state } = await signIn('anna.virtanen@example.org', cfg, b);
    expect(done.finalUrl.startsWith(REDIRECT)).toBe(true);

    const tokens = await client.authorizationCodeGrant(cfg, new URL(done.finalUrl), {
      pkceCodeVerifier: verifier,
      expectedState: state,
      idTokenExpected: true,
    });
    const claims = /** @type {any} */ (tokens.claims());
    expect(claims.iss).toBe(issuer);
    expect(claims.email).toBe('anna.virtanen@example.org');
    expect(claims.name).toBe('Anna Virtanen');
    expect(claims.groups).toEqual(['all']); // always_include_groups

    const info = await client.fetchUserInfo(cfg, tokens.access_token, claims.sub);
    expect(info.email).toBe('anna.virtanen@example.org');

    const endUrl = client.buildEndSessionUrl(cfg, {
      id_token_hint: /** @type {string} */ (tokens.id_token),
      post_logout_redirect_uri: POST_LOGOUT,
    });
    const logout = await b.go(endUrl.href);
    const action = /action="([^"]+)"/.exec(logout.body)?.[1];
    expect(action).toBeTruthy();
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(logout.body)?.[1] ?? '';
    const bye = await b.go(
      new URL(/** @type {string} */ (action).replace(/&amp;/g, '&'), issuer).href,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ xsrf, logout: 'yes' }),
      },
    );
    expect(bye.finalUrl.startsWith(POST_LOGOUT)).toBe(true);
  });

  it('does not send a code for denied addresses, with the same response', async () => {
    const cfg = await client.discovery(
      new URL(issuer),
      'rp',
      { client_secret: 'rp-secret' },
      client.ClientSecretPost('rp-secret'),
      {
        execute: [client.allowInsecureRequests],
      },
    );
    const before = codes.length;
    const b = browser();
    const verifier = client.randomPKCECodeVerifier();
    const url = client.buildAuthorizationUrl(cfg, {
      redirect_uri: REDIRECT,
      scope: 'openid',
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    const page = await b.go(url.href);
    const action = /action="([^"]+)\/email"/.exec(page.body)?.[1];
    const sent = await b.go(`${new URL(issuer).origin}${action}/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'ext-guest@example.org' }),
    });
    expect(sent.res.status).toBe(200);
    expect(sent.body).toContain('we have sent');
    expect(codes.length).toBe(before);
  });
});
