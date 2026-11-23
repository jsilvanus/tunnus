import { describe, expect, it } from 'vitest';
import { resolveGroup, resolveUser } from '../src/admin/handlerHelpers.js';
import { handlers as groupHandlers } from '../src/admin/handlers/groups.js';
import { handlers as userHandlers } from '../src/admin/handlers/users.js';

describe('natural keys resolution', () => {
  it('resolveGroup finds by id or name', async () => {
    /** @type {any} */
    const db = {
      query: async (/** @type {string} */ sql, /** @type {any[]} */ params) => {
        if (sql.includes('WHERE id = $1')) {
          if (params[0] === 12) return { rows: [{ id: 12, name: 'developers' }] };
          return { rows: [] };
        }
        if (sql.includes('WHERE name = $1')) {
          if (params[0] === 'developers') return { rows: [{ id: 12, name: 'developers' }] };
          return { rows: [] };
        }
        return { rows: [] };
      },
    };

    const byId = await resolveGroup(db, 12);
    expect(byId).toEqual({ id: 12, name: 'developers' });

    const byNumericStr = await resolveGroup(db, '12');
    expect(byNumericStr).toEqual({ id: 12, name: 'developers' });

    const byName = await resolveGroup(db, 'developers');
    expect(byName).toEqual({ id: 12, name: 'developers' });

    await expect(resolveGroup(db, 'nonexistent')).rejects.toThrow('Group not found: nonexistent');
  });

  it('resolveUser finds by UUID or email', async () => {
    /** @type {any} */
    const db = {
      query: async (/** @type {string} */ sql, /** @type {any[]} */ params) => {
        if (sql.includes('WHERE id = $1')) {
          if (params[0] === '6f1b1d0e-3c1e-4c7a-9a52-2f0f5a3c9b11') {
            return {
              rows: [{ id: '6f1b1d0e-3c1e-4c7a-9a52-2f0f5a3c9b11', email: 'alice@example.com' }],
            };
          }
          return { rows: [] };
        }
        if (sql.includes('WHERE email = $1')) {
          if (params[0] === 'alice@example.com') {
            return {
              rows: [{ id: '6f1b1d0e-3c1e-4c7a-9a52-2f0f5a3c9b11', email: 'alice@example.com' }],
            };
          }
          return { rows: [] };
        }
        return { rows: [] };
      },
    };

    const byId = await resolveUser(db, '6f1b1d0e-3c1e-4c7a-9a52-2f0f5a3c9b11');
    expect(byId).toEqual({
      id: '6f1b1d0e-3c1e-4c7a-9a52-2f0f5a3c9b11',
      email: 'alice@example.com',
    });

    const byEmail = await resolveUser(db, 'alice@example.com');
    expect(byEmail).toEqual({
      id: '6f1b1d0e-3c1e-4c7a-9a52-2f0f5a3c9b11',
      email: 'alice@example.com',
    });

    await expect(resolveUser(db, 'nobody@example.com')).rejects.toThrow(
      'User not found: nobody@example.com',
    );
  });
});

