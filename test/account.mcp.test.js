import { describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { once } from 'node:events';
import { accountPage } from '../src/web/pages.js';
import { createAccountRouter } from '../src/web/account.js';
import { encryptWithKey, deriveSubkey } from '../src/oidc/keys.js';
import { createHmac } from 'node:crypto';

const KEY_SECRET = 'test-key-encryption-secret-01234567890123456789';

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

function makeSessionCookie(/** @type {string} */ userId) {
  const data = { userId, sid: 'test-sid', exp: Date.now() + 60 * 60 * 1000 };
  const sealed = encryptWithKey(JSON.stringify(data), deriveSubkey(KEY_SECRET, 'account-session'));
  return `tunnus_account=${sealed}`;
}

function makeCsrf(sid = 'test-sid') {
  return createHmac('sha256', deriveSubkey(KEY_SECRET, 'account-csrf')).update(sid).digest('hex');
}

const mockConfig = {
  issuer: 'http://127.0.0.1',
  basePath: '',
  brand: { name: 'Tunnus', color: '#7e003e' },
  defaultLocale: 'en',
  keyEncryptionSecret: KEY_SECRET,
};

describe('accountPage rendering', () => {
  const ctx = {
    config: /** @type {any} */ (mockConfig),
    locale: /** @type {const} */ ('en'),
  };

  it('does not render MCP section when mcp is null (non-admin)', () => {
    const html = accountPage(ctx, {
      basePath: '',
      email: 'user@example.org',
      displayName: 'Normal User',
      groups: [],
      totpEnabled: false,
      freshEmail: true,
      csrf: 'csrf-1',
      mcp: null,
    });
    expect(html).not.toContain('MCP Mutative Actions');
    expect(html).toContain('Normal User');
  });

  it('renders MCP section with status badges and staged items for admin', () => {
    const html = accountPage(ctx, {
      basePath: '',
      email: 'admin@example.org',
      displayName: 'Admin User',
      groups: ['admin'],
      totpEnabled: true,
      freshEmail: true,
      csrf: 'csrf-1',
      mcp: {
        fixedTimeRunning: false,
        remainingMinutes: 0,
        listLocked: false,
        commitList: [
          {
            id: 'c-1',
            operationId: 'deleteUser',
            command: 'users delete',
            summary: 'Delete user',
            method: 'delete',
            path: '/users/123',
            params: { id: '123' },
            stagedAt: '2026-11-21T12:00:00Z',
          },
        ],
      },
    });
    expect(html).toContain('MCP Mutative Actions');
    expect(html).toContain('15-minute direct execution window');
    expect(html).toContain('Inactive');
    expect(html).toContain('Allow for 15 minutes');
    expect(html).toContain('Unlocked');
    expect(html).toContain('Destructive');
    expect(html).toContain('users delete');
    expect(html).toContain('Lock the list before committing');
  });

  it('renders enabled commit button when list is locked', () => {
    const html = accountPage(ctx, {
      basePath: '',
      email: 'admin@example.org',
      displayName: 'Admin User',
      groups: ['admin'],
      totpEnabled: true,
      freshEmail: true,
      csrf: 'csrf-1',
      mcp: {
        fixedTimeRunning: true,
        remainingMinutes: 12,
        listLocked: true,
        commitList: [
          {
            id: 'c-1',
            operationId: 'createGroup',
            command: 'groups create',
            summary: 'Create group',
            method: 'post',
            path: '/groups',
            params: {},
            body: { name: 'devs' },
            stagedAt: '2026-11-21T12:00:00Z',
          },
        ],
      },
    });
    expect(html).toContain('Active (12 min)');
    expect(html).toContain('Cancel lease');
    expect(html).toContain('Locked');
    expect(html).toContain('Unlock list');
    expect(html).toContain('Commit actions (1)');
    expect(html).not.toContain('Lock the list before committing');
  });
});

describe('createAccountRouter MCP endpoints', () => {
  function setupApp({
    isAdmin = true,
    mcpState = /** @type {any} */ ({ fixed_time_until: null, list_locked: false, commit_list: [] }),
  } = {}) {
    const app = express();
    const adminUser = {
      id: '00000000-0000-0000-0000-000000000001',
      email: isAdmin ? 'admin@example.org' : 'user@example.org',
      display_name: 'Test',
      status: 'active',
      groups: isAdmin ? ['admin'] : [],
    };
    const pool = {
      query: async (/** @type {string} */ sql) => {
        if (sql.includes('FROM users u')) {
          return {
            rows: [adminUser],
          };
        }
        if (sql.includes('totp_enabled_at, last_email_verified_at FROM users')) {
          return {
            rows: [{ totp_enabled_at: null, last_email_verified_at: new Date() }],
          };
        }
        if (sql.includes('mcp_state')) {
          return { rows: [{ ...mcpState, updated_at: new Date() }] };
        }
        if (sql.includes('INSERT INTO audit_events')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
      connect: async () => ({
        query: async (/** @type {string} */ sql) => {
          if (sql.includes('mcp_state')) {
            return { rows: [{ ...mcpState, updated_at: new Date() }] };
          }
          return { rows: [] };
        },
        release: () => {},
      }),
    };

    let executedCall = false;
    const callAdminApi = async () => {
      executedCall = true;
      return { status: 200, body: {} };
    };
    const opsById = new Map([['createUser', { operationId: 'createUser' }]]);

    app.use(
      createAccountRouter({
        config: /** @type {any} */ (mockConfig),
        pool: /** @type {any} */ (pool),
        getProvider: () => ({ createContext: () => ({}), Session: { get: async () => null } }),
        mailer: /** @type {any} */ ({}),
        callAdminApi,
        opsById,
      }),
    );
    return { app, pool, getExecuted: () => executedCall };
  }

  it('rejects non-admin users from MCP endpoints with 403', async () => {
    const { app } = setupApp({ isAdmin: false });
    const cookie = makeSessionCookie('00000000-0000-0000-0000-000000000002');
    const csrf = makeCsrf();

    const res1 = await request(app, '/account/mcp/lease', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `csrf=${csrf}&action=enable`,
    });
    expect(res1.status).toBe(403);

    const res2 = await request(app, '/account/mcp/lock', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `csrf=${csrf}&locked=true`,
    });
    expect(res2.status).toBe(403);
  });

  it('allows admin to enable and cancel 15-minute lease', async () => {
    const { app } = setupApp({ isAdmin: true });
    const cookie = makeSessionCookie('00000000-0000-0000-0000-000000000001');
    const csrf = makeCsrf();

    const res = await request(app, '/account/mcp/lease', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `csrf=${csrf}&action=enable`,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('mcp_notice=15-minute');
  });

  it('allows admin to toggle list lock', async () => {
    const { app } = setupApp({ isAdmin: true });
    const cookie = makeSessionCookie('00000000-0000-0000-0000-000000000001');
    const csrf = makeCsrf();

    const res = await request(app, '/account/mcp/lock', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `csrf=${csrf}&locked=true`,
    });
    expect(res.status).toBe(302);
  });

  it('refuses to commit if list is not locked', async () => {
    const { app } = setupApp({
      isAdmin: true,
      mcpState: {
        fixed_time_until: null,
        list_locked: false,
        commit_list: [{ id: 'c-1', operationId: 'createUser' }],
      },
    });
    const cookie = makeSessionCookie('00000000-0000-0000-0000-000000000001');
    const csrf = makeCsrf();

    const res = await request(app, '/account/mcp/commit', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `csrf=${csrf}`,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('mcp_error=Commit%20list%20must%20be%20locked');
  });

  it('commits staged actions when list is locked', async () => {
    const { app, getExecuted } = setupApp({
      isAdmin: true,
      mcpState: {
        fixed_time_until: null,
        list_locked: true,
        commit_list: [
          {
            id: 'c-1',
            operationId: 'createUser',
            command: 'users create',
            params: {},
            body: { email: 'dev@example.org' },
          },
        ],
      },
    });
    const cookie = makeSessionCookie('00000000-0000-0000-0000-000000000001');
    const csrf = makeCsrf();

    const res = await request(app, '/account/mcp/commit', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `csrf=${csrf}`,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain(
      'mcp_notice=Successfully%20executed%201%20action',
    );
    expect(getExecuted()).toBe(true);
  });
});
