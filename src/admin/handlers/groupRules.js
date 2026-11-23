import { AdminError } from '../errors.js';
import {
  conflict,
  inTransaction,
  isUniqueViolation,
  notFound,
  resolveGroup,
} from '../handlerHelpers.js';

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
    const {
      source_group: sourceGroup,
      source_groups: sourceGroups,
      implied_group: impliedGroup,
      implied_groups: impliedGroups,
    } = ctx.body;

    const sources =
      Array.isArray(sourceGroups) && sourceGroups.length > 0
        ? sourceGroups
        : sourceGroup !== undefined && sourceGroup !== null
          ? [sourceGroup]
          : [];

    const implieds =
      Array.isArray(impliedGroups) && impliedGroups.length > 0
        ? impliedGroups
        : impliedGroup !== undefined && impliedGroup !== null
          ? [impliedGroup]
          : [];

    if (sources.length === 0) {
      throw new AdminError(400, 'invalid_request', 'Missing source group', [
        { path: '/source_group', message: 'required' },
      ]);
    }
    if (implieds.length === 0) {
      throw new AdminError(400, 'invalid_request', 'Missing implied group', [
        { path: '/implied_group', message: 'required' },
      ]);
    }

    const isBatch = Boolean(sourceGroups || impliedGroups);

    let items;
    try {
      items = await inTransaction(ctx.pool, async (client) => {
        /** @type {any[]} */
        const resultItems = [];
        for (const srcRef of sources) {
          const src = await resolveGroup(client, srcRef);
          for (const impRef of implieds) {
            const imp = await resolveGroup(client, impRef);

            if (String(src.id) === String(imp.id)) {
              throw new AdminError(
                400,
                'invalid_request',
                'Source and implied groups cannot be the same',
              );
            }

            const query = isBatch
              ? `INSERT INTO group_implications (source_group_id, implied_group_id)
                 VALUES ($1, $2)
                 ON CONFLICT (source_group_id, implied_group_id) DO UPDATE
                 SET source_group_id = EXCLUDED.source_group_id
                 RETURNING id, created_at`
              : `INSERT INTO group_implications (source_group_id, implied_group_id)
                 VALUES ($1, $2)
                 RETURNING id, created_at`;

            const { rows } = await client.query(query, [src.id, imp.id]);

            resultItems.push({
              id: Number(rows[0].id),
              source_group_id: Number(src.id),
              source_group_name: src.name,
              implied_group_id: Number(imp.id),
              implied_group_name: imp.name,
              created_at: new Date(rows[0].created_at).toISOString(),
            });
          }
        }
        return resultItems;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict('Group implication rule already exists');
      }
      throw err;
    }

    if (!isBatch) {
      const single = items[0];
      return {
        status: 201,
        body: single,
        audit: {
          targetType: 'group_rule',
          targetId: String(single.id),
          details: {
            source: single.source_group_name,
            implies: single.implied_group_name,
          },
        },
      };
    }

    return {
      status: 201,
      body: { items },
      audit: {
        targetType: 'group_rule',
        targetId: items.map((r) => r.id).join(','),
        details: {
          count: items.length,
          rules: items.map((r) => `${r.source_group_name} -> ${r.implied_group_name}`),
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
