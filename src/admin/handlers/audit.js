import { AdminError } from '../errors.js';
import { decodeCursor, page } from '../paging.js';

/** @typedef {import('../types.js').HandlerContext} HandlerContext */
/** @typedef {import('../types.js').HandlerResult} HandlerResult */

const BIGINT_MAX = 9223372036854775807n;

/** @returns {AdminError} */
function invalidCursor() {
  return new AdminError(400, 'invalid_request', 'Invalid request', [
    { path: '/cursor', message: 'not a valid cursor' },
  ]);
}

/**
 * The id from a cursor we issued: a bigint held as a string.
 * @param {string} cursor
 * @returns {string}
 */
function cursorId(cursor) {
  const { id } = decodeCursor(cursor);
  if (typeof id !== 'string' || !/^\d{1,19}$/.test(id) || BigInt(id) > BIGINT_MAX) {
    throw invalidCursor();
  }
  return id;
}

/**
 * Escape LIKE wildcards so a prefix matches literally.
 * @param {string} s
 */
function escapeLike(s) {
  return s.replace(/[\\%_]/g, '\\$&');
}

/**
 * The AuditEvent schema.
 * @param {Record<string, any>} row
 */
function auditJson(row) {
  return {
    id: String(row.id),
    at: new Date(row.at).toISOString(),
    actor_user_id: row.actor_user_id ?? null,
    action: row.action,
    target_type: row.target_type ?? null,
    target_id: row.target_id ?? null,
    ip: row.ip ?? null,
    details: row.details ?? {},
  };
}

export const handlers = {
  /**
   * Newest first (id descending). Filters combine with AND.
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async listAuditEvents(ctx) {
    const q = ctx.query;
    const limit = Number(q.limit ?? 50);
    /** @type {string[]} */
    const where = [];
    /** @type {unknown[]} */
    const params = [];
    /**
     * @param {string} sql a condition with one `?` for the parameter
     * @param {unknown} value
     */
    const bind = (sql, value) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };

    if (q.action !== undefined) {
      const action = /** @type {string} */ (q.action);
      if (action.endsWith('*')) {
        bind('action LIKE ?', `${escapeLike(action.slice(0, -1))}%`);
      } else {
        bind('action = ?', action);
      }
    }
    if (q.actor_user_id !== undefined) bind('actor_user_id = ?::uuid', q.actor_user_id);
    if (q.target_type !== undefined) bind('target_type = ?', q.target_type);
    if (q.target_id !== undefined) bind('target_id = ?', q.target_id);
    if (q.since !== undefined) bind('at >= ?::timestamptz', q.since);
    if (q.until !== undefined) bind('at < ?::timestamptz', q.until);
    if (q.cursor !== undefined) bind('id < ?::bigint', cursorId(q.cursor));

    params.push(limit + 1);
    const sql = `SELECT id, at, actor_user_id, action, target_type, target_id, ip, details
                   FROM audit_events
                  ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                  ORDER BY id DESC
                  LIMIT $${params.length}`;
    const { rows } = await ctx.pool.query(sql, params);
    const { items, next_cursor: nextCursor } = page(rows, limit, (row) => ({
      id: String(row.id),
    }));
    return { body: { items: items.map(auditJson), next_cursor: nextCursor } };
  },
};
