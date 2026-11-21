import { ApiError } from '../client/http.js';
import { audit } from '../audit.js';

/**
 * @typedef {import('../client/mcpState.js').StagedAction} StagedAction
 * @typedef {{
 *   fixedTimeUntil: string | null,
 *   listLocked: boolean,
 *   commitList: StagedAction[],
 *   updatedAt: string,
 *   updatedBy: string | null,
 * }} DbMcpState
 */

/**
 * @param {import('pg').Pool} pool
 * @returns {Promise<DbMcpState>}
 */
export async function getDbMcpState(pool) {
  const { rows } = await pool.query(
    'SELECT fixed_time_until, list_locked, commit_list, updated_at, updated_by FROM mcp_state WHERE id = 1',
  );
  if (!rows[0]) {
    await pool.query(
      "INSERT INTO mcp_state (id, fixed_time_until, list_locked, commit_list) VALUES (1, NULL, false, '[]'::jsonb) ON CONFLICT (id) DO NOTHING",
    );
    return {
      fixedTimeUntil: null,
      listLocked: false,
      commitList: [],
      updatedAt: new Date().toISOString(),
      updatedBy: null,
    };
  }
  const r = rows[0];
  return {
    fixedTimeUntil: r.fixed_time_until ? new Date(r.fixed_time_until).toISOString() : null,
    listLocked: Boolean(r.list_locked),
    commitList: Array.isArray(r.commit_list) ? r.commit_list : [],
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
    updatedBy: r.updated_by ?? null,
  };
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ minutes?: number, userId?: string | null }} options
 * @returns {Promise<DbMcpState>}
 */
export async function setDbMcpFixedTime(pool, { minutes = 15, userId = null } = {}) {
  const until = minutes > 0 ? new Date(Date.now() + minutes * 60 * 1000).toISOString() : null;
  const { rows } = await pool.query(
    `UPDATE mcp_state
     SET fixed_time_until = $1, updated_at = now(), updated_by = $2
     WHERE id = 1
     RETURNING fixed_time_until, list_locked, commit_list, updated_at, updated_by`,
    [until, userId],
  );
  const r = rows[0];
  return {
    fixedTimeUntil: r.fixed_time_until ? new Date(r.fixed_time_until).toISOString() : null,
    listLocked: Boolean(r.list_locked),
    commitList: Array.isArray(r.commit_list) ? r.commit_list : [],
    updatedAt: new Date(r.updated_at).toISOString(),
    updatedBy: r.updated_by ?? null,
  };
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ locked: boolean, userId?: string | null }} options
 * @returns {Promise<DbMcpState>}
 */
export async function setDbMcpLock(pool, { locked, userId = null }) {
  const { rows } = await pool.query(
    `UPDATE mcp_state
     SET list_locked = $1, updated_at = now(), updated_by = $2
     WHERE id = 1
     RETURNING fixed_time_until, list_locked, commit_list, updated_at, updated_by`,
    [Boolean(locked), userId],
  );
  const r = rows[0];
  return {
    fixedTimeUntil: r.fixed_time_until ? new Date(r.fixed_time_until).toISOString() : null,
    listLocked: Boolean(r.list_locked),
    commitList: Array.isArray(r.commit_list) ? r.commit_list : [],
    updatedAt: new Date(r.updated_at).toISOString(),
    updatedBy: r.updated_by ?? null,
  };
}

/**
 * Stage an action into the commit list.
 * Atomic check: only appends if list_locked = false!
 * @param {import('pg').Pool} pool
 * @param {{
 *   action: Omit<StagedAction, 'id' | 'stagedAt'>,
 *   userId?: string | null,
 * }} options
 * @returns {Promise<{ ok: true, staged: StagedAction } | { ok: false, reason: 'locked' }>}
 */
export async function stageDbMcpAction(pool, { action, userId = null }) {
  const id = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  /** @type {StagedAction} */
  const staged = {
    id,
    ...action,
    stagedAt: new Date().toISOString(),
  };
  const { rows } = await pool.query(
    `UPDATE mcp_state
     SET commit_list = commit_list || $1::jsonb, updated_at = now(), updated_by = $2
     WHERE id = 1 AND list_locked = false
     RETURNING id`,
    [JSON.stringify([staged]), userId],
  );
  if (rows.length === 0) {
    return { ok: false, reason: 'locked' };
  }
  return { ok: true, staged };
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ userId?: string | null }} options
 * @returns {Promise<void>}
 */
export async function clearDbMcpCommitList(pool, { userId = null } = {}) {
  await pool.query(
    `UPDATE mcp_state
     SET commit_list = '[]'::jsonb, updated_at = now(), updated_by = $1
     WHERE id = 1`,
    [userId],
  );
}

/**
 * Execute the staged commit list against the API.
 * Requires list_locked === true!
 * @param {import('pg').Pool} pool
 * @param {{
 *   callApi: (op: any, args: { params: Record<string, unknown>, body?: unknown }) => Promise<{ status: number, body: any }>,
 *   opsById: Map<string, any>,
 *   userId?: string | null,
 *   ip?: string | null,
 * }} options
 * @returns {Promise<{ ok: true, executed: any[] } | { ok: false, error: string, executed: any[] }>}
 */
export async function executeDbMcpCommitList(pool, { callApi, opsById, userId = null, ip = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT list_locked, commit_list FROM mcp_state WHERE id = 1 FOR UPDATE',
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'MCP state not found', executed: [] };
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
          'UPDATE mcp_state SET commit_list = $1::jsonb, updated_at = now(), updated_by = $2 WHERE id = 1',
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
          'UPDATE mcp_state SET commit_list = $1::jsonb, updated_at = now(), updated_by = $2 WHERE id = 1',
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
      "UPDATE mcp_state SET commit_list = '[]'::jsonb, updated_at = now(), updated_by = $1 WHERE id = 1",
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
