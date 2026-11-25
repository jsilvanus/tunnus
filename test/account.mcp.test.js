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

  it('isolates MCP state per user on /account', async () => {
    const userA = '00000000-0000-0000-0000-000000000001';
    const userB = '00000000-0000-0000-0000-000000000002';
    const app = express();
    const pool = {
      query: async (/** @type {string} */ sql, /** @type {any[]} */ params) => {
        if (sql.includes('FROM users u')) {
          const id = params[0];
          return {
            rows: [
              {
                id,
                email: id === userA ? 'a@example.org' : 'b@example.org',
                display_name: id === userA ? 'User A' : 'User B',
                status: 'active',
                groups: ['admin'],
              },
            ],
          };
        }
        if (sql.includes('totp_enabled_at, last_email_verified_at FROM users')) {
          return { rows: [{ totp_enabled_at: null, last_email_verified_at: new Date() }] };
        }
        if (sql.includes('mcp_state')) {
          const targetUser = params?.[0];
          if (targetUser === userA) {
            return {
              rows: [
                {
                  user_id: userA,
                  fixed_time_until: null,
                  list_locked: false,
                  commit_list: [{ id: 'c-a', operationId: 'deleteUser', command: 'users delete' }],
                  updated_at: new Date(),
                },
              ],
            };
          }
          return {
            rows: [
              {
                user_id: userB,
                fixed_time_until: null,
                list_locked: false,
                commit_list: [],
                updated_at: new Date(),
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    app.use(
      createAccountRouter({
        config: /** @type {any} */ (mockConfig),
        pool: /** @type {any} */ (pool),
        getProvider: () => ({ createContext: () => ({}), Session: { get: async () => null } }),
        mailer: /** @type {any} */ ({}),
      }),
    );

    const resA = await request(app, '/account', {
      headers: { cookie: makeSessionCookie(userA) },
    });
    expect(resA.text).toContain('users delete');

    const resB = await request(app, '/account', {
      headers: { cookie: makeSessionCookie(userB) },
    });
    expect(resB.text).not.toContain('users delete');
    expect(resB.text).toContain('No pending actions in commit list.');
  });

  describe('admin user search and group management on /account', () => {
    const adminId = '00000000-0000-0000-0000-000000000001';
    const regularId = '00000000-0000-0000-0000-000000000002';
    const targetUserId = '00000000-0000-0000-0000-000000000003';

    function createAdminApp(groupsState = ['papit']) {
      const app = express();
      const pool = {
        query: async (/** @type {string} */ sql, /** @type {any[]} */ params = []) => {
          if (sql.includes('FROM users u')) {
            const id = params[0];
            const isAdmin = id === adminId;
            return {
              rows: [
                {
                  id,
                  email: isAdmin ? 'admin@example.org' : 'user@example.org',
                  display_name: isAdmin ? 'Admin' : 'Regular User',
                  status: 'active',
                  groups: isAdmin ? ['admin'] : [],
                  is_admin: isAdmin,
                },
              ],
            };
          }
          if (sql.includes('totp_enabled_at, last_email_verified_at FROM users')) {
            return { rows: [{ totp_enabled_at: null, last_email_verified_at: new Date() }] };
          }
          if (sql.includes('mcp_state')) {
            return { rows: [] };
          }
          if (sql.includes('SELECT id, email, display_name FROM users WHERE status =')) {
            return {
              rows: [
                { id: targetUserId, email: 'target@example.org', display_name: 'Target User' },
              ],
            };
          }
          if (sql.includes('SELECT id, name FROM groups ORDER BY name')) {
            return {
              rows: [
                { id: 10, name: 'papit' },
                { id: 20, name: 'kanttorit' },
              ],
            };
          }
          if (sql.includes('SELECT id, email, display_name FROM users WHERE email = $1 OR id::text = $1 OR display_name ILIKE $2')) {
            return {
              rows: [
                { id: targetUserId, email: 'target@example.org', display_name: 'Target User' },
              ],
            };
          }
          if (sql.includes('SELECT g.id, g.name FROM user_groups ug JOIN groups g')) {
            return {
              rows: groupsState.map((name, idx) => ({ id: idx + 1, name })),
            };
          }
          if (sql.includes('SELECT id, email FROM users WHERE id = $1')) {
            return { rows: [{ id: targetUserId, email: 'target@example.org' }] };
          }
          if (sql.includes('INSERT INTO groups')) {
            return { rows: [{ id: 99, name: params[0] }] };
          }
          if (sql.includes('INSERT INTO user_groups')) {
            groupsState.push(params[1] === 99 ? 'uusi-ryhma' : 'kanttorit');
            return { rowCount: 1 };
          }
          if (sql.includes('SELECT id FROM groups WHERE name = $1')) {
            return { rows: [{ id: 10, name: params[0] }] };
          }
          if (sql.includes('DELETE FROM user_groups')) {
            const idx = groupsState.indexOf('papit');
            if (idx >= 0) groupsState.splice(idx, 1);
            return { rowCount: 1 };
          }
          if (sql.includes('INSERT INTO audit')) {
            return { rowCount: 1 };
          }
          return { rows: [] };
        },
      };
      app.use(
        createAccountRouter({
          config: /** @type {any} */ (mockConfig),
          pool: /** @type {any} */ (pool),
          getProvider: () => ({ createContext: () => ({}), Session: { get: async () => null } }),
          mailer: /** @type {any} */ ({}),
        }),
      );
      return { app, groupsState };
    }

    it('renders admin user search and datalist for admin on /account', async () => {
      const { app } = createAdminApp();
      const res = await request(app, '/account', {
        headers: { cookie: makeSessionCookie(adminId) },
      });
      expect(res.status).toBe(200);
      expect(res.text).toContain('Manage Users');
      expect(res.text).toContain('id="admin-users-datalist"');
      expect(res.text).toContain('target@example.org');
    });

    it('shows selected user details, groups with delete buttons, and add group form', async () => {
      const { app } = createAdminApp(['papit']);
      const res = await request(app, '/account?user_search=target@example.org', {
        headers: { cookie: makeSessionCookie(adminId) },
      });
      expect(res.status).toBe(200);
      expect(res.text).toContain('Target User');
      expect(res.text).toContain('<code>papit</code>');
      expect(res.text).toContain('action="/account/admin/groups/remove"');
      expect(res.text).toContain('action="/account/admin/groups/add"');
    });

    it('adds a group via POST /account/admin/groups/add and removes via /account/admin/groups/remove', async () => {
      const { app } = createAdminApp(['papit']);
      const csrf = makeCsrf();

      const addRes = await request(app, '/account/admin/groups/add', {
        method: 'POST',
        headers: {
          cookie: makeSessionCookie(adminId),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: `csrf=${csrf}&userId=${targetUserId}&groupName=kanttorit&userSearch=target@example.org`,
      });
      expect(addRes.status).toBe(302);
      expect(addRes.headers.get('location')).toContain('admin_notice=Added%20to%20group%20kanttorit');

      const removeRes = await request(app, '/account/admin/groups/remove', {
        method: 'POST',
        headers: {
          cookie: makeSessionCookie(adminId),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: `csrf=${csrf}&userId=${targetUserId}&groupName=papit&userSearch=target@example.org`,
      });
      expect(removeRes.status).toBe(302);
      expect(removeRes.headers.get('location')).toContain('admin_notice=Removed%20from%20group%20papit');
    });

    it('forbids non-admin users from group operations', async () => {
      const { app } = createAdminApp();
      const csrf = makeCsrf();
      const res = await request(app, '/account/admin/groups/add', {
        method: 'POST',
        headers: {
          cookie: makeSessionCookie(regularId),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: `csrf=${csrf}&userId=${targetUserId}&groupName=test`,
      });
      expect(res.status).toBe(403);
    });
  });
});
