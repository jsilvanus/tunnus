import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createLogoutToken, dispatchBackchannelLogout } from '../src/oidc/backchannel.js';
import { encrypt, generateKey } from '../src/oidc/keys.js';
import { createProvider, createResourceServerInfoResolver } from '../src/oidc/provider.js';

const KEY_SECRET = 'test-key-encryption-secret-01234567890123456789';

describe('createLogoutToken', () => {
  const { priv, pub } = generateKey();
  const config = /** @type {any} */ ({ issuer: 'https://id.example.org' });

  it('builds a valid RS256 JWT verifiable with the public key', () => {
    const token = createLogoutToken({
      config,
      activeKey: priv,
      userId: 'user-123',
      clientId: 'client-abc',
    });

    const parts = token.split('.');
    expect(parts).toHaveLength(3);

    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));

    expect(header).toEqual({
      alg: 'RS256',
      typ: 'JWT',
      kid: priv.kid,
    });

    expect(payload.iss).toBe('https://id.example.org');
    expect(payload.sub).toBe('user-123');
    expect(payload.aud).toBe('client-abc');
    expect(payload.jti).toBeDefined();
    expect(typeof payload.iat).toBe('number');
    expect(payload.events).toEqual({
      'http://schemas.openid.net/event/backchannel-logout': {},
      'https://tunnus.fi/event/mcp-revoke': {},
    });

    // Verify signature
    const publicKey = createPublicKey({ key: pub, format: 'jwk' });
    const signingInput = `${parts[0]}.${parts[1]}`;
    const isValid = verify(
      'sha256',
      Buffer.from(signingInput),
      publicKey,
      Buffer.from(parts[2], 'base64url'),
    );
    expect(isValid).toBe(true);
  });

  it('preserves custom events object when supplied', () => {
    const customEvents = {
      'https://tunnus.fi/event/mcp-revoke': { clientId: 'client-abc', reason: 'user_revoked' },
    };
    const token = createLogoutToken({
      config,
      activeKey: priv,
      userId: 'user-123',
      clientId: 'client-abc',
      events: customEvents,
    });

    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.events).toEqual(customEvents);
  });
});

