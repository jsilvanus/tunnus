import { createAdminToken } from '../../adminTokens.js';
import { AdminError } from '../errors.js';
import { tokenJson, userJson, USER_GROUP_BY, USER_SELECT } from '../serialize.js';

/** @typedef {import('../types.js').HandlerContext} HandlerContext */
/** @typedef {import('../types.js').HandlerResult} HandlerResult */

const TOKEN_COLUMNS = `SELECT id, user_id, label, created_at, created_by, expires_at,
       last_used_at, revoked_at
  FROM admin_tokens`;

export const handlers = {
  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async getMe(ctx) {
    const { rows: users } = await ctx.pool.query(
      `${USER_SELECT} WHERE u.id = $1 ${USER_GROUP_BY}`,
      [ctx.actor.userId],
    );
    if (!users[0]) throw new AdminError(401, 'unauthorized', 'Missing or invalid admin token');
    if (ctx.actor.tokenId === null) {
      return { body: { user: userJson(users[0]) } };
    }
    const { rows: tokens } = await ctx.pool.query(`${TOKEN_COLUMNS} WHERE id = $1`, [
      ctx.actor.tokenId,
    ]);
    if (!tokens[0]) throw new AdminError(401, 'unauthorized', 'Missing or invalid admin token');
    return { body: { user: userJson(users[0]), token: tokenJson(tokens[0]) } };
  },

  /**
   * Active tokens unless include_inactive. Token values are never listed.
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async listAdminTokens(ctx) {
    const userId = ctx.query.user_id ?? null;
    const includeInactive = ctx.query.include_inactive ?? false;
    const { rows } = await ctx.pool.query(
      `${TOKEN_COLUMNS}
        WHERE ($1::uuid IS NULL OR user_id = $1::uuid)
          AND ($2::boolean OR (revoked_at IS NULL AND expires_at > now()))
        ORDER BY created_at DESC, id DESC`,
      [userId, includeInactive],
    );
    return { body: { items: rows.map((row) => tokenJson(row)) } };
  },

  /**
   * The token is for the caller unless user_id names another active admin. Its value is returned once.
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async createAdminToken(ctx) {
    const { label, expires_in_days: expiresInDays, user_id: requestedUser } = ctx.body;
    const userId = requestedUser ?? ctx.actor.userId;
    const { rows } = await ctx.pool.query('SELECT id, status, is_admin FROM users WHERE id = $1', [
      userId,
    ]);
    if (!rows[0]) throw new AdminError(404, 'not_found', 'User not found');
    if (rows[0].status !== 'active' || !rows[0].is_admin) {
      throw new AdminError(400, 'invalid_request', 'User is not an active admin', [
        { path: '/user_id', message: 'must name an active admin user' },
      ]);
    }
    const created = await createAdminToken(ctx.pool, {
      userId,
      label,
      expiresInDays,
      createdBy: ctx.actor.userId,
    });
    return {
      status: 201,
      body: { ...tokenJson(created.row), token: created.token },
      audit: {
        targetType: 'admin_token',
        targetId: created.row.id,
        details: { user_id: userId, expires_in_days: expiresInDays },
      },
    };
  },

  /**
   * Idempotent: revoking a revoked token is 204 too. Unknown ids are 404.
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async revokeAdminToken(ctx) {
    const tokenId = String(ctx.params.tokenId);
    const { rows: tokens } = await ctx.pool.query(
      'SELECT user_id FROM admin_tokens WHERE id = $1',
      [tokenId],
    );
    if (!tokens[0]) throw new AdminError(404, 'not_found', 'Token not found');
    const { rowCount } = await ctx.pool.query(
      'UPDATE admin_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
      [tokenId],
    );
    await ctx.pool.query(
      `DELETE FROM mcp_identity_refs
        WHERE owner_user_id = $1 AND auth_kind = 'admin_token' AND auth_client_key = $2`,
      [tokens[0].user_id, tokenId],
    );
    await ctx.pool.query(
      `DELETE FROM mcp_client_settings
        WHERE owner_user_id = $1 AND auth_kind = 'admin_token' AND auth_client_key = $2`,
      [tokens[0].user_id, tokenId],
    );
    return {
      status: 204,
      audit: { targetType: 'admin_token', targetId: tokenId, details: { revoked: rowCount === 1 } },
    };
  },
};
