/**
 * The account an oidc-provider event is about: the session for an authorization, or the account
 * of the code or refresh token for a token request. Undefined for grants without an account.
 * @param {any} ctx
 * @returns {string | undefined}
 */
export function accountIdOf(ctx) {
  const oidc = ctx?.oidc;
  return (
    oidc?.session?.accountId ??
    oidc?.entities?.AuthorizationCode?.accountId ??
    oidc?.entities?.RefreshToken?.accountId ??
    oidc?.entities?.DeviceCode?.accountId ??
    undefined
  );
}

/**
 * Record activity for an account. The UPDATE is throttled in SQL: `last_login_at` changes at most
 * once an hour, and a warning about inactivity is cleared only with that update.
 * @param {import('pg').Pool} pool
 * @param {string} accountId
 */
export async function touchLastLogin(pool, accountId) {
  await pool.query(
    `UPDATE users SET last_login_at = now(), inactive_warned_at = NULL
      WHERE id = $1 AND (last_login_at IS NULL OR last_login_at < now() - interval '1 hour')`,
    [accountId],
  );
}
