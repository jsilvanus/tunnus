import { AdminError } from '../errors.js';
import { conflict, inTransaction, isUniqueViolation, notFound } from '../handlerHelpers.js';

/** @typedef {import('../types.js').HandlerContext} HandlerContext */
/** @typedef {import('../types.js').HandlerResult} HandlerResult */

export const handlers = {
  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async listGroupRules(ctx) {
    const { rows } = await ctx.pool.query(
      `SELECT gi.id,
              gi.source_group_id, sg.name AS source_group_name,
              gi.implied_group_id, ig.name AS implied_group_name,
              gi.created_at
         FROM group_implications gi
         JOIN groups sg ON sg.id = gi.source_group_id
         JOIN groups ig ON ig.id = gi.implied_group_id
        ORDER BY sg.name, ig.name`,
    );
    return {
      body: {
        items: rows.map((r) => ({
          id: Number(r.id),
          source_group_id: Number(r.source_group_id),
          source_group_name: r.source_group_name,
          implied_group_id: Number(r.implied_group_id),
          implied_group_name: r.implied_group_name,
          created_at: new Date(r.created_at).toISOString(),
        })),
      },
    };
  },

  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async createGroupRule(ctx) {
    const { source_group: sourceGroup, implied_group: impliedGroup } = ctx.body;

    /**
     * @param {import('pg').PoolClient} client
     * @param {string | number} val
     */
    const resolveGroup = async (client, val) => {
      if (/^\d+$/.test(String(val).trim())) {
        const { rows } = await client.query('SELECT id, name FROM groups WHERE id = $1', [
          Number(val),
        ]);
        if (rows[0]) return rows[0];
      }
      const { rows } = await client.query('SELECT id, name FROM groups WHERE name = $1', [
        String(val).trim(),
      ]);
      if (rows[0]) return rows[0];
      throw notFound(`Group not found: ${val}`);
    };

    let result;
    try {
      result = await inTransaction(ctx.pool, async (client) => {
        const src = await resolveGroup(client, sourceGroup);
        const imp = await resolveGroup(client, impliedGroup);

        if (String(src.id) === String(imp.id)) {
          throw new AdminError(
            400,
            'invalid_request',
            'Source and implied groups cannot be the same',
          );
        }

        const { rows } = await client.query(
          `INSERT INTO group_implications (source_group_id, implied_group_id)
           VALUES ($1, $2)
           RETURNING id, created_at`,
          [src.id, imp.id],
        );

        return {
          id: Number(rows[0].id),
          source_group_id: Number(src.id),
          source_group_name: src.name,
          implied_group_id: Number(imp.id),
          implied_group_name: imp.name,
          created_at: new Date(rows[0].created_at).toISOString(),
        };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict('Group implication rule already exists');
      }
      throw err;
    }

    return {
      status: 201,
      body: result,
      audit: {
        targetType: 'group_rule',
        targetId: String(result.id),
        details: {
          source: result.source_group_name,
          implies: result.implied_group_name,
        },
      },
    };
  },

  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async deleteGroupRule(ctx) {
    const ruleId = Number(ctx.params.ruleId);
    const { rowCount } = await ctx.pool.query('DELETE FROM group_implications WHERE id = $1', [
      ruleId,
    ]);
    if (!rowCount) throw notFound('Group rule not found');
    return {
      status: 204,
      audit: { targetType: 'group_rule', targetId: String(ruleId) },
    };
  },
};
