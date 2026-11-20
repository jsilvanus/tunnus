import {
  createUser,
  deleteUserAccount,
  revokeUserSessions as revokeSessionRows,
} from '../../accounts.js';
import { buildOtpAuthUri, encryptTotpSecret, generateTotpSecret } from '../../totp.js';
import { AdminError } from '../errors.js';
import { page } from '../paging.js';
import { userJson, USER_GROUP_BY, USER_SELECT } from '../serialize.js';
import {
  conflict,
  cursorField,
  escapeLike,
  inTransaction,
  isUniqueViolation,
  notFound,
} from '../handlerHelpers.js';

/** @typedef {import('../types.js').HandlerContext} HandlerContext */
/** @typedef {import('../types.js').HandlerResult} HandlerResult */
/** @typedef {import('pg').PoolClient} PoolClient */

const USER_BY_ID = `${USER_SELECT} WHERE u.id = $1 ${USER_GROUP_BY}`;

/** @param {string} email */
const normalizeEmail = (email) => email.trim().toLowerCase();

/**
 * Lock every active admin, in id order. Each transaction that can remove an admin takes this lock
 * first, so concurrent changes to the admins are serialised and cannot both pass the last-admin check.
 * @param {PoolClient} client
 * @returns {Promise<string[]>} ids of the active admins
 */
async function lockActiveAdmins(client) {
  const { rows } = await client.query(
    "SELECT id FROM users WHERE is_admin AND status = 'active' ORDER BY id FOR UPDATE",
  );
  return rows.map((row) => row.id);
}

/**
 * Throws 409 `last_admin` unless an active admin other than `userId` exists.
 * Call only when the change takes `userId` out of the active admins.
 * @param {string[]} activeAdmins from lockActiveAdmins
 * @param {string} userId
 */
function assertOtherAdminRemains(activeAdmins, userId) {
  if (!activeAdmins.some((id) => id !== userId)) {
    throw new AdminError(409, 'last_admin', 'This change would leave no active admin');
  }
}

/**
 * Revoke the user's admin tokens. Their next call fails with 401.
 * @param {PoolClient} client
 * @param {string} userId
 */