describe('dispatchBackchannelLogout', () => {
  const { kid, priv } = generateKey();
  const config = /** @type {any} */ ({
    issuer: 'https://id.example.org',
    keyEncryptionSecret: KEY_SECRET,
  });

  function createMockPool() {
    /** @type {any[]} */
    const audits = [];
    const pool = {
      audits,
      query: async (/** @type {string} */ sql, /** @type {any[]} */ params) => {
        if (sql.includes("FROM signing_keys WHERE status = 'active'")) {
          return {
            rows: [
              {
                kid,
                private_jwk: encrypt(JSON.stringify(priv), KEY_SECRET),
              },
            ],
          };
        }
        if (sql.includes('INSERT INTO audit_events')) {
          audits.push(params);
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    return pool;
  }

  it('dispatches logout_token via POST to backchannel_logout_uri and audits success', async () => {
    const pool = createMockPool();
    /** @type {any} */
    let fetchCall = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      fetchCall = { url, init };
      return new Response('OK', { status: 200 });
    });

    try {
      const getProvider = () => ({
        Client: {
          find: async (/** @type {string} */ id) => ({
            clientId: id,
            backchannel_logout_uri: 'https://downstream.example.org/logout',
          }),
        },
      });

      const res = await dispatchBackchannelLogout({
        config,
        pool: /** @type {any} */ (pool),
        getProvider,
        userId: 'user-999',
        clientId: 'downstream-app',
      });

      expect(res.dispatched).toBe(true);
      expect(res.status).toBe(200);
      expect(fetchCall).not.toBeNull();
      expect(fetchCall.url).toBe('https://downstream.example.org/logout');
      expect(fetchCall.init.method).toBe('POST');
      expect(fetchCall.init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

      const bodyParams = new URLSearchParams(fetchCall.init.body);
      const token = bodyParams.get('logout_token');
      expect(token).toBeDefined();

      const payload = JSON.parse(
        Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'),
      );
      expect(payload.sub).toBe('user-999');
      expect(payload.aud).toBe('downstream-app');

      expect(pool.audits).toHaveLength(1);
      expect(pool.audits[0][1]).toBe('backchannel_logout.dispatched');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('handles HTTP error responses gracefully without throwing', async () => {
    const pool = createMockPool();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('Internal Server Error', { status: 500 }));

    try {
      const getProvider = () => ({
        Client: {
          find: async (/** @type {string} */ id) => ({
            clientId: id,
            backchannelLogoutUri: 'https://downstream.example.org/logout',
          }),
        },
      });

      const res = await dispatchBackchannelLogout({
        config,
        pool: /** @type {any} */ (pool),
        getProvider,
        userId: 'user-999',
        clientId: 'downstream-app',
      });

      expect(res.dispatched).toBe(false);
      expect(res.status).toBe(500);
      expect(pool.audits).toHaveLength(1);
      expect(pool.audits[0][1]).toBe('backchannel_logout.failed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('handles network / timeout errors gracefully without throwing', async () => {
    const pool = createMockPool();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error('Connection refused');
    });

    try {
      const getProvider = () => ({
        Client: {
          find: async (/** @type {string} */ id) => ({
            clientId: id,
            backchannel_logout_uri: 'https://downstream.example.org/logout',
          }),
        },
      });

      const res = await dispatchBackchannelLogout({
        config,
        pool: /** @type {any} */ (pool),
        getProvider,
        userId: 'user-999',
        clientId: 'downstream-app',
      });

      expect(res.dispatched).toBe(false);
      expect(res.error).toBe('Error');
      expect(pool.audits).toHaveLength(1);
      expect(pool.audits[0][1]).toBe('backchannel_logout.failed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does nothing if client has no backchannel_logout_uri', async () => {
    const pool = createMockPool();
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy;

    try {
      const getProvider = () => ({
        Client: {
          find: async (/** @type {string} */ id) => ({
            clientId: id,
          }),
        },
      });

      const res = await dispatchBackchannelLogout({
        config,
        pool: /** @type {any} */ (pool),
        getProvider,
        userId: 'user-999',
        clientId: 'downstream-app',
      });

      expect(res.dispatched).toBe(false);
      expect(res.error).toBe('no_backchannel_logout_uri');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(pool.audits).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('multi-resource indicator support in provider', () => {
  const { priv } = generateKey();
  const config = /** @type {any} */ ({
    issuer: 'https://id.example.org',
    basePath: '',
    cookieSecrets: ['cookie-secret-01234567890123456789'],
    sessionTtlDays: 14,
    defaultLocale: 'en',
    allowedResourceOrigins: ['https://allowed-origin.example.org'],
    mcp: {
      oauthEnabled: true,
      resourceUrl: 'https://id.example.org/mcp',
    },
  });

  const clients = [
    {
      client_id: 'client-with-allowed-resources',
      client_secret: 'secret',
      redirect_uris: ['https://client.example.org/cb'],
      allowed_resources: ['https://downstream.example.org/mcp'],
    },
    {
      client_id: 'first-party-client',
      client_secret: 'secret',
      redirect_uris: ['https://firstparty.example.org/cb'],
      first_party: true,
    },
    {
      client_id: 'regular-client',
      client_secret: 'secret',
      redirect_uris: ['https://regular.example.org/cb'],
    },
  ];

  const pool = /** @type {any} */ ({
    query: async () => ({ rows: [] }),
  });

  it('configures resourceIndicators with multi-resource validation', async () => {
    const provider = createProvider({
      config,
      pool,
      clients,
      jwks: { keys: [priv] },
    });
    expect(provider).toBeDefined();

    const getResourceServerInfo = createResourceServerInfoResolver({ config, clients });
    expect(getResourceServerInfo).toBeDefined();

    // 1. Matches default config.mcp.resourceUrl
    const defaultInfo = await getResourceServerInfo({}, 'https://id.example.org/mcp', null);
    expect(defaultInfo).toMatchObject({
      scope: 'mcp',
      audience: 'https://id.example.org/mcp',
      accessTokenTTL: 3600,
      accessTokenFormat: 'jwt',
    });

    // 2. Matches client's allowed_resources
    const clientAllowed = {
      clientId: 'client-with-allowed-resources',
      allowed_resources: ['https://downstream.example.org/mcp'],
    };
    const allowedInfo = await getResourceServerInfo(
      {},
      'https://downstream.example.org/mcp',
      clientAllowed,
    );
    expect(allowedInfo).toMatchObject({
      scope: 'mcp',
      audience: 'https://downstream.example.org/mcp',
    });

    // 3. First party matching config.allowedResourceOrigins
    const firstPartyClient = { clientId: 'first-party-client', first_party: true };
    const originInfo = await getResourceServerInfo(
      {},
      'https://allowed-origin.example.org/api/mcp',
      firstPartyClient,
    );
    expect(originInfo).toMatchObject({
      scope: 'mcp',
      audience: 'https://allowed-origin.example.org/api/mcp',
    });

    // 4. First party matching registered redirect URI origin
    const redirectOriginInfo = await getResourceServerInfo(
      {},
      'https://firstparty.example.org/mcp',
      firstPartyClient,
    );
    expect(redirectOriginInfo).toMatchObject({
      scope: 'mcp',
      audience: 'https://firstparty.example.org/mcp',
    });

    // 5. Disallowed resource indicator returns undefined
    const disallowed = await getResourceServerInfo({}, 'https://malicious.example.org/mcp', {
      clientId: 'regular-client',
    });
    expect(disallowed).toBeUndefined();
  });
});

describe('defaultResourceUriFor', () => {
  it('picks the first URI in allowed_resources or synthesizes one for bare identifiers', async () => {
    const { defaultResourceUriFor } = await import('../src/oidc/provider.js');
    const clientsList = [
      {
        client_id: 'canva',
        allowed_resources: ['pigateway', 'https://kehitys.riihimaenseurakunta.fi/sissi'],
      },
      {
        client_id: 'bare-only',
        allowed_resources: ['pigateway'],
      },
      {
        client_id: 'plain-oidc',
      },
    ];
    expect(
      defaultResourceUriFor({ clientId: 'canva' }, clientsList, 'https://id.example.org/identity'),
    ).toBe('https://kehitys.riihimaenseurakunta.fi/sissi');
    expect(
      defaultResourceUriFor(
        { clientId: 'bare-only' },
        clientsList,
        'https://id.example.org/identity',
      ),
    ).toBe('https://id.example.org/identity/resource/bare-only');
    expect(
      defaultResourceUriFor(
        { clientId: 'plain-oidc' },
        clientsList,
        'https://id.example.org/identity',
      ),
    ).toBeUndefined();
  });
});
