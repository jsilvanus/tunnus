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
 * Create a user, prefilling the display name from the email, and add them to the default groups.
 * @param {import('pg').Pool} pool
 * @param {string} email
 * @param {string[]} defaultGroups
 * @param {string} [displayName]
 */
export async function createUser(pool, email, defaultGroups, displayName) {
  const e = email.trim().toLowerCase();
  const { rows } = await pool.query(
    'INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id',
    [e, displayName?.trim() || displayNameFromEmail(e)],
  );
  const id = rows[0].id;
  for (const name of defaultGroups) {
    await pool.query(`INSERT INTO groups (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [name]);
    await pool.query(
      `INSERT INTO user_groups (user_id, group_id) SELECT $1, id FROM groups WHERE name = $2`,
      [id, name],
    );
  }
  return id;
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