describe('composite creation with natural keys', () => {
  it('createGroup with members adds initial users by email or UUID', async () => {
    /** @type {any[]} */
    const insertedMembers = [];
    /** @type {any} */
    const pool = {
      connect: async () => ({
        query: async (/** @type {string} */ sql, /** @type {any[]} */ params) => {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
          if (sql.includes('INSERT INTO groups')) {
            return { rows: [{ id: 42 }] };
          }
          if (sql.includes('SELECT id, email FROM users WHERE email = $1')) {
            if (params[0] === 'alice@example.com')
              return { rows: [{ id: 'u-alice', email: 'alice@example.com' }] };
            return { rows: [] };
          }
          if (sql.includes('SELECT id, email FROM users WHERE id = $1')) {
            if (params[0] === 'u-bob') return { rows: [{ id: 'u-bob', email: 'bob@example.com' }] };
            return { rows: [] };
          }
          if (sql.includes('INSERT INTO user_groups')) {
            insertedMembers.push(params);
            return { rows: [] };
          }
          return { rows: [] };
        },
        release: () => {},
      }),
      query: async (/** @type {string} */ sql, /** @type {any[]} */ params) => {
        if (sql.includes('FROM groups g')) {
          return {
            rows: [
              {
                id: params[0],
                name: 'devs',
                description: 'Dev team',
                member_count: 2,
              },
            ],
          };
        }
        return { rows: [] };
      },
    };

    const ctx = {
      pool,
      config: { defaultGroups: [] },
      actor: { userId: 'admin-1' },
      body: {
        name: 'devs',
        description: 'Dev team',
        members: ['alice@example.com', 'u-bob'],
      },
    };

    const res = await groupHandlers.createGroup(/** @type {any} */ (ctx));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: 42,
      name: 'devs',
      description: 'Dev team',
      is_default: false,
      member_count: 2,
    });
    expect(insertedMembers).toEqual([
      ['u-alice', 42, 'admin-1'],
      ['u-bob', 42, 'admin-1'],
    ]);
  });

  it('grantMembership and revokeMembership support group names and user emails', async () => {
    let granted = null;
    let revoked = null;

    /** @type {any} */
    const pool = {
      query: async (/** @type {string} */ sql, /** @type {any[]} */ params) => {
        if (sql.includes('SELECT id, name FROM groups WHERE name = $1')) {
          if (params[0] === 'devs') return { rows: [{ id: 42, name: 'devs' }] };
          return { rows: [] };
        }
        if (sql.includes('SELECT id, email FROM users WHERE email = $1')) {
          if (params[0] === 'alice@example.com')
            return { rows: [{ id: 'u-alice', email: 'alice@example.com' }] };
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO user_groups')) {
          granted = params;
          return { rows: [{ granted_at: '2026-11-23T11:00:00Z' }] };
        }
        if (sql.includes('DELETE FROM user_groups')) {
          revoked = params;
          return { rowCount: 1 };
        }
        if (sql.includes('FROM user_groups ug')) {
          return {
            rows: [
              {
                user_id: 'u-alice',
                email: 'alice@example.com',
                display_name: 'Alice',
                group_id: 42,
                group_name: 'devs',
                granted_by: 'admin-1',
                granted_at: '2026-11-23T11:00:00Z',
              },
            ],
          };
        }
        return { rows: [] };
      },
    };

    const grantRes = await groupHandlers.grantMembership(
      /** @type {any} */ ({
        pool,
        actor: { userId: 'admin-1' },
        params: { groupId: 'devs', userId: 'alice@example.com' },
      }),
    );
    expect(grantRes.status).toBe(201);
    expect(grantRes.body).toMatchObject({
      user_id: 'u-alice',
      group_id: 42,
      group_name: 'devs',
    });
    expect(granted).toEqual(['u-alice', 42, 'admin-1']);

    const revokeRes = await groupHandlers.revokeMembership(
      /** @type {any} */ ({
        pool,
        actor: { userId: 'admin-1' },
        params: { groupId: 'devs', userId: 'alice@example.com' },
      }),
    );
    expect(revokeRes.status).toBe(204);
    expect(revoked).toEqual(['u-alice', 42]);
  });

  it('createUser with groups adds user to specified groups', async () => {
    /** @type {any[]} */
    const insertedGroups = [];
    /** @type {any} */
    const pool = {
      connect: async () => ({
        query: async (/** @type {string} */ sql, /** @type {any[]} */ params) => {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
          if (sql.includes('INSERT INTO users')) {
            return { rows: [{ id: 'u-charlie' }] };
          }
          if (sql.includes('SELECT id, name FROM groups WHERE name = $1')) {
            if (params[0] === 'devs') return { rows: [{ id: 42, name: 'devs' }] };
            if (params[0] === 'staff') return { rows: [{ id: 88, name: 'staff' }] };
            return { rows: [] };
          }
          if (sql.includes('INSERT INTO user_groups')) {
            insertedGroups.push(params);
            return { rows: [] };
          }
          return { rows: [] };
        },
        release: () => {},
      }),
      query: async (/** @type {string} */ _sql, /** @type {any[]} */ params) => ({
        rows: [
          {
            id: params?.[0] ?? 'u-charlie',
            email: 'charlie@example.com',
            display_name: 'Charlie',
            status: 'active',
            is_admin: false,
            groups: ['default', 'devs', 'staff'],
          },
        ],
      }),
    };

    const ctx = {
      pool,
      config: { defaultGroups: ['default'] },
      actor: { userId: 'admin-1' },
      body: {
        email: 'charlie@example.com',
        groups: ['devs', 'staff'],
      },
    };

    const res = await userHandlers.createUser(/** @type {any} */ (ctx));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      email: 'charlie@example.com',
      groups: ['default', 'devs', 'staff'],
    });
    expect(insertedGroups).toEqual([
      ['u-charlie', 'default'],
      ['u-charlie', 42, 'admin-1'],
      ['u-charlie', 88, 'admin-1'],
    ]);
  });
});
