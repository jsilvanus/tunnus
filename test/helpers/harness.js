import http from 'node:http';
import * as client from 'openid-client';
import { expect, vi } from 'vitest';
import pg from 'pg';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createPool, migrate } from '../../src/db.js';
import { ensureDefaultGroups } from '../../src/accounts.js';
import { createMailer } from '../../src/mail.js';
import { ensureSigningKey } from '../../src/oidc/keys.js';
import { syncFromFile } from '../../src/clients/store.js';

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
 * @param {{ schema: string, env?: Record<string, string>, clients?: Record<string, any>[], transport?: import('../../src/mail.js').Transport }} opts
 */
export async function startTunnus({ schema, env = {}, clients, transport }) {
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
    KEY_ENCRYPTION_SECRET: 'test-key-encryption-secret-0123456789',
    COOKIE_SECRETS: 'cookie-secret-0123',
    SIGNUP_EMAIL_ALLOW: '*@example.org',
    SIGNUP_EMAIL_DENY: 'ext-*@example.org',
    DEFAULT_GROUPS: 'all',
    KEY_RELOAD_INTERVAL_SECONDS: '0',
    ...env,
  });
  const pool = createPool(config.databaseUrl, schema);
  await migrate(pool);
  await ensureDefaultGroups(pool, config.defaultGroups);
  await ensureSigningKey(pool, config.keyEncryptionSecret);

  /** @type {{ to: string, code: string, link: string, locale: string, text?: string }[]} */
  const mails = [];
  const mailer = createMailer(config, transport ?? { send: async () => {} });
  const capturing = {
    /** @param {string} to @param {string} code @param {string} link @param {any} locale */
    async sendCode(to, code, link, locale) {
      mails.push({ to, code, link, locale });
      await mailer.sendCode(to, code, link, locale);
    },
    /** @param {string} to @param {Date} deleteOn @param {any} locale */
    async sendInactiveWarning(to, deleteOn, locale) {
      mails.push({ to, code: '', link: '', locale, text: `deleted on ${deleteOn.toISOString()}` });
      await mailer.sendInactiveWarning(to, deleteOn, locale);
    },
    /** @param {import('../../src/mail.js').Message} message */
    async send(message) {
      await mailer.send?.(message);
    },
  };

  const seedClients = clients ?? [
    {
      client_id: 'rp',
      client_secret: 'rp-secret',
      redirect_uris: [REDIRECT],
      post_logout_redirect_uris: [POST_LOGOUT],
      token_endpoint_auth_method: 'client_secret_post',
      first_party: true,
      always_include_groups: true,
    },
  ];
  await syncFromFile(pool, seedClients, config.keyEncryptionSecret);

  const { app, holder, metrics } = await createApp(
    {
      config,
      pool,
      mailer: capturing,
    },
    { validateResponses: true },
  );
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
    holder,
    metrics,
    async close() {
      await holder.stop();
      await new Promise((r) => server.close(r));
      await pool.end();
    },
  };
}

/**
 * Sign an address in or up on an interaction page, through the code and, for a new address, the
 * name step. A consent page that follows (offline_access) is accepted. Returns the last response;
 * its finalUrl is the relying party's callback when the sign-in succeeded.
 * @param {Awaited<ReturnType<typeof startTunnus>>} t
 * @param {ReturnType<typeof browser>} b
 * @param {string} path the `/interaction/<uid>` path
 * @param {string} email
 * @param {string} [name]
 */
export async function signInThrough(t, b, path, email, name = 'Test Person') {
  const before = t.mails.length;
  await b.post(`${t.origin}${path}/email`, { email });
  await waitForMail(t, before + 1);
  let done = await b.post(`${t.origin}${path}/code`, {
    code: /** @type {any} */ (t.mails.at(-1)).code,
  });
  if (!done.finalUrl.startsWith(REDIRECT)) done = await b.post(`${t.origin}${path}/name`, { name });
  if (!done.finalUrl.startsWith(REDIRECT) && done.body.includes('/confirm"')) {
    const next = /** @type {string} */ (t.interactionPath(done.body));
    done = await b.post(`${t.origin}${next}/confirm`, {});
  }
  return done;
}

/**
 * Wait until the harness has recorded at least `count` mails (sending runs in the background).
 * @param {Awaited<ReturnType<typeof startTunnus>>} t
 * @param {number} count
 */
const waitForMail = (t, count) =>
  vi.waitFor(() => expect(t.mails.length).toBeGreaterThanOrEqual(count));