async function revokeAdminTokens(client, userId) {
  await client.query(
    'UPDATE admin_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
}

/** @param {unknown} err */
function mapEmailConflict(err) {
  if (isUniqueViolation(err)) return conflict('Email address already in use');
  return err;
}

export const handlers = {
  /**
   * Filters combine with AND. Ordered by email; keyset paging on email.
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async listUsers(ctx) {
    const { q, email, status, is_admin: isAdmin, group_id: groupId, limit } = ctx.query;
    const pattern = q === undefined ? null : `%${escapeLike(q)}%`;
    const after = ctx.query.cursor === undefined ? null : cursorField(ctx.query.cursor, 'email');
    const { rows } = await ctx.pool.query(
      `${USER_SELECT}
        WHERE ($1::text IS NULL OR u.email ILIKE $1 OR u.display_name ILIKE $1)
          AND ($2::text IS NULL OR u.email = $2)
          AND ($3::text IS NULL OR u.status = $3)
          AND ($4::boolean IS NULL OR u.is_admin = $4)
          AND ($5::bigint IS NULL OR EXISTS (
                SELECT 1 FROM user_groups ug WHERE ug.user_id = u.id AND ug.group_id = $5))
          AND ($6::text IS NULL OR u.email > $6)
        ${USER_GROUP_BY}
        ORDER BY u.email
        LIMIT $7`,
      [
        pattern,
        email === undefined ? null : normalizeEmail(email),
        status ?? null,
        isAdmin ?? null,
        groupId ?? null,
        after,
        limit + 1,
      ],
    );
    const result = page(rows, limit, (row) => ({ email: row.email }));
    return { body: { items: result.items.map(userJson), next_cursor: result.next_cursor } };
  },

  /**
   * The user joins the default groups. Any email domain is allowed.
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async createUser(ctx) {
    const { email, display_name: displayName, is_admin: isAdmin } = ctx.body;
    let id;
    try {
      id = await inTransaction(ctx.pool, async (client) => {
        const newId = await createUser(
          client,
          normalizeEmail(email),
          ctx.config.defaultGroups,
          displayName,
        );
        if (isAdmin) await client.query('UPDATE users SET is_admin = true WHERE id = $1', [newId]);
        return newId;
      });
    } catch (err) {
      throw mapEmailConflict(err);
    }
    const { rows } = await ctx.pool.query(USER_BY_ID, [id]);
    return {
      status: 201,
      body: userJson(rows[0]),
      audit: { targetType: 'user', targetId: id, details: { is_admin: Boolean(isAdmin) } },
    };
  },

  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async getUser(ctx) {
    const { rows } = await ctx.pool.query(USER_BY_ID, [String(ctx.params.userId)]);
    if (!rows[0]) throw notFound('User not found');
    return { body: userJson(rows[0]) };
  },

  /**
   * Runs in one transaction. Disabling a user ends their sessions and revokes their admin tokens;
   * removing admin status revokes their admin tokens. Audit details name the changed fields and,
   * for status and admin flags, the new values. Email and display name values are never audited.
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async updateUser(ctx) {
    const userId = String(ctx.params.userId);
    const body = ctx.body;
    const email = body.email === undefined ? null : normalizeEmail(body.email);
    const displayName = body.display_name === undefined ? null : body.display_name.trim();
    if (displayName === '') {
      throw new AdminError(400, 'invalid_request', 'Invalid request', [
        { path: '/display_name', message: 'must not be blank' },
      ]);
    }

    let result;
    try {
      result = await inTransaction(ctx.pool, async (client) => {
        const activeAdmins = await lockActiveAdmins(client);
        const { rows } = await client.query(
          'SELECT email, display_name, status, is_admin FROM users WHERE id = $1 FOR UPDATE',
          [userId],
        );
        const before = rows[0];
        if (!before) throw notFound('User not found');

        const status = body.status ?? before.status;
        const isAdmin = body.is_admin ?? before.is_admin;
        const wasActiveAdmin = before.status === 'active' && before.is_admin;
        const isActiveAdmin = status === 'active' && isAdmin;
        if (wasActiveAdmin && !isActiveAdmin) assertOtherAdminRemains(activeAdmins, userId);

        await client.query(
          `UPDATE users
              SET email = COALESCE($2, email),
                  display_name = COALESCE($3, display_name),
                  status = COALESCE($4, status),
                  is_admin = COALESCE($5, is_admin)
            WHERE id = $1`,
          [userId, email, displayName, body.status ?? null, body.is_admin ?? null],
        );
        if (body.status === 'disabled') {
          await revokeSessionRows(client, userId);
          await revokeAdminTokens(client, userId);
        }
        if (body.is_admin === false) await revokeAdminTokens(client, userId);

        const fields = [];
        if (email !== null && email !== before.email) fields.push('email');
        if (displayName !== null && displayName !== before.display_name)
          fields.push('display_name');
        if (body.status !== undefined && body.status !== before.status) fields.push('status');
        if (body.is_admin !== undefined && body.is_admin !== before.is_admin)
          fields.push('is_admin');
        /** @type {Record<string, unknown>} */
        const details = { fields };
        if (fields.includes('status')) details.status = body.status;
        if (fields.includes('is_admin')) details.is_admin = body.is_admin;

        const updated = await client.query(USER_BY_ID, [userId]);
        return { row: updated.rows[0], details };
      });
    } catch (err) {
      throw mapEmailConflict(err);
    }
    return {
      body: userJson(result.row),
      audit: { targetType: 'user', targetId: userId, details: result.details },
    };
  },

  /**
   * Ends sessions, then deletes the user. Memberships and admin tokens go with the row.
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async deleteUser(ctx) {
    const userId = String(ctx.params.userId);
    await inTransaction(ctx.pool, async (client) => {
      const activeAdmins = await lockActiveAdmins(client);
      const { rows } = await client.query(
        'SELECT status, is_admin FROM users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      const user = rows[0];
      if (!user) throw notFound('User not found');
      if (user.status === 'active' && user.is_admin) assertOtherAdminRemains(activeAdmins, userId);
      await deleteUserAccount(client, userId);
    });
    return { status: 204, audit: { targetType: 'user', targetId: userId } };
  },

  /**
   * Ends sessions, grants and tokens. Admin tokens are not affected.
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async revokeUserSessions(ctx) {
    const userId = String(ctx.params.userId);
    const { rowCount } = await ctx.pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (!rowCount) throw notFound('User not found');
    const revoked = await revokeSessionRows(ctx.pool, userId);
    return {
      body: { revoked },
      audit: { targetType: 'user', targetId: userId, details: { revoked } },
    };
  },

  /**
   * Generate and enable TOTP for a user. Returns the secret and otpauth URI once.
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async enableUserTotp(ctx) {
    const userId = String(ctx.params.userId);
    const { rows } = await ctx.pool.query('SELECT id, email FROM users WHERE id = $1', [userId]);
    const user = rows[0];
    if (!user) throw notFound('User not found');

    const { base32 } = generateTotpSecret();
    const secretEnc = encryptTotpSecret(base32, ctx.config.keyEncryptionSecret);
    await ctx.pool.query(
      `UPDATE users
          SET totp_secret_enc = $2,
              totp_enabled_at = now(),
              totp_last_step = NULL,
              totp_failed_attempts = 0,
              totp_locked_until = NULL
        WHERE id = $1`,
      [userId, secretEnc],
    );
    const issuer = ctx.config.brand.name || ctx.config.issuer;
    return {
      body: {
        secret: base32,
        otpauth_uri: buildOtpAuthUri({ secretBase32: base32, email: user.email, issuer }),
      },
      audit: { targetType: 'user', targetId: userId },
    };
  },

  /**
   * Disable and clear TOTP for a user.
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async disableUserTotp(ctx) {
    const userId = String(ctx.params.userId);
    const { rowCount } = await ctx.pool.query(
      `UPDATE users
          SET totp_secret_enc = NULL,
              totp_enabled_at = NULL,
              totp_last_step = NULL,
              totp_failed_attempts = 0,
              totp_locked_until = NULL
        WHERE id = $1`,
      [userId],
    );
    if (!rowCount) throw notFound('User not found');
    return { status: 204, audit: { targetType: 'user', targetId: userId } };
  },
};
