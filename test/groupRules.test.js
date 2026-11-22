import { describe, expect, it } from 'vitest';
import { handlers } from '../src/admin/handlers/groupRules.js';
import { loadUser } from '../src/accounts.js';

describe('computed / implicit group rules', () => {
  it('listGroupRules returns mapped implication items', async () => {
    /** @type {any} */
    const pool = {
      query: async () => ({
        rows: [
          {
            id: '1',
            source_group_id: '10',
            source_group_name: 'parish/riihimaki',
            implied_group_id: '20',
            implied_group_name: 'app/tavaranpaikka',
            created_at: '2026-11-22T08:00:00Z',
          },
        ],
      }),
    };

    const res = await handlers.listGroupRules(/** @type {any} */ ({ pool }));
    expect((/** @type {any} */ (res.body)).items).toEqual([
      {
        id: 1,
        source_group_id: 10,
        source_group_name: 'parish/riihimaki',
        implied_group_id: 20,
        implied_group_name: 'app/tavaranpaikka',
        created_at: '2026-11-22T08:00:00.000Z',
      },
    ]);
  });

  it('createGroupRule resolves groups by name, prevents self-implication, and inserts rule', async () => {
    /** @type {any[]} */
    const inserted = [];
    /** @type {any} */
    const pool = {
      connect: async () => ({
        query: async (/** @type {string} */ sql, /** @type {any[]} */ params) => {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
          if (sql.includes('SELECT id, name FROM groups WHERE name = $1')) {
            if (params[0] === 'parish/riihimaki') return { rows: [{ id: 10, name: 'parish/riihimaki' }] };
            if (params[0] === 'app/tavaranpaikka') return { rows: [{ id: 20, name: 'app/tavaranpaikka' }] };
            return { rows: [] };
          }
          if (sql.includes('INSERT INTO group_implications')) {
            inserted.push(params);
            return { rows: [{ id: 42, created_at: '2026-11-22T08:30:00Z' }] };
          }
          return { rows: [] };
        },
        release: () => {},
      }),
    };

    // Valid rule creation
    const res = await handlers.createGroupRule(/** @type {any} */ ({
      pool,
      body: {
        source_group: 'parish/riihimaki',
        implied_group: 'app/tavaranpaikka',
      },
    }));

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: 42,
      source_group_id: 10,
      source_group_name: 'parish/riihimaki',
      implied_group_id: 20,
      implied_group_name: 'app/tavaranpaikka',
      created_at: '2026-11-22T08:30:00.000Z',
    });
    expect(inserted).toEqual([[10, 20]]);

    // Rejects self-implication
    await expect(
      handlers.createGroupRule(/** @type {any} */ ({
        pool,
        body: {
          source_group: 'parish/riihimaki',
          implied_group: 'parish/riihimaki',
        },
      })),
    ).rejects.toThrow('Source and implied groups cannot be the same');

    // Rejects missing group
    await expect(
      handlers.createGroupRule(/** @type {any} */ ({
        pool,
        body: {
          source_group: 'parish/riihimaki',
          implied_group: 'nonexistent',
        },
      })),
    ).rejects.toThrow('Group not found');
  });

  it('deleteGroupRule deletes by id and returns 204 or 404', async () => {
    let deletedId = null;
    /** @type {any} */
    const pool = {
      query: async (/** @type {string} */ _sql, /** @type {any[]} */ params) => {
        if (params?.[0] === 42) {
          deletedId = params[0];
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      },
    };

    const res = await handlers.deleteGroupRule(/** @type {any} */ ({ pool, params: { ruleId: 42 } }));
    expect(res.status).toBe(204);
    expect(deletedId).toBe(42);

    await expect(handlers.deleteGroupRule(/** @type {any} */ ({ pool, params: { ruleId: 999 } }))).rejects.toThrow(
      'Group rule not found',
    );
  });

  it('loadUser executes recursive CTE to fetch direct and implied groups', async () => {
    let executedSql = '';
    /** @type {any} */
    const pool = {
      query: async (/** @type {string} */ sql) => {
        executedSql = sql;
        return {
          rows: [
            {
              id: 'u-1',
              email: 'matti@example.org',
              display_name: 'Matti',
              title: 'Pastori',
              phone_number: '+358401234567',
              status: 'active',
              activates_at: null,
              disables_at: null,
              disabled_at: null,
              groups: ['app/tavaranpaikka', 'parish/riihimaki'],
            },
          ],
        };
      },
    };

    const user = await loadUser(pool, 'u-1');
    expect(executedSql).toContain('WITH RECURSIVE all_group_edges');
    expect(executedSql).toContain('user_effective_groups');
    expect(user.groups).toEqual(['app/tavaranpaikka', 'parish/riihimaki']);
  });
});
