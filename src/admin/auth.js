import { audit } from '../audit.js';
import { errorFields, logger } from '../logger.js';

import { findActiveToken, TOKEN_PATTERN } from '../adminTokens.js';
import { sendError } from './errors.js';

/**
 * Bearer-token middleware for the admin API. Sets `req.admin` on success.
 * Failures are audited as `admin.auth_failed` with a reason. An IP with more than `failureLimit`
 * failures in `windowMs` gets 429 (not audited) for requests without a valid token; a valid token
 * is always accepted.
 * @param {{
 *   pool: import('pg').Pool,
 *   failureLimit?: number,
 *   windowMs?: number,
 *   verifyOAuthToken?: (token: string) => Promise<{ ok: true, sub: string } | { ok: false, reason: string }>,
 * }} deps
 * @returns {import('express').RequestHandler}
 */
export function createAdminAuth({
  pool,
  failureLimit = 20,
  windowMs = 10 * 60 * 1000,
  verifyOAuthToken,
}) {
  /** @type {Map<string, number[]>} */
  const failures = new Map();

  /**
   * Failure timestamps for a key within the window.
   * @param {string} key
   * @param {number} now
   */
  function recent(key, now) {
    const kept = (failures.get(key) ?? []).filter((t) => now - t < windowMs);
    if (kept.length) failures.set(key, kept);
    else failures.delete(key);
    return kept;
  }

  return async function adminAuth(req, res, next) {
    const ip = req.ip ?? null;
    const key = ip ?? 'unknown';
    try {
      // The token is checked first: a valid token is accepted even from an IP over the limit.
      // The limit only refuses requests whose token is missing or invalid.
      /** @param {string} reason */
      const fail = async (reason) => {
        if (recent(key, Date.now()).length > failureLimit) {
          return void sendError(
            res,
            429,
            'rate_limited',
            'Too many failed attempts; try again later',
          );
        }
        failures.set(key, [...recent(key, Date.now()), Date.now()]);
        await audit(pool, { action: 'admin.auth_failed', ip, details: { reason } });
        res.set('WWW-Authenticate', 'Bearer');
        sendError(res, 401, 'unauthorized', 'Missing or invalid admin token');
      };

      const header = req.headers.authorization;
      if (header === undefined) return void (await fail('missing'));
      const match = /^Bearer\s+(\S+)$/i.exec(header);
      const value = match?.[1];
      if (!value) return void (await fail('malformed'));

      if (TOKEN_PATTERN.test(value)) {
        const found = await findActiveToken(pool, value);
        if (!found.ok) return void (await fail(found.reason));

        await pool.query(
          `UPDATE admin_tokens SET last_used_at = now()
            WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
          [found.token.id],
        );
        /** @type {any} */ (req).admin = {
          userId: found.user.id,
          tokenId: found.token.id,
          token: found.token,
          user: found.user,
        };
        return void next();
      }

      if (!verifyOAuthToken || !value.includes('.')) return void (await fail('malformed'));

      const verified = await verifyOAuthToken(value);
      if (!verified.ok) return void (await fail(verified.reason));

      const { rows } = await pool.query(
        'SELECT id, email, display_name, status, is_admin FROM users WHERE id = $1',
        [verified.sub],
      );
      const user = rows[0];
      if (!user) return void (await fail('unknown'));
      if (user.status !== 'active') return void (await fail('disabled'));
      if (!user.is_admin) return void (await fail('not_admin'));

      /** @type {any} */ (req).admin = {
        userId: user.id,
        tokenId: null,
        token: null,
        user,
      };
      next();
    } catch (err) {
      logger.error({ err: errorFields(err) }, 'admin auth failed unexpectedly');
      sendError(res, 500, 'internal', 'Internal error');
    }
  };
}
