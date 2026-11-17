import http from 'node:http';
import * as client from 'openid-client';
import pg from 'pg';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createPool, migrate } from '../../src/db.js';
import { createMailer } from '../../src/mail.js';
import { ensureSigningKey } from '../../src/oidc/keys.js';

export const REDIRECT = 'https://rp.example.org/cb';
export const POST_LOGOUT = 'https://rp.example.org/bye';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

/** Cookie-aware (path-scoped) fetch that follows redirects until it reaches the relying party. */
export function browser(lang = 'en') {
  /** @type {Map<string, { value: string, path: string }>} */
  const jar = new Map();
  /** @param {Response} res @param {string} url */
  const store = (res, url) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';').map((s) => s.trim());
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      const path = attrs.find((a) => /^path=/i.test(a))?.slice(5) ?? new URL(url).pathname;
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(name + path);
      else jar.set(name + path, { value: `${name}=${value}`, path });
    }
  };
  /**
   * @param {string} url
   * @param {RequestInit} [init]
   * @returns {Promise<{ res: Response, finalUrl: string, body: string }>}
   */
  async function go(url, init = {}) {
    for (let i = 0; i < 15; i++) {
      const path = new URL(url).pathname;
      const cookie = [...jar.values()]
        .filter((c) => path.startsWith(c.path))
        .map((c) => c.value)
        .join('; ');
      const res = await fetch(url, {
        ...init,
        redirect: 'manual',
        headers: { 'accept-language': lang, ...init.headers, cookie },
      });
      store(res, url);
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
  /** @param {string} url @param {Record<string, string>} data */
  const post = (url, data) =>
    go(url, { method: 'POST', headers: FORM, body: new URLSearchParams(data) });
  return { go, post };
}

/**
 * Start Tunnus on an ephemeral port in an isolated schema.
 * @param {{ schema: string, env?: Record<string, string>, clients?: Record<string, any>[] }} opts
 */
export async function startTunnus({ schema, env = {}, clients }) {
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
  await admin.end();

  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const port = /** @type {any} */ (server.address()).port;
  const issuer = `http://127.0.0.1:${port}/id`;
  const origin = new URL(issuer).origin;

  const config = loadConfig({
    ISSUER: issuer,
    DATABASE_URL: /** @type {string} */ (process.env.DATABASE_URL),
    KEY_ENCRYPTION_SECRET: 'test-secret',
    COOKIE_SECRETS: 'cookie-secret',
    SIGNUP_EMAIL_ALLOW: '*@example.org',
    SIGNUP_EMAIL_DENY: 'ext-*@example.org',
    DEFAULT_GROUPS: 'all',
    ...env,
  });
  const pool = createPool(config.databaseUrl, schema);
  await migrate(pool);
  await ensureSigningKey(pool, config.keyEncryptionSecret);

  /** @type {{ to: string, code: string, link: string, locale: string, text?: string }[]} */
  const mails = [];
  const mailer = createMailer(config, {
    send: async () => {},
  });
  const capturing = {
    /** @param {string} to @param {string} code @param {string} link @param {any} locale */
    async sendCode(to, code, link, locale) {
      mails.push({ to, code, link, locale });
      await mailer.sendCode(to, code, link, locale);
    },
  };

  const { app } = await createApp({
    config,
    pool,
    clients: clients ?? [
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
    mailer: capturing,
  });
  server.on('request', app);

  const rp = await client.discovery(
    new URL(issuer),
    'rp',
    { client_secret: 'rp-secret' },
    client.ClientSecretPost('rp-secret'),
    {
      execute: [client.allowInsecureRequests],
    },
  );

  /**
   * Start an authorization request and return its first page (via the browser).
   * @param {ReturnType<typeof browser>} b
   * @param {Record<string, string>} [extra]
   */
  async function startAuth(b, extra = {}) {
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const url = client.buildAuthorizationUrl(rp, {
      redirect_uri: REDIRECT,
      scope: 'openid email profile',
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      ...extra,
    });
    const page = await b.go(url.href);
    return { page, verifier, state };
  }

  /** The `/interaction/<uid>` path in a page body. */
  const interactionPath = (/** @type {string} */ body) =>
    /action="([^"]*\/interaction\/[^"/]+)\//.exec(body)?.[1];

  /** Exchange the callback URL for tokens. */
  const exchange = (
    /** @type {string} */ callback,
    /** @type {string} */ verifier,
    /** @type {string} */ state,
  ) =>
    client.authorizationCodeGrant(rp, new URL(callback), {
      pkceCodeVerifier: verifier,
      expectedState: state,
      idTokenExpected: true,
    });

  return {
    issuer,
    origin,
    pool,
    config,
    mails,
    rp,
    startAuth,
    interactionPath,
    exchange,
    async close() {
      await new Promise((r) => server.close(r));
      await pool.end();
    },
  };
}
