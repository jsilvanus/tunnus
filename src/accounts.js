import { displayNameFromEmail } from './displayName.js';

/**
 * @param {import('pg').Pool} pool
 * @param {string} id
 */
export async function loadUser(pool, id) {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.status,
            COALESCE(array_agg(g.name ORDER BY g.name) FILTER (WHERE g.name IS NOT NULL), '{}') AS groups
       FROM users u
       LEFT JOIN user_groups ug ON ug.user_id = u.id
       LEFT JOIN groups g ON g.id = ug.group_id
      WHERE u.id = $1 GROUP BY u.id`,
    [id],
  );
  return rows[0];
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} email
 */
export async function findUserByEmail(pool, email) {
  const { rows } = await pool.query('SELECT id, status FROM users WHERE email = $1', [
    email.trim().toLowerCase(),
  ]);
  return rows[0];
}

/**
 * A pool, or a client checked out of one for a transaction.
 * @typedef {import('pg').Pool | import('pg').PoolClient} Queryable
 */

/**
 * Create a user, prefilling the display name from the email, and add them to the default groups.
 * Pass a client to run it inside the caller's transaction.
 * @param {Queryable} db
 * @param {string} email
 * @param {string[]} defaultGroups
 * @param {string} [displayName]
 */
export async function createUser(db, email, defaultGroups, displayName) {
  const e = email.trim().toLowerCase();
  const { rows } = await db.query(
    'INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id',
    [e, displayName?.trim() || displayNameFromEmail(e)],
  );
  const id = rows[0].id;
  for (const name of defaultGroups) {
    await db.query(`INSERT INTO groups (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [name]);
    await db.query(
      `INSERT INTO user_groups (user_id, group_id) SELECT $1, id FROM groups WHERE name = $2`,
      [id, name],
    );
  }
  return id;
}

/**
 * End every session, grant, authorization code, access token and refresh token of a user.
 * Every oidc-provider model tied to an account carries `accountId` at the top level of its payload.
 * @param {Queryable} db
 * @param {string} userId
 * @returns {Promise<number>} rows deleted
 */
export async function revokeUserSessions(db, userId) {
  const { rowCount } = await db.query(
    "DELETE FROM oidc_payloads WHERE payload->>'accountId' = $1",
    [userId],
  );
  return rowCount ?? 0;
}

/**
 * Delete a user: end their sessions, then delete the row. Group memberships and admin tokens
 * go with the row (ON DELETE CASCADE). The admin API and the inactivity cleanup both use it.
 * @param {Queryable} db
 * @param {string} userId
 * @returns {Promise<number>} rows deleted (0 or 1)
 */
export async function deleteUserAccount(db, userId) {
  await revokeUserSessions(db, userId);
  const { rowCount } = await db.query('DELETE FROM users WHERE id = $1', [userId]);
  return rowCount ?? 0;
}

/**
 * Create the configured default groups if they do not exist yet. Idempotent.
 * @param {import('pg').Pool} pool
 * @param {string[]} names
 */
export async function ensureDefaultGroups(pool, names) {
  for (const name of names) {
    await pool.query('INSERT INTO groups (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
  }
}

/**
 * Account lookup for oidc-provider's findAccount.
 * @param {import('pg').Pool} pool
 */
export function createFindAccount(pool) {
  return async (/** @type {any} */ _ctx, /** @type {string} */ id) => {
    const user = await loadUser(pool, id);
    if (!user || user.status !== 'active') return undefined;
    return {
      accountId: id,
      async claims() {
        return {
          sub: id,
          email: user.email,
          email_verified: true,
          name: user.display_name,
          groups: user.groups,
        };
      },
    };
  };
}
