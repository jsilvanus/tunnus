import { ApiError } from '../client/http.js';
import { audit } from '../audit.js';

/**
 * @typedef {import('../client/mcpState.js').StagedAction} StagedAction
 * @typedef {{
 *   fixedTimeUntil: string | null,
 *   listLocked: boolean,
 *   commitList: StagedAction[],
 *   updatedAt: string,
 *   userId: string | null,
 * }} DbMcpState
 */

/**
 * @param {import('pg').Pool} pool
 * @param {string | null | undefined} userId
 * @returns {Promise<DbMcpState>}
 */
export async function getDbMcpState(pool, userId) {
  if (!userId) {
    return {
      fixedTimeUntil: null,
      listLocked: false,
      commitList: [],
      updatedAt: new Date().toISOString(),
      userId: null,
    };
  }
  const { rows } = await pool.query(
    'SELECT fixed_time_until, list_locked, commit_list, updated_at FROM mcp_state WHERE user_id = $1',
    [userId],
  );
  if (!rows[0]) {
    await pool.query(
      "INSERT INTO mcp_state (user_id, fixed_time_until, list_locked, commit_list) VALUES ($1, NULL, false, '[]'::jsonb) ON CONFLICT (user_id) DO NOTHING",
      [userId],
    );
    return {
      fixedTimeUntil: null,
      listLocked: false,
      commitList: [],
      updatedAt: new Date().toISOString(),
      userId,
    };
  }
  const r = rows[0];
  return {
    fixedTimeUntil: r.fixed_time_until ? new Date(r.fixed_time_until).toISOString() : null,
    listLocked: Boolean(r.list_locked),
    commitList: Array.isArray(r.commit_list) ? r.commit_list : [],
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
    userId,
  };
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ userId: string, minutes?: number }} options
 * @returns {Promise<DbMcpState>}
 */
export async function setDbMcpFixedTime(pool, { userId, minutes = 15 }) {
  if (!userId) throw new Error('userId is required');
  const until = minutes > 0 ? new Date(Date.now() + minutes * 60 * 1000).toISOString() : null;
  const { rows } = await pool.query(
    `INSERT INTO mcp_state (user_id, fixed_time_until, list_locked, commit_list, updated_at)
     VALUES ($1, $2, false, '[]'::jsonb, now())
     ON CONFLICT (user_id) DO UPDATE
     SET fixed_time_until = EXCLUDED.fixed_time_until, updated_at = now()
     RETURNING fixed_time_until, list_locked, commit_list, updated_at`,
    [userId, until],
  );
  const r = rows[0];
  return {
    fixedTimeUntil: r.fixed_time_until ? new Date(r.fixed_time_until).toISOString() : null,
    listLocked: Boolean(r.list_locked),
    commitList: Array.isArray(r.commit_list) ? r.commit_list : [],
    updatedAt: new Date(r.updated_at).toISOString(),
    userId,
  };
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ userId: string, locked: boolean }} options
 * @returns {Promise<DbMcpState>}
 */
export async function setDbMcpLock(pool, { userId, locked }) {
  if (!userId) throw new Error('userId is required');
  const { rows } = await pool.query(
    `INSERT INTO mcp_state (user_id, fixed_time_until, list_locked, commit_list, updated_at)
     VALUES ($1, NULL, $2, '[]'::jsonb, now())
     ON CONFLICT (user_id) DO UPDATE
     SET list_locked = EXCLUDED.list_locked, updated_at = now()
     RETURNING fixed_time_until, list_locked, commit_list, updated_at`,
    [userId, Boolean(locked)],
  );
  const r = rows[0];
  return {
    fixedTimeUntil: r.fixed_time_until ? new Date(r.fixed_time_until).toISOString() : null,
    listLocked: Boolean(r.list_locked),
    commitList: Array.isArray(r.commit_list) ? r.commit_list : [],
    updatedAt: new Date(r.updated_at).toISOString(),
    userId,
  };
}

/**
 * Stage an action into the user's commit list.
 * Atomic check: only appends if list_locked = false!
 * @param {import('pg').Pool} pool
 * @param {{
 *   userId: string,
 *   action: Omit<StagedAction, 'id' | 'stagedAt'>,
 *   actor?: { userId?: string, email?: string, label?: string } | null,
 * }} options
 * @returns {Promise<{ ok: true, staged: StagedAction } | { ok: false, reason: string }>}
 */
