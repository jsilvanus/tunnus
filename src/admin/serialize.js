/**
 * Row-to-JSON mapping shared by the admin handlers. Field sets follow the schemas in openapi.yaml.
 */

/**
 * Selects users with their group names, sorted. Add a WHERE clause, then USER_GROUP_BY.
 * Same aggregation as loadUser in accounts.js.
 */
export const USER_SELECT = `WITH RECURSIVE all_group_edges AS (
       SELECT source_group_id, implied_group_id FROM group_implications
       UNION
       SELECT age.source_group_id, gi.implied_group_id
         FROM all_group_edges age
         JOIN group_implications gi ON gi.source_group_id = age.implied_group_id
     ),
     user_effective_groups AS (
       SELECT ug.user_id, ug.group_id FROM user_groups ug
       UNION
       SELECT ug.user_id, age.implied_group_id AS group_id
         FROM user_groups ug
         JOIN all_group_edges age ON age.source_group_id = ug.group_id
     )
     SELECT u.id, u.email, u.display_name, u.title, u.phone_number, u.status, u.is_admin,
       u.created_at, u.last_login_at, u.last_email_verified_at, u.totp_enabled_at,
       u.activates_at, u.disables_at, u.disabled_at,
       COALESCE(array_agg(DISTINCT g.name ORDER BY g.name) FILTER (WHERE g.name IS NOT NULL), '{}') AS groups
  FROM users u
  LEFT JOIN user_effective_groups ueg ON ueg.user_id = u.id
  LEFT JOIN groups g ON g.id = ueg.group_id`;

/** Must follow the WHERE clause of a USER_SELECT query. */
export const USER_GROUP_BY = 'GROUP BY u.id';

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function iso(v) {
  return v ? new Date(/** @type {string | Date} */ (v)).toISOString() : null;
}

/**
 * The User schema.
 * @param {Record<string, any>} row a USER_SELECT row
 */
export function userJson(row) {
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    title: row.title ?? null,
    phone_number: row.phone_number ?? null,
    status: row.status,
    is_admin: row.is_admin,
    created_at: iso(row.created_at),
    last_login_at: iso(row.last_login_at),
    last_email_verified_at: iso(row.last_email_verified_at),
    activates_at: iso(row.activates_at),
    disables_at: iso(row.disables_at),
    disabled_at: iso(row.disabled_at),
    totp_enabled: Boolean(row.totp_enabled_at),
    groups: [...row.groups],
  };
}

/**
 * The AdminToken schema. Never includes the token value.
 * @param {Record<string, any>} row
 */
export function tokenJson(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    label: row.label,
    created_at: iso(row.created_at),
    created_by: row.created_by ?? null,
    expires_at: iso(row.expires_at),
    last_used_at: iso(row.last_used_at),
    revoked_at: iso(row.revoked_at),
    identity_mode: row.identity_mode ?? 'open',
  };
}

/**
 * The Group schema. `is_default` comes from configuration, not from the database.
 * @param {Record<string, any>} row a group row with member_count
 * @param {string[]} defaultGroups
 */
export function groupJson(row, defaultGroups) {
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description,
    is_default: defaultGroups.includes(row.name),
    member_count: Number(row.member_count),
  };
}

/**
 * The Membership schema. Expects a row from the membership query in handlers/groups.js.
 * @param {Record<string, any>} row
 */
export function membershipJson(row) {
  return {
    user_id: row.user_id,
    email: row.email,
    display_name: row.display_name,
    group_id: Number(row.group_id),
    group_name: row.group_name,
    granted_by: row.granted_by ?? null,
    granted_at: iso(row.granted_at),
  };
}
