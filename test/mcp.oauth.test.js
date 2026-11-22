import http from 'node:http';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSpec } from '../src/admin/spec.js';
import { createAdminAuth } from '../src/admin/auth.js';
import { createAdminRouter } from '../src/admin/router.js';
import { createLocalAdminFetch } from '../src/app.js';
import { createMcpHttpApp } from '../src/mcp/http.js';
import { createMcpJwtVerifier, protectedResourceMetadata, verifyMcpJwt } from '../src/mcp/oauth.js';

const ISSUER = 'https://id.example.org';
const RESOURCE = `${ISSUER}/mcp`;
const RESOURCE_METADATA_URL = `${ISSUER}/.well-known/oauth-protected-resource/mcp`;

function makeRsaKey(kid = 'k1') {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  return { jwk, privateKey };
}

/**
 * @param {Record<string, any>} claims
 * @param {import('node:crypto').KeyObject} privateKey
 * @param {string} [kid]
 */
function signJwt(claims, privateKey, kid = 'k1') {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = cryptoSign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString(
    'base64url',
  );
  return `${header}.${payload}.${sig}`;
}

function validClaims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: RESOURCE,
    sub: '6f1b1d0e-3c1e-4c7a-9a52-2f0f5a3c9b11',
    scope: 'openid mcp',
    iat: now - 5,
    exp: now + 300,
    ...overrides,
  };
}

describe('verifyMcpJwt', () => {
  const k1 = makeRsaKey('k1');
  const k2 = makeRsaKey('k2');
  const getJwks = async () => ({ keys: [k1.jwk] });

  it('accepts a valid RS256 token bound to issuer and resource', async () => {
    const token = signJwt(validClaims(), k1.privateKey, 'k1');
    const res = await verifyMcpJwt({ token, issuer: ISSUER, audience: RESOURCE, getJwks });
    expect(res).toMatchObject({
      ok: true,
      sub: '6f1b1d0e-3c1e-4c7a-9a52-2f0f5a3c9b11',
    });
  });

  it('rejects expired, wrong-issuer, wrong-audience, missing-scope, and forged tokens', async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases = [
      ['expired', signJwt(validClaims({ exp: now - 10 }), k1.privateKey)],
      ['bad_issuer', signJwt(validClaims({ iss: 'https://other.example' }), k1.privateKey)],
      ['bad_audience', signJwt(validClaims({ aud: 'https://other.example/mcp' }), k1.privateKey)],
      ['missing_scope', signJwt(validClaims({ scope: 'openid profile' }), k1.privateKey)],
      ['bad_signature', signJwt(validClaims(), k2.privateKey, 'k1')],
    ];
    for (const [reason, token] of cases) {
      const res = await verifyMcpJwt({ token, issuer: ISSUER, audience: RESOURCE, getJwks });
      expect(res).toEqual({ ok: false, reason });
    }
  });

  it('refreshes JWKS once when a new kid is encountered', async () => {
    let calls = 0;
    const verify = createMcpJwtVerifier({
      issuer: ISSUER,
      audience: RESOURCE,
      fetchJwks: async () => {
        calls += 1;
        return { keys: calls === 1 ? [k1.jwk] : [k1.jwk, k2.jwk] };
      },
    });
    expect((await verify(signJwt(validClaims(), k1.privateKey, 'k1'))).ok).toBe(true);
    expect(calls).toBe(1);
    expect((await verify(signJwt(validClaims(), k2.privateKey, 'k2'))).ok).toBe(true);
    expect(calls).toBe(2);
  });
});

