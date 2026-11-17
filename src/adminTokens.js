import { createHash, randomBytes } from 'node:crypto';

/** Format of an admin token: `tun_` and 43 base64url characters (32 random bytes). */
export const TOKEN_PATTERN = /^tun_[A-Za-z0-9_-]{43}$/;

/** @returns {string} */
export function generateToken() {
  return `tun_${randomBytes(32).toString('base64url')}`;
}

/**
 * Tokens are stored only as a SHA-256 hash. They are high-entropy, so no salt or slow hash is needed.
 * @param {string} value
 * @returns {string}
 */
export function hashToken(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Create a token for a user. The plain value is returned once and never stored.
 * @param {import('pg').Pool} pool
 * @param {{ userId: string, label: string, expiresInDays?: number, createdBy?: string | null }} input
 * @returns {Promise<{ row: Record<string, any>, token: string }>}
 */
export async function createAdminToken(
  pool,
  { userId, label, expiresInDays = 90, createdBy = null },
) {
  const token = generateToken();
  const { rows } = await pool.query(
    `INSERT INTO admin_tokens (user_id, token_hash, label, created_by, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))
     RETURNING id, user_id, label, created_at, created_by, expires_at, last_used_at, revoked_at`,
    [userId, hashToken(token), label, createdBy, expiresInDays],
  );
  return { row: rows[0], token };
}

/**
 * The token row and its user, with validity flags computed by the database clock.
 * @param {import('pg').Pool} pool
 * @param {string} value
 */
export async function findTokenByValue(pool, value) {
  const { rows } = await pool.query(
    `SELECT t.id, t.user_id, t.label, t.created_at, t.created_by, t.expires_at,
            t.last_used_at, t.revoked_at,
            (t.revoked_at IS NOT NULL) AS revoked,
            (t.expires_at <= now()) AS expired,
            u.email, u.display_name, u.status, u.is_admin
       FROM admin_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1`,
    [hashToken(value)],
  );
  return rows[0];
}

/**
 * Check a presented token. A token is valid when it is not revoked or expired, and its user is
 * active and still an admin. Checked on every request, so disabling or demoting cuts access at once.
 * @param {import('pg').Pool} pool
 * @param {string} value
 * @returns {Promise<
 *   | { ok: true, token: Record<string, any>, user: { id: string, email: string, display_name: string, status: string, is_admin: boolean } }
 *   | { ok: false, reason: 'unknown' | 'revoked' | 'expired' | 'disabled' | 'not_admin' }
 * >}
 */
export async function findActiveToken(pool, value) {
  const row = await findTokenByValue(pool, value);
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.revoked) return { ok: false, reason: 'revoked' };
  if (row.expired) return { ok: false, reason: 'expired' };
  if (row.status !== 'active') return { ok: false, reason: 'disabled' };
  if (!row.is_admin) return { ok: false, reason: 'not_admin' };
  return {
    ok: true,
    token: {
      id: row.id,
      user_id: row.user_id,
      label: row.label,
      created_at: row.created_at,
      created_by: row.created_by,
      expires_at: row.expires_at,
      last_used_at: row.last_used_at,
      revoked_at: row.revoked_at,
    },
    user: {
      id: row.user_id,
      email: row.email,
      display_name: row.display_name,
      status: row.status,
      is_admin: row.is_admin,
    },
  };
}
