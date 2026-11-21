import { describe, expect, it } from 'vitest';
import {
  clearDbMcpCommitList,
  executeDbMcpCommitList,
  getDbMcpState,
  setDbMcpFixedTime,
  setDbMcpLock,
  stageDbMcpAction,
} from '../src/mcp/dbState.js';

describe('mcp dbState', () => {
  it('loads default state when table is empty and inserts default row', async () => {
    let inserted = false;
    const pool = {
      query: async (/** @type {string} */ sql) => {
        if (sql.includes('SELECT')) return { rows: [] };
        if (sql.includes('INSERT INTO mcp_state')) {
          inserted = true;
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    const state = await getDbMcpState(/** @type {any} */ (pool));
    expect(inserted).toBe(true);
    expect(state.listLocked).toBe(false);
    expect(state.fixedTimeUntil).toBe(null);
    expect(state.commitList).toEqual([]);
  });

  it('reads existing state from mcp_state table', async () => {
    const fakeRow = {
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
        },
      ],
      updated_at: new Date('2026-11-21T11:50:00Z'),
      updated_by: '00000000-0000-0000-0000-000000000001',
    };
    const pool = {
      query: async () => ({ rows: [fakeRow] }),
    };
    const state = await getDbMcpState(/** @type {any} */ (pool));
    expect(state.listLocked).toBe(true);
    expect(state.fixedTimeUntil).toBe('2026-11-21T12:00:00.000Z');
    expect(state.commitList).toHaveLength(1);
    expect(state.commitList[0].id).toBe('c-1');
  });

  it('sets and cancels fixed time lease', async () => {
    let updatedUntil = undefined;
    const pool = {
      query: async (/** @type {string} */ _sql, /** @type {any[]} */ params) => {
        updatedUntil = params[0];
        return {
          rows: [
            {
              fixed_time_until: updatedUntil,
              list_locked: false,
              commit_list: [],
              updated_at: new Date(),
              updated_by: params[1],
            },
          ],
        };
      },
    };
    const res1 = await setDbMcpFixedTime(/** @type {any} */ (pool), { minutes: 15, userId: 'u-1' });
    expect(res1.fixedTimeUntil).toBeTruthy();
    expect(new Date(res1.fixedTimeUntil || '').getTime()).toBeGreaterThan(Date.now());

    const res2 = await setDbMcpFixedTime(/** @type {any} */ (pool), { minutes: 0, userId: 'u-1' });
    expect(res2.fixedTimeUntil).toBe(null);
  });

  it('toggles list lock', async () => {
    let lockedVal = undefined;
    const pool = {
      query: async (/** @type {string} */ _sql, /** @type {any[]} */ params) => {
        lockedVal = params[0];
        return {
          rows: [
            {
              fixed_time_until: null,
              list_locked: lockedVal,
              commit_list: [],
              updated_at: new Date(),
              updated_by: params[1],
            },
          ],
        };
      },
    };
    const r1 = await setDbMcpLock(/** @type {any} */ (pool), { locked: true });
    expect(r1.listLocked).toBe(true);

    const r2 = await setDbMcpLock(/** @type {any} */ (pool), { locked: false });
    expect(r2.listLocked).toBe(false);
  });

  it('stages actions atomically when unlocked and rejects when locked', async () => {
    let currentLocked = false;
    /** @type {any[]} */
    const list = [];
    const pool = {
      query: async (/** @type {string} */ sql, /** @type {any[]} */ params) => {
        if (sql.includes('commit_list = commit_list ||')) {
          if (currentLocked) return { rows: [] }; // WHERE list_locked = false matched nothing
          const newItem = JSON.parse(params[0])[0];
          list.push(newItem);
          return { rows: [{ id: 1 }] };
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

    const s1 = await stageDbMcpAction(/** @type {any} */ (pool), { action: action1 });
    expect(s1.ok).toBe(true);
    expect(list).toHaveLength(1);

    // Lock the list
    currentLocked = true;
    const s2 = await stageDbMcpAction(/** @type {any} */ (pool), { action: action1 });
    expect(s2.ok).toBe(false);
    if (!s2.ok) {
      expect(s2.reason).toBe('locked');
    }
    expect(list).toHaveLength(1);
  });

  it('clears commit list in database', async () => {
    let cleared = false;
    const pool = {
      query: async (/** @type {string} */ sql) => {
        if (sql.includes("commit_list = '[]'::jsonb")) {
          cleared = true;
        }
        return { rows: [] };
      },
    };
    await clearDbMcpCommitList(/** @type {any} */ (pool));
    expect(cleared).toBe(true);
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
      callApi: async () => ({ status: 200, body: {} }),
      opsById: new Map(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('must be locked');
    }
  });

  it('executes commit list sequentially when list is locked', async () => {
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
});
