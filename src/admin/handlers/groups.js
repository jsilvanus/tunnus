import { AdminError } from '../errors.js';
import { page } from '../paging.js';
import { groupJson, membershipJson } from '../serialize.js';
import {
  conflict,
  cursorField,
  inTransaction,
  isForeignKeyViolation,
  isUniqueViolation,
  notFound,
} from '../handlerHelpers.js';

/** @typedef {import('../types.js').HandlerContext} HandlerContext */
/** @typedef {import('../types.js').HandlerResult} HandlerResult */
/** @typedef {import('../../accounts.js').Queryable} Queryable */

const GROUP_SELECT = `SELECT g.id, g.name, g.description, count(ug.user_id)::int AS member_count
  FROM groups g
  LEFT JOIN user_groups ug ON ug.group_id = g.id`;
const GROUP_GROUP_BY = 'GROUP BY g.id';

const MEMBERSHIP_SELECT = `SELECT u.id AS user_id, u.email, u.display_name,
       g.id AS group_id, g.name AS group_name, ug.granted_by, ug.granted_at
  FROM user_groups ug
  JOIN users u ON u.id = ug.user_id
  JOIN groups g ON g.id = ug.group_id`;

/**
 * @param {Queryable} db
 * @param {number} id
 */
async function findGroup(db, id) {
  const { rows } = await db.query(`${GROUP_SELECT} WHERE g.id = $1 ${GROUP_GROUP_BY}`, [id]);
  return rows[0];
}

/**
 * @param {Queryable} db
 * @param {string} userId
 * @param {number} groupId
 */
async function findMembership(db, userId, groupId) {
  const { rows } = await db.query(
    `${MEMBERSHIP_SELECT} WHERE ug.user_id = $1 AND ug.group_id = $2`,
    [userId, groupId],
  );
  return rows[0];
}

/** @param {unknown} err */
function mapNameConflict(err) {
  if (isUniqueViolation(err)) return conflict('Group name already exists');
  return err;
}

/** @param {string} name */
const defaultGroupConflict = (name) =>
  new AdminError(409, 'default_group', `"${name}" is a default group`);