describe('createMcpHttpApp with OAuth', () => {
  const k1 = makeRsaKey('k1');
  const spec = loadSpec();
  const verifyToken = createMcpJwtVerifier({
    issuer: ISSUER,
    audience: RESOURCE,
    fetchJwks: async () => ({ keys: [k1.jwk] }),
  });
  const app = createMcpHttpApp({
    spec,
    url: ISSUER,
    fetch: async () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
    oauth: {
      resourceUrl: RESOURCE,
      authorizationServerUrl: ISSUER,
      resourceMetadataUrl: RESOURCE_METADATA_URL,
      verifyToken,
    },
  });

  /** @type {http.Server} */
  let server;
  let base = '';
  beforeAll(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('serves RFC 9728 protected resource metadata', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(protectedResourceMetadata(RESOURCE, ISSUER));
    }
  });

  it('challenges missing and invalid tokens with 401 and resource_metadata', async () => {
    const missing = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${RESOURCE_METADATA_URL}", scope="mcp"`,
    );

    const invalid = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer not.a.jwt',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${RESOURCE_METADATA_URL}", scope="mcp", error="invalid_token"`,
    );
  });

  it('accepts a valid OAuth JWT and a static tun_ token', async () => {
    const jwt = signJwt(validClaims(), k1.privateKey, 'k1');
    const initBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
      },
    });
    const withJwt = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: initBody,
    });
    expect(withJwt.status).toBe(200);

    const staticToken = `tun_${'a'.repeat(43)}`;
    const withStatic = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${staticToken}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: initBody,
    });
    expect(withStatic.status).toBe(200);
  });
});

describe('createAdminAuth with OAuth JWT', () => {
  it('allows active admin users and rejects non-admins or disabled users', async () => {
    /** @param {{ status: string, is_admin: boolean } | undefined} user */
    const makeAuth = (user) =>
      createAdminAuth({
        pool: /** @type {any} */ ({
          query: async (/** @type {string} */ sql) => {
            if (sql.includes('FROM users')) return { rows: user ? [user] : [] };
            return { rows: [] };
          },
        }),
        verifyOAuthToken: async () => ({ ok: true, sub: 'u-1' }),
      });

    /** @param {any} mw */
    const run = (mw) =>
      new Promise((resolve) => {
        const req = /** @type {any} */ ({
          ip: '127.0.0.1',
          headers: { authorization: 'Bearer header.payload.sig' },
        });
        const res = /** @type {any} */ ({
          headers: /** @type {Record<string, string>} */ ({}),
          set(/** @type {string} */ k, /** @type {string} */ v) {
            this.headers[k] = v;
          },
          status(/** @type {number} */ code) {
            this.statusCode = code;
            return this;
          },
          json(/** @type {any} */ body) {
            resolve({ status: this.statusCode, body, req });
          },
        });
        mw(req, res, () => resolve({ status: 200, req }));
      });

    const ok = await run(makeAuth({ status: 'active', is_admin: true }));
    expect(ok.status).toBe(200);
    expect(ok.req.admin.tokenId).toBeNull();

    const notAdmin = await run(makeAuth({ status: 'active', is_admin: false }));
    expect(notAdmin.status).toBe(401);

    const disabled = await run(makeAuth({ status: 'disabled', is_admin: true }));
    expect(disabled.status).toBe(401);
  });

  it('dispatches getMe through createLocalAdminFetch and createAdminRouter with Express res methods', async () => {
    const adminUser = {
      id: '352ab752-99a5-48bd-9b7f-3749a19aad7e',
      email: 'juha.italeino@evl.fi',
      display_name: 'Juha Italeino',
      status: 'active',
      is_admin: true,
      created_at: new Date('2026-11-20T00:00:00.000Z'),
      last_login_at: null,
      last_email_verified_at: null,
      totp_enabled_at: null,
      groups: ['admin'],
    };
    const adminRouter = createAdminRouter({
      config: /** @type {any} */ ({ adminValidateResponses: true }),
      pool: /** @type {any} */ ({
        query: async (/** @type {string} */ sql) => {
          if (sql.includes('FROM users')) return { rows: [adminUser] };
          return { rows: [] };
        },
      }),
      clients: [],
      reloadKeys: async () => {},
      validateResponses: true,
      verifyOAuthToken: async () => ({ ok: true, sub: adminUser.id }),
    });
    const localFetch = createLocalAdminFetch(adminRouter, `${ISSUER}/admin/api/v1`);
    const res = await localFetch(`${ISSUER}/admin/api/v1/me`, {
      method: 'GET',
      headers: { authorization: 'Bearer header.payload.sig', accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: {
        id: adminUser.id,
        email: adminUser.email,
        display_name: adminUser.display_name,
        title: null,
        phone_number: null,
        status: 'active',
        is_admin: true,
        created_at: '2026-11-20T00:00:00.000Z',
        last_login_at: null,
        last_email_verified_at: null,
        activates_at: null,
        disables_at: null,
        disabled_at: null,
        totp_enabled: false,
        groups: ['admin'],
      },
    });
  });
});
