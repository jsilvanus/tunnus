import { describe, expect, it } from 'vitest';
import express from 'express';
import { main } from '../src/cli/main.js';
import { createAdminRouter } from '../src/admin/router.js';
import { createLocalAdminFetch } from '../src/app.js';
import { hashToken } from '../src/adminTokens.js';

describe('PII-Safe CLI Identity Enforcement', () => {
  const adminUserId = '11111111-1111-4111-8111-111111111111';
  const userAId = '22222222-2222-4222-8222-222222222222';
  const userBId = '33333333-3333-4333-8333-333333333333';

  const tokenPseudoRefId = 'aaaa1111-1111-4111-8111-111111111111';
  const tokenRefOnlyId = 'bbbb2222-2222-4222-8222-222222222222';
  const tokenOpenId = 'cccc3333-3333-4333-8333-333333333333';

  const keySecret = 'test-secret-at-least-32-chars-long-12345';

  const mockUsers = [
    {
      id: adminUserId,
      email: 'admin@riihimaenseurakunta.fi',
      display_name: 'Admin User',
      title: 'Ylläpitäjä',
      phone_number: '+358401111111',
      status: 'active',
      is_admin: true,
      created_at: new Date('2026-01-01T00:00:00Z'),
      last_login_at: null,
      last_email_verified_at: null,
      activates_at: null,
      disables_at: null,
      disabled_at: null,
      totp_enabled: false,
      groups: ['admin'],
    },
    {
      id: userAId,
      email: 'matti.kirkkoherra@evl.fi',
      display_name: 'Matti Kirkkoherra',
      title: 'Kirkkoherra',
      phone_number: '+358402222222',
      status: 'active',
      is_admin: false,
      created_at: new Date('2026-01-01T00:00:00Z'),
      last_login_at: null,
      last_email_verified_at: null,
      activates_at: null,
      disables_at: null,
      disabled_at: null,
      totp_enabled: false,
      groups: ['papit'],
    },
    {
      id: userBId,
      email: 'anna.kanttori@evl.fi',
      display_name: 'Anna Kanttori',
      title: 'Kanttori',
      phone_number: '+358403333333',
      status: 'active',
      is_admin: false,
      created_at: new Date('2026-01-01T00:00:00Z'),
      last_login_at: null,
      last_email_verified_at: null,
      activates_at: null,
      disables_at: null,
      disabled_at: null,
      totp_enabled: false,
      groups: ['kanttorit'],
    },
  ];

  const tokenPseudoRef = `tun_${'p'.repeat(43)}`;
  const tokenRefOnly = `tun_${'r'.repeat(43)}`;
  const tokenOpen = `tun_${'o'.repeat(43)}`;

  const mockAdminTokens = {
    [tokenPseudoRef]: {
      id: tokenPseudoRefId,
      user_id: adminUserId,
      label: 'Agent-PseudoRef',
      mode: 'pseudo_ref',
    },
    [tokenRefOnly]: {
      id: tokenRefOnlyId,
      user_id: adminUserId,
      label: 'Agent-RefOnly',
      mode: 'ref_only',
    },
    [tokenOpen]: {
      id: tokenOpenId,
      user_id: adminUserId,
      label: 'Admin-Open',
      mode: 'open',
    },
  };

  /** @type {Map<string, any>} */
  const mockRefs = new Map();

  function createMockPool() {
    return {
      async query(sql, params = []) {
        // find active admin token
        if (sql.includes('FROM admin_tokens t')) {
          for (const [plain, t] of Object.entries(mockAdminTokens)) {
            const h = hashToken(plain);
            if (params[0] === h) {
              const u = mockUsers.find((user) => user.id === t.user_id);
              return {
                rows: [
                  {
                    id: t.id,
                    user_id: t.user_id,
                    label: t.label,
                    created_at: new Date(),
                    created_by: adminUserId,
                    expires_at: new Date(Date.now() + 86400000),
                    last_used_at: new Date(),
                    revoked_at: null,
                    revoked: false,
                    expired: false,
                    email: u.email,
                    display_name: u.display_name,
                    status: u.status,
                    is_admin: u.is_admin,
                  },
                ],
              };
            }
          }
        }

        // identity settings
        if (sql.includes('FROM mcp_client_settings')) {
          const key = params[2];
          const found = Object.values(mockAdminTokens).find((t) => t.id === key);
          return { rows: found ? [{ identity_mode: found.mode }] : [] };
        }

        // users query
        if (sql.includes('FROM users u') || sql.includes('FROM users WHERE')) {
          if (sql.includes('u.id = $1') || sql.includes('WHERE id = $1')) {
            const u = mockUsers.find((user) => user.id === params[0]);
            return { rows: u ? [u] : [] };
          }
          let rows = [...mockUsers];
          if (params[0] && typeof params[0] === 'string' && params[0] !== 'open') {
            // filter by status or id
          }
          return { rows };
        }

        // pseudonym resolution
        if (sql.includes('FROM mcp_pseudonyms p')) {
          const alias = params[1];
          if (alias === 'kirkkoherra') {
            return {
              rows: [{ id: 'subj-1', tunnus_user_id: userAId, label: 'Kirkkoherra', pseudonym: 'kirkkoherra' }],
            };
          }
          return { rows: [] };
        }

        // subject query / insert
        if (sql.includes('mcp_identity_subjects')) {
          if (params[1] === userAId) return { rows: [{ id: 'subj-1', tunnus_user_id: userAId }] };
          if (params[1] === userBId) return { rows: [{ id: 'subj-2', tunnus_user_id: userBId }] };
          if (params[1] === adminUserId) return { rows: [{ id: 'subj-admin', tunnus_user_id: adminUserId }] };
          return { rows: [] };
        }

        // pseudonym representation (preferred pseudonym)
        if (sql.includes('SELECT pseudonym FROM mcp_pseudonyms')) {
          if (params[1] === 'subj-1' || params[1] === userAId) {
            return { rows: [{ pseudonym: 'kirkkoherra' }] };
          }
          return { rows: [] };
        }

        // create/lookup ref
        if (sql.includes('INSERT INTO mcp_identity_refs')) {
          const handle = params[4];
          const subjectId = params[3];
          mockRefs.set(handle, subjectId);
          return {
            rows: [
              {
                handle,
                subject_id: subjectId,
                expires_at: new Date(Date.now() + 86400000),
                created_at: new Date(),
              },
            ],
          };
        }

        if (sql.includes('FROM mcp_identity_refs r')) {
          if (sql.includes('r.handle = $2')) {
            const handle = params[1];
            const subjectId = mockRefs.get(handle);
            if (subjectId === 'subj-1') return { rows: [{ id: 'subj-1', tunnus_user_id: userAId }] };
            if (subjectId === 'subj-2') return { rows: [{ id: 'subj-2', tunnus_user_id: userBId }] };
            if (handle.startsWith('ref-b')) return { rows: [{ id: 'subj-2', tunnus_user_id: userBId }] };
          }
          if (sql.includes('r.subject_id = $4')) {
            return { rows: [] };
          }
          return { rows: [] };
        }

        // group membership
        if (sql.includes('FROM group_memberships') || sql.includes('INSERT INTO group_memberships')) {
          return { rows: [], rowCount: 1 };
        }

        // audit
        if (sql.includes('INSERT INTO audit')) {
          return { rows: [], rowCount: 1 };
        }

        return { rows: [] };
      },
    };
  }

  function createTestIo(token, outputCollector) {
    const out = [];
    const errText = [];
    return {
      io: {
        env: {
          TUNNUS_URL: 'https://id.example.org',
          TUNNUS_ADMIN_TOKEN: token,
        },
        stdout: {
          write(t) {
            out.push(t);
            outputCollector?.push(t);
          },
        },
        stderr: {
          write(t) {
            errText.push(t);
          },
        },
        isTTY: true,
      },
      out,
      errText,
    };
  }

  function setupAdminFetch(pool) {
    const app = express();
    const router = createAdminRouter({
      config: {
        issuer: 'https://id.example.org',
        keyEncryptionSecret: keySecret,
        adminValidateResponses: false,
      },
      pool,
      reloadKeys: async () => {},
    });
    app.use('/admin/api/v1', router);
    return createLocalAdminFetch(router, 'https://id.example.org/admin/api/v1');
  }

  it('tunnus users list --json in pseudo_ref mode sanitizes direct PII and projects pseudonyms', async () => {
    const pool = createMockPool();
    const fetch = setupAdminFetch(pool);
    const { io, out } = createTestIo(tokenPseudoRef);
    io.fetch = fetch;

    const exitCode = await main(['users', 'list', '--json'], io);
    expect(exitCode).toBe(0);

    const result = JSON.parse(out.join(''));
    expect(result.items).toBeDefined();
    expect(result.items.length).toBeGreaterThanOrEqual(2);

    const userA = result.items.find((u) => u.id === 'pseudo:kirkkoherra');
    expect(userA).toBeDefined();
    expect(userA).not.toHaveProperty('email');
    expect(userA).not.toHaveProperty('display_name');
    expect(userA).not.toHaveProperty('phone_number');
    expect(userA).not.toHaveProperty('title');
    expect(userA.status).toBe('active');

    // Entire output must NOT contain real emails or UUIDs of user A and B
    const fullText = out.join('');
    expect(fullText).not.toContain('matti.kirkkoherra@evl.fi');
    expect(fullText).not.toContain('anna.kanttori@evl.fi');
    expect(fullText).not.toContain(userAId);
    expect(fullText).not.toContain(userBId);
  });

  it('tunnus users list table output in restricted mode suppresses PII columns', async () => {
    const pool = createMockPool();
    const fetch = setupAdminFetch(pool);
    const { io, out } = createTestIo(tokenPseudoRef);
    io.fetch = fetch;

    const exitCode = await main(['users', 'list'], io);
    expect(exitCode).toBe(0);

    const text = out.join('');
    const firstLine = text.split('\n')[0];
    const columns = firstLine.trim().split(/\s{2,}/);
    expect(columns).toContain('id');
    expect(columns).not.toContain('email');
    expect(columns).not.toContain('display_name');
    expect(columns).not.toContain('phone_number');
    expect(text).toContain('pseudo:kirkkoherra');
  });

  it('tunnus users get with pseudo:<alias> resolves and returns sanitized user', async () => {
    const pool = createMockPool();
    const fetch = setupAdminFetch(pool);
    const { io, out } = createTestIo(tokenPseudoRef);
    io.fetch = fetch;

    const exitCode = await main(['users', 'get', 'pseudo:kirkkoherra', '--json'], io);
    expect(exitCode).toBe(0);

    const user = JSON.parse(out.join(''));
    expect(user.id).toBe('pseudo:kirkkoherra');
    expect(user).not.toHaveProperty('email');
    expect(user).not.toHaveProperty('display_name');
    expect(user).not.toHaveProperty('phone_number');
    expect(out.join('')).not.toContain('matti.kirkkoherra@evl.fi');
  });

  it('rejects direct email and name search in restricted mode', async () => {
    const pool = createMockPool();
    const fetch = setupAdminFetch(pool);
    const { io, errText } = createTestIo(tokenPseudoRef);
    io.fetch = fetch;

    const exitCode = await main(['users', 'list', '--email', 'matti@evl.fi'], io);
    expect(exitCode).toBe(1);
    expect(errText.join('')).toContain('Search by direct email or name is disabled in restricted identity mode');
  });

  it('in ref_only mode, pseudonym inputs are rejected and only ref: handles are accepted', async () => {
    const pool = createMockPool();
    const fetch = setupAdminFetch(pool);
    const { io, errText } = createTestIo(tokenRefOnly);
    io.fetch = fetch;

    const badCode = await main(['users', 'get', 'pseudo:kirkkoherra'], io);
    expect(badCode).toBe(1);
    expect(errText.join('')).toContain('Pseudonym inputs are not allowed in ref_only mode');
  });
});