export const handlers = {
  /**
   * Ordered by name; keyset paging on name. Name is exact; prefix includes the exact path and descendants.
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async listGroups(ctx) {
    const { name, prefix, limit } = ctx.query;
    const after = ctx.query.cursor === undefined ? null : cursorField(ctx.query.cursor, 'name');
    const { rows } = await ctx.pool.query(
      `${GROUP_SELECT}
        WHERE ($1::text IS NULL OR g.name = $1)
          AND ($2::text IS NULL OR g.name = $2 OR left(g.name, length($2) + 1) = $2 || '/')
          AND ($3::text IS NULL OR g.name > $3)
        ${GROUP_GROUP_BY}
        ORDER BY g.name
        LIMIT $4`,
      [name ?? null, prefix ?? null, after, limit + 1],
    );
    const result = page(rows, limit, (row) => ({ name: row.name }));
    return {
      body: {
        items: result.items.map((row) => groupJson(row, ctx.config.defaultGroups)),
        next_cursor: result.next_cursor,
      },
    };
  },

  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async createGroup(ctx) {
    const { name, description } = ctx.body;
    let id;
    try {
      const { rows } = await ctx.pool.query(
        'INSERT INTO groups (name, description) VALUES ($1, $2) RETURNING id',
        [name, description],
      );
      id = Number(rows[0].id);
    } catch (err) {
      throw mapNameConflict(err);
    }
    const row = await findGroup(ctx.pool, id);
    return {
      status: 201,
      body: groupJson(row, ctx.config.defaultGroups),
      audit: { targetType: 'group', targetId: String(id), details: { name } },
    };
  },

  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async getGroup(ctx) {
    const row = await findGroup(ctx.pool, Number(ctx.params.groupId));
    if (!row) throw notFound('Group not found');
    return { body: groupJson(row, ctx.config.defaultGroups) };
  },

  /**
   * Renaming a default group, or renaming any group to a default name, is `default_group`.
   * The description of a default group can change. Runs in one transaction.
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async updateGroup(ctx) {
    const groupId = Number(ctx.params.groupId);
    const { name, description } = ctx.body;
    const defaults = ctx.config.defaultGroups;

    let result;
    try {
      result = await inTransaction(ctx.pool, async (client) => {
        const { rows } = await client.query(
          'SELECT name, description FROM groups WHERE id = $1 FOR UPDATE',
          [groupId],
        );
        const before = rows[0];
        if (!before) throw notFound('Group not found');

        const renamed = name !== undefined && name !== before.name;
        if (renamed && defaults.includes(before.name)) throw defaultGroupConflict(before.name);
        if (renamed && defaults.includes(name)) throw defaultGroupConflict(name);

        await client.query(
          'UPDATE groups SET name = COALESCE($2, name), description = COALESCE($3, description) WHERE id = $1',
          [groupId, name ?? null, description ?? null],
        );
        /** @type {string[]} */
        const fields = [];
        if (renamed) fields.push('name');
        if (description !== undefined && description !== before.description)
          fields.push('description');
        return { row: await findGroup(client, groupId), fields };
      });
    } catch (err) {
      throw mapNameConflict(err);
    }
    return {
      body: groupJson(result.row, defaults),
      audit: { targetType: 'group', targetId: String(groupId), details: { fields: result.fields } },
    };
  },

  /**
   * Memberships are removed with the group. Runs in one transaction.
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async deleteGroup(ctx) {
    const groupId = Number(ctx.params.groupId);
    const name = await inTransaction(ctx.pool, async (client) => {
      const { rows } = await client.query('SELECT name FROM groups WHERE id = $1 FOR UPDATE', [
        groupId,
      ]);
      if (!rows[0]) throw notFound('Group not found');
      if (ctx.config.defaultGroups.includes(rows[0].name)) {
        throw defaultGroupConflict(rows[0].name);
      }
      await client.query('DELETE FROM groups WHERE id = $1', [groupId]);
      return rows[0].name;
    });
    return {
      status: 204,
      audit: { targetType: 'group', targetId: String(groupId), details: { name } },
    };
  },

  /**
   * The user's memberships, ordered by group name. Not paged.
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async listUserGroups(ctx) {
    const userId = String(ctx.params.userId);
    const { rowCount } = await ctx.pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (!rowCount) throw notFound('User not found');
    const { rows } = await ctx.pool.query(
      `${MEMBERSHIP_SELECT} WHERE ug.user_id = $1 ORDER BY g.name`,
      [userId],
    );
    return { body: { items: rows.map(membershipJson) } };
  },

  /**
   * Members ordered by email; keyset paging on email.
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async listGroupMembers(ctx) {
    const groupId = Number(ctx.params.groupId);
    const { limit } = ctx.query;
    const { rowCount } = await ctx.pool.query('SELECT 1 FROM groups WHERE id = $1', [groupId]);
    if (!rowCount) throw notFound('Group not found');
    const after = ctx.query.cursor === undefined ? null : cursorField(ctx.query.cursor, 'email');
    const { rows } = await ctx.pool.query(
      `${MEMBERSHIP_SELECT}
        WHERE ug.group_id = $1 AND ($2::text IS NULL OR u.email > $2)
        ORDER BY u.email
        LIMIT $3`,
      [groupId, after, limit + 1],
    );
    const result = page(rows, limit, (row) => ({ email: row.email }));
    return {
      body: { items: result.items.map(membershipJson), next_cursor: result.next_cursor },
    };
  },

  /**
   * 201 when the membership is new, 200 with the existing membership otherwise.
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async grantMembership(ctx) {
    const groupId = Number(ctx.params.groupId);
    const userId = String(ctx.params.userId);
    const [user, group] = await Promise.all([
      ctx.pool.query('SELECT 1 FROM users WHERE id = $1', [userId]),
      ctx.pool.query('SELECT 1 FROM groups WHERE id = $1', [groupId]),
    ]);
    if (!user.rowCount) throw notFound('User not found');
    if (!group.rowCount) throw notFound('Group not found');

    let inserted;
    try {
      const { rows } = await ctx.pool.query(
        `INSERT INTO user_groups (user_id, group_id, granted_by) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, group_id) DO NOTHING
         RETURNING granted_at`,
        [userId, groupId, ctx.actor.userId],
      );
      inserted = rows.length === 1;
    } catch (err) {
      // The user or group was deleted after the checks above.
      if (isForeignKeyViolation(err)) throw notFound('User or group not found');
      throw err;
    }
    const row = await findMembership(ctx.pool, userId, groupId);
    return {
      status: inserted ? 201 : 200,
      body: membershipJson(row),
      audit: { targetType: 'group', targetId: String(groupId), details: { user_id: userId } },
    };
  },

  /**
   * 404 when the user is not a member (or the user or group does not exist).
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async revokeMembership(ctx) {
    const groupId = Number(ctx.params.groupId);
    const userId = String(ctx.params.userId);
    const { rowCount } = await ctx.pool.query(
      'DELETE FROM user_groups WHERE user_id = $1 AND group_id = $2',
      [userId, groupId],
    );
    if (!rowCount) throw notFound('Membership not found');
    return {
      status: 204,
      audit: { targetType: 'group', targetId: String(groupId), details: { user_id: userId } },
    };
  },
};
