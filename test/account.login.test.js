import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { accountPage } from '../src/web/pages.js';
import { createAccountRouter } from '../src/web/account.js';
import { encryptWithKey, deriveSubkey, encrypt, generateKey } from '../src/oidc/keys.js';
import { encryptTotpSecret, generateTotpSecret, totpCode } from '../src/totp.js';

const KEY_SECRET = 'test-key-encryption-secret-01234567890123456789';

function makeSessionCookie(/** @type {string} */ userId, sid = 'test-sid') {
  const data = { userId, sid, exp: Date.now() + 60 * 60 * 1000 };
  const sealed = encryptWithKey(JSON.stringify(data), deriveSubkey(KEY_SECRET, 'account-session'));
  return `tunnus_account=${sealed}`;
}

function makeCsrf(sid = 'test-sid') {
  return createHmac('sha256', deriveSubkey(KEY_SECRET, 'account-csrf')).update(sid).digest('hex');
}

/**
 * @param {any} app
 * @param {string} path
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [opts]
 */
async function request(app, path, { method = 'GET', headers = {}, body } = {}) {
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body,
      redirect: 'manual',
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

const mockConfig = {
  issuer: 'http://127.0.0.1',
  basePath: '',
  brand: { name: 'Tunnus', color: '#7e003e' },
  defaultLocale: 'en',
  keyEncryptionSecret: KEY_SECRET,
  totpEmailReverifyDays: 7,
};

describe('accountPage groups rendering', () => {
  const ctx = {
    config: /** @type {any} */ (mockConfig),
    locale: /** @type {const} */ ('en'),
  };

  it('renders groups alphabetically each on a new line when 5 or fewer', () => {
    const html = accountPage(ctx, {
      basePath: '',
      email: 'user@example.org',
      displayName: 'User',
      groups: ['zebra', 'apple', 'mango'],
      totpEnabled: false,
      freshEmail: true,
      csrf: 'csrf-1',
    });
    expect(html).toContain('<div>apple</div><div>mango</div><div>zebra</div>');
    expect(html).not.toContain('<details');
    expect(html).not.toContain('See more');
  });

  it('renders first 5 groups alphabetically and remaining behind a see more toggle when > 5', () => {
    const groups = ['zebra', 'banana', 'apple', 'orange', 'mango', 'grape', 'cherry'];
    const html = accountPage(ctx, {
      basePath: '',
      email: 'user@example.org',
      displayName: 'User',
      groups,
      totpEnabled: false,
      freshEmail: true,
      csrf: 'csrf-1',
    });
    // Alphabetical order: apple, banana, cherry, grape, mango, orange, zebra
    expect(html).toContain(
      '<div>apple</div><div>banana</div><div>cherry</div><div>grape</div><div>mango</div>',
    );
    expect(html).toContain('<details style="margin-top:.3rem">');
    expect(html).toContain(
      '<summary style="cursor:pointer;color:#7e003e;font-size:.9rem">See more (2)</summary>',
    );
    expect(html).toContain('<div style="margin-top:.2rem"><div>orange</div><div>zebra</div></div>');
  });

  it('renders authorized apps list and handles empty list', () => {
    const htmlEmpty = accountPage(ctx, {
      basePath: '',
      email: 'user@example.org',
      displayName: 'User',
      groups: [],
      totpEnabled: false,
      freshEmail: true,
      csrf: 'csrf-1',
      apps: [],
    });
    expect(htmlEmpty).toContain('Authorized applications');
    expect(htmlEmpty).toContain('No authorized applications.');

    const htmlWithApps = accountPage(ctx, {
      basePath: '',
      email: 'user@example.org',
      displayName: 'User',
      groups: [],
      totpEnabled: false,
      freshEmail: true,
      csrf: 'csrf-1',
      apps: [
        {
          clientId: 'chatgpt',
          clientName: 'ChatGPT',
          scopes: ['openid', 'email', 'profile'],
        },
      ],
      appNotice: 'Access revoked for TestApp.',
    });
    expect(htmlWithApps).toContain('Authorized applications');
    expect(htmlWithApps).toContain('ChatGPT');
    expect(htmlWithApps).toContain('chatgpt');
    expect(htmlWithApps).toContain('openid, email, profile');
    expect(htmlWithApps).toContain('Revoke access');
    expect(htmlWithApps).toContain('Access revoked for TestApp.');
  });
});

describe('account login with TOTP support', () => {
  const { raw, base32: secretBase32 } = generateTotpSecret();
  const secretEnc = encryptTotpSecret(secretBase32, KEY_SECRET);
  const userWithTotp = {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'totp-user@example.org',
    status: 'active',
    groups: [],
    totp_secret_enc: secretEnc,
    totp_enabled_at: new Date(),
    totp_last_step: null,
    totp_failed_attempts: 0,
    totp_locked_until: null,
    last_email_verified_at: new Date(),
  };

  function setupApp({ user = userWithTotp, grants = /** @type {any[]} */ ([]) } = {}) {
    const app = express();
    /** @type {any[]} */
    const audits = [];
    /** @type {any[]} */
    const deletedPayloads = [];
    const pool = {
      query: async (/** @type {string} */ sql, /** @type {any[]} */ params) => {
        if (sql.includes('totp_enabled_at, last_email_verified_at FROM users')) {
          return {
            rows: [
              {
                totp_enabled_at: user.totp_enabled_at,
                last_email_verified_at: user.last_email_verified_at,
              },
            ],
          };
        }
        if (sql.includes('FROM users')) {
          if (params?.[0] === user.email || params?.[0] === user.id) return { rows: [user] };
          return { rows: [] };
        }
        if (sql.includes('DELETE FROM oidc_payloads')) {
          deletedPayloads.push(params);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('FROM oidc_payloads')) {
          return { rows: grants };
        }
        if (sql.includes('UPDATE users')) {
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO audit_events')) {
          audits.push(params);
          return { rows: [] };
        }
        if (sql.includes('UPDATE email_codes')) {
          return { rows: [] };
        }
        if (sql.includes("FROM signing_keys WHERE status = 'active'")) {
          const { kid, priv } = generateKey();
          return {
            rows: [
              {
                kid,
                private_jwk: encrypt(JSON.stringify(priv), KEY_SECRET),
              },
            ],
          };
        }
        return { rows: [] };
      },
      connect: async () => ({
        query: async (/** @type {string} */ sql, /** @type {any[]} */ params) => {
          if (sql.includes('FROM users')) {
            if (params?.[0] === user.email || params?.[0] === user.id) return { rows: [user] };
            return { rows: [] };
          }
          if (sql.includes('UPDATE users')) {
            return { rows: [] };
          }
          return { rows: [] };
        },
        release: () => {},
      }),
    };
    app.use(
      createAccountRouter({
        config: /** @type {any} */ (mockConfig),
        pool: /** @type {any} */ (pool),
        getProvider: () => ({
          createContext: () => ({}),
          Session: { get: async () => null },
          Client: {
            find: async (/** @type {string} */ clientId) => {
              if (clientId === 'chatgpt')
                return {
                  clientName: 'ChatGPT',
                  clientId: 'chatgpt',
                  backchannel_logout_uri: 'https://chatgpt.example.org/backchannel-logout',
                };
              if (clientId === 'vuorot')
                return { clientName: 'Vuorot', clientId: 'vuorot', first_party: true };
              return null;
            },
          },
        }),
        mailer: /** @type {any} */ ({ sendCode: async () => {} }),
      }),
    );
    return { app, audits, deletedPayloads };
  }

  it('accepts TOTP code on /account/login/code for user with TOTP', async () => {
    const { app } = setupApp();

    // 1. POST /account/login
    const loginRes = await request(app, '/account/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=totp-user@example.org',
    });
    expect(loginRes.status).toBe(200);
    const cookieHeader = loginRes.headers.get('set-cookie') || '';
    expect(cookieHeader).toContain('tunnus_acct_chal=');

    // 2. Compute current valid TOTP code
    const validCode = totpCode(raw);

    // 3. POST /account/login/code with valid TOTP code
    const chalCookie = cookieHeader.split(';')[0];
    const codeRes = await request(app, '/account/login/code', {
      method: 'POST',
      headers: {
        cookie: chalCookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `code=${validCode}`,
    });

    expect(codeRes.status).toBe(303);
    expect(codeRes.headers.get('location')).toBe('/account');
    const sessionCookie = codeRes.headers.get('set-cookie') || '';
    expect(sessionCookie).toContain('tunnus_account=');
  });

  it('rejects invalid TOTP code on /account/login/code with 400', async () => {
    const { app } = setupApp();

    const loginRes = await request(app, '/account/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=totp-user@example.org',
    });
    const cookieHeader = loginRes.headers.get('set-cookie') || '';
    const chalCookie = cookieHeader.split(';')[0];

    const codeRes = await request(app, '/account/login/code', {
      method: 'POST',
      headers: {
        cookie: chalCookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'code=000000',
    });

    expect(codeRes.status).toBe(400);
    expect(codeRes.text).toContain('That code is not valid.');
    expect(codeRes.text).toContain('/account/login/resend');
  });

  it('renders authorized apps on GET /account omitting internal first-party apps like Vuorot', async () => {
    const grants = [
      {
        id: 'grant-1',
        payload: {
          clientId: 'chatgpt',
          accountId: userWithTotp.id,
          openid: { scope: 'openid mcp' },
          resources: ['https://ptv.example.org/mcp'],
          iat: Math.floor(Date.now() / 1000),
        },
        expires_at: new Date(Date.now() + 100000),
      },
      {
        id: 'grant-2',
        payload: {
          clientId: 'vuorot',
          accountId: userWithTotp.id,
          openid: { scope: 'openid email profile' },
          iat: Math.floor(Date.now() / 1000),
        },
        expires_at: new Date(Date.now() + 100000),
      },
    ];
    const { app } = setupApp({ grants });
    const cookie = makeSessionCookie(userWithTotp.id);
    const res = await request(app, '/account', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Authorized applications');
    expect(res.text).toContain('ChatGPT');
    expect(res.text).toContain('MCP');
    expect(res.text).toContain('openid, mcp');
    expect(res.text).toContain('Resources:');
    expect(res.text).toContain('https://ptv.example.org/mcp');
    expect(res.text).toContain('Revoke access');
    // First-party app Vuorot should be omitted
    expect(res.text).not.toContain('Vuorot');
  });

  it('revokes app access on POST /account/apps/revoke and dispatches backchannel logout', async () => {
    const originalFetch = globalThis.fetch;
    /** @type {any} */
    let dispatchedCall = null;
    globalThis.fetch = vi.fn(async (url, init) => {
      if (typeof url === 'string' && url.includes('127.0.0.1')) {
        return originalFetch(url, init);
      }
      dispatchedCall = { url, init };
      return new Response('OK', { status: 200 });
    });

    try {
      const { app, deletedPayloads, audits } = setupApp();
      const cookie = makeSessionCookie(userWithTotp.id);
      const csrf = makeCsrf();

      const res = await request(app, '/account/apps/revoke', {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: `csrf=${csrf}&clientId=chatgpt`,
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('app_notice=');
      expect(deletedPayloads).toHaveLength(1);
      expect(deletedPayloads[0]).toEqual([userWithTotp.id, 'chatgpt']);
      expect(audits.some((a) => a[1] === 'account_app_revoked')).toBe(true);

      // Give async backchannel task a tick to complete
      await new Promise((r) => setTimeout(r, 50));
      expect(dispatchedCall).not.toBeNull();
      expect(dispatchedCall.url).toBe('https://chatgpt.example.org/backchannel-logout');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
