import { describe, expect, it } from 'vitest';
import {
  clearDbMcpCommitList,
  executeDbMcpCommitList,
  getDbMcpState,
  setDbMcpFixedTime,
  setDbMcpLock,
  stageDbMcpAction,
} from '../src/mcp/dbState.js';

const USER_A = '00000000-0000-0000-0000-000000000001';
const USER_B = '00000000-0000-0000-0000-000000000002';

describe('mcp dbState (user-scoped)', () => {
  it('loads default state when table is empty and inserts default row for user', async () => {
    let insertedUser = null;
    const pool = {
      query: async (/** @type {string} */ sql, /** @type {any[]} */ params) => {
        if (sql.includes('SELECT')) return { rows: [] };
        if (sql.includes('INSERT INTO mcp_state')) {
          insertedUser = params[0];
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    const state = await getDbMcpState(/** @type {any} */ (pool), USER_A);
    expect(insertedUser).toBe(USER_A);
    expect(state.listLocked).toBe(false);
    expect(state.fixedTimeUntil).toBe(null);
    expect(state.commitList).toEqual([]);
  });

  it('reads existing state for specific user', async () => {
    const fakeRow = {
      user_id: USER_A,
      fixed_time_until: new Date('2026-11-21T12:00:00Z'),
      list_locked: true,
      commit_list: [
        {
          id: 'c-1',
          operationId: 'createUser',
          command: 'users create',
          summary: 'Create user',
          method: 'post',
          path: '/users',
          params: {},
          body: { email: 'a@example.com' },
          stagedAt: '2026-11-21T11:50:00Z',
          stagedBy: { userId: USER_A, email: 'a@example.com' },
        },
      ],
      updated_at: new Date('2026-11-21T11:50:00Z'),
    };
    const pool = {
      query: async (/** @type {string} */ _sql, /** @type {any[]} */ params) => {
        if (params?.[0] === USER_A) return { rows: [fakeRow] };
        return { rows: [] };
      },
    };
    const stateA = await getDbMcpState(/** @type {any} */ (pool), USER_A);
    expect(stateA.listLocked).toBe(true);
    expect(stateA.fixedTimeUntil).toBe('2026-11-21T12:00:00.000Z');
    expect(stateA.commitList).toHaveLength(1);
    expect(stateA.commitList[0].id).toBe('c-1');
    expect(stateA.commitList[0].stagedBy?.userId).toBe(USER_A);
  });

  it('sets and cancels fixed time lease for user', async () => {
    let updatedUntil = undefined;
    let updatedUser = undefined;
    const pool = {
      query: async (/** @type {string} */ _sql, /** @type {any[]} */ params) => {
        updatedUser = params[0];
        updatedUntil = params[1];
        return {
          rows: [
            {
              user_id: updatedUser,
              fixed_time_until: updatedUntil,
              list_locked: false,
              commit_list: [],
              updated_at: new Date(),
            },
          ],
        };
      },
    };
    const res1 = await setDbMcpFixedTime(/** @type {any} */ (pool), {
      minutes: 15,
      userId: USER_A,
    });
    expect(res1.fixedTimeUntil).toBeTruthy();
    expect(new Date(res1.fixedTimeUntil || '').getTime()).toBeGreaterThan(Date.now());
    expect(updatedUser).toBe(USER_A);

    const res2 = await setDbMcpFixedTime(/** @type {any} */ (pool), {
      minutes: 0,
      userId: USER_A,
    });
    expect(res2.fixedTimeUntil).toBe(null);
  });

  it('toggles list lock for user', async () => {
    let lockedVal = undefined;
    let targetUser = undefined;
    const pool = {
      query: async (/** @type {string} */ _sql, /** @type {any[]} */ params) => {
        targetUser = params[0];
        lockedVal = params[1];
        return {
          rows: [
            {
              user_id: targetUser,
              fixed_time_until: null,
              list_locked: lockedVal,
              commit_list: [],
              updated_at: new Date(),
            },
          ],
        };
      },
    };
    const r1 = await setDbMcpLock(/** @type {any} */ (pool), { locked: true, userId: USER_A });
    expect(r1.listLocked).toBe(true);
    expect(targetUser).toBe(USER_A);

    const r2 = await setDbMcpLock(/** @type {any} */ (pool), { locked: false, userId: USER_A });
    expect(r2.listLocked).toBe(false);
  });

  it('stages actions atomically when unlocked and records actor', async () => {
    let currentLocked = false;
    /** @type {any[]} */
    const list = [];
    const pool = {
      query: async (/** @type {string} */ sql, /** @type {any[]} */ params) => {
        if (sql.includes('commit_list = commit_list ||')) {
          if (currentLocked) return { rows: [] }; // WHERE list_locked = false matched nothing
          const newItem = JSON.parse(params[0])[0];
          list.push(newItem);
          return { rows: [{ user_id: params[1] }] };
        }
        return { rows: [] };
      },
    };

    const action1 = {
      operationId: 'createUser',
      command: 'users create',
      summary: 'Create user',
      method: 'post',
      path: '/users',
      params: {},
      body: { email: 'test@example.org' },
    };

    const actor = { userId: USER_A, email: 'admin@example.org', label: 'admin-key' };
    const s1 = await stageDbMcpAction(/** @type {any} */ (pool), {
      userId: USER_A,
      action: action1,
      actor,
    });
    expect(s1.ok).toBe(true);
    expect(list).toHaveLength(1);
    expect(list[0].stagedBy).toEqual(actor);

    // Lock the list
    currentLocked = true;
    const s2 = await stageDbMcpAction(/** @type {any} */ (pool), {
      userId: USER_A,
      action: action1,
      actor,
    });
    expect(s2.ok).toBe(false);
    if (!s2.ok) {
      expect(s2.reason).toBe('locked');
    }
    expect(list).toHaveLength(1);
  });

  it('clears commit list in database for specific user', async () => {
    let clearedUser = null;
    const pool = {
      query: async (/** @type {string} */ sql, /** @type {any[]} */ params) => {
        if (sql.includes("commit_list = '[]'::jsonb")) {
          clearedUser = params[0];
        }
        return { rows: [] };
      },
    };
    await clearDbMcpCommitList(/** @type {any} */ (pool), { userId: USER_A });
    expect(clearedUser).toBe(USER_A);
  });

  it('refuses to execute commit list when list is not locked', async () => {
    const client = {
      query: async (/** @type {string} */ sql) => {
        if (sql.includes('SELECT list_locked, commit_list')) {
          return { rows: [{ list_locked: false, commit_list: [{ id: 'c-1' }] }] };
        }
        return { rows: [] };
      },
      release: () => {},
    };
    const pool = {
      connect: async () => client,
    };
    const res = await executeDbMcpCommitList(/** @type {any} */ (pool), {
      userId: USER_A,
      callApi: async () => ({ status: 200, body: {} }),
      opsById: new Map(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('must be locked');
    }
  });

  it('executes commit list sequentially for user when list is locked', async () => {
    /** @type {any[]} */
    const executedOps = [];
    const client = {
      query: async (/** @type {string} */ sql) => {
        if (sql.includes('SELECT list_locked, commit_list')) {
          return {
            rows: [
              {
                list_locked: true,
                commit_list: [
                  {
                    id: 'c-1',
                    operationId: 'createUser',
                    command: 'users create',
                    params: {},
                    body: { email: 'user@example.org' },
                  },
                ],
              },
            ],
          };
        }
        return { rows: [] };
      },
      release: () => {},
    };
    const pool = {
      connect: async () => client,
      query: async () => ({ rows: [] }),
    };
    const opsById = new Map([['createUser', { operationId: 'createUser' }]]);
    const res = await executeDbMcpCommitList(/** @type {any} */ (pool), {
      userId: USER_A,
      callApi: async (op, args) => {
        executedOps.push({ op: op.operationId, args });
        return { status: 201, body: { id: 'u-123' } };
      },
      opsById,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.executed).toHaveLength(1);
      expect(res.executed[0].command).toBe('users create');
    }
    expect(executedOps).toHaveLength(1);
  });

  it('isolates state between user A and user B', async () => {
    const userStates = new Map();
    const pool = {
      query: async (/** @type {string} */ sql, /** @type {any[]} */ params) => {
        if (sql.includes('SELECT')) {
          const userId = params[0];
          const row = userStates.get(userId);
          return { rows: row ? [row] : [] };
        }
        if (sql.includes('INSERT INTO mcp_state')) {
          const userId = params[0];
          userStates.set(userId, {
            user_id: userId,
            fixed_time_until: null,
            list_locked: false,
            commit_list: [],
            updated_at: new Date(),
          });
          return { rows: [] };
        }
        return { rows: [] };
      },
    };

    const stateA = await getDbMcpState(/** @type {any} */ (pool), USER_A);
    const stateB = await getDbMcpState(/** @type {any} */ (pool), USER_B);

    expect(stateA).toBeDefined();
    expect(stateB).toBeDefined();
    expect(userStates.has(USER_A)).toBe(true);
    expect(userStates.has(USER_B)).toBe(true);
  });
});