export async function stageDbMcpAction(pool, { userId, action, actor = null }) {
  if (!userId) return { ok: false, reason: 'missing_user' };
  const id = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  /** @type {StagedAction} */
  const staged = {
    id,
    ...action,
    stagedAt: new Date().toISOString(),
    stagedBy: actor ?? null,
  };
  await pool.query(
    "INSERT INTO mcp_state (user_id, fixed_time_until, list_locked, commit_list) VALUES ($1, NULL, false, '[]'::jsonb) ON CONFLICT (user_id) DO NOTHING",
    [userId],
  );
  const { rows } = await pool.query(
    `UPDATE mcp_state
     SET commit_list = commit_list || $1::jsonb, updated_at = now()
     WHERE user_id = $2 AND list_locked = false
     RETURNING user_id`,
    [JSON.stringify([staged]), userId],
  );
  if (rows.length === 0) {
    return { ok: false, reason: 'locked' };
  }
  return { ok: true, staged };
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ userId: string }} options
 * @returns {Promise<void>}
 */
export async function clearDbMcpCommitList(pool, { userId }) {
  if (!userId) return;
  await pool.query(
    `UPDATE mcp_state
     SET commit_list = '[]'::jsonb, updated_at = now()
     WHERE user_id = $1`,
    [userId],
  );
}

/**
 * Execute the staged commit list against the API for a specific user.
 * Requires list_locked === true!
 * @param {import('pg').Pool} pool
 * @param {{
 *   userId: string,
 *   callApi: (op: any, args: { params: Record<string, unknown>, body?: unknown }) => Promise<{ status: number, body: any }>,
 *   opsById: Map<string, any>,
 *   ip?: string | null,
 * }} options
 * @returns {Promise<{ ok: true, executed: any[] } | { ok: false, error: string, executed: any[] }>}
 */
export async function executeDbMcpCommitList(pool, { userId, callApi, opsById, ip = null }) {
  if (!userId) return { ok: false, error: 'User is required to execute commit list', executed: [] };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT list_locked, commit_list FROM mcp_state WHERE user_id = $1 FOR UPDATE',
      [userId],
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'MCP state not found for user', executed: [] };
    }
    if (!rows[0].list_locked) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'Commit list must be locked before execution', executed: [] };
    }
    const list = Array.isArray(rows[0].commit_list) ? rows[0].commit_list : [];
    if (list.length === 0) {
      await client.query('COMMIT');
      return { ok: true, executed: [] };
    }

    /** @type {any[]} */
    const executed = [];
    const remaining = [...list];

    while (remaining.length > 0) {
      const item = remaining[0];
      const op = opsById.get(item.operationId);
      if (!op) {
        await client.query(
          'UPDATE mcp_state SET commit_list = $1::jsonb, updated_at = now() WHERE user_id = $2',
          [JSON.stringify(remaining), userId],
        );
        await client.query('COMMIT');
        return {
          ok: false,
          error: `Unknown operation in commit list: ${item.operationId}`,
          executed,
        };
      }
      try {
        const res = await callApi(op, { params: item.params, body: item.body });
        executed.push({
          id: item.id,
          operationId: item.operationId,
          command: item.command,
          status: res.status,
          body: res.body,
        });
        remaining.shift();
      } catch (err) {
        await client.query(
          'UPDATE mcp_state SET commit_list = $1::jsonb, updated_at = now() WHERE user_id = $2',
          [JSON.stringify(remaining), userId],
        );
        await client.query('COMMIT');
        const errMsg = err instanceof ApiError ? err.message : String(err);
        return {
          ok: false,
          error: `Failed executing ${item.command} (${item.id}): ${errMsg}`,
          executed,
        };
      }
    }

    await client.query(
      "UPDATE mcp_state SET commit_list = '[]'::jsonb, updated_at = now() WHERE user_id = $1",
      [userId],
    );
    await client.query('COMMIT');

    await audit(pool, {
      action: 'mcp.commit_executed',
      actorUserId: userId,
      ip,
      details: { count: executed.length, executedIds: executed.map((e) => e.id) },
    });

    return { ok: true, executed };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
