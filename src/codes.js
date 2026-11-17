import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { decryptWithKey, deriveSubkey, encryptWithKey } from './oidc/keys.js';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;

/**
 * Subkeys for email codes, one per purpose (HKDF from KEY_ENCRYPTION_SECRET). Codes are short
 * lived, so they can be invalidated without a data migration.
 * @param {string} secret
 */
const macKey = (secret) => deriveSubkey(secret, 'email-code-hmac');
/** @param {string} secret */
const encKey = (secret) => deriveSubkey(secret, 'email-code-encrypt');

/**
 * @param {string} secret
 * @param {string} value
 */
const mac = (secret, value) => createHmac('sha256', macKey(secret)).update(value).digest('hex');

/**
 * @param {string} a
 * @param {string} b
 */
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * @typedef {{ perEmailPerHour: number, perIpPerHour: number, mailPerDay: number }} Limits
 */

/** Failed attempts (summed over an address's codes) that lock the address for an hour. */
export const FAILED_ATTEMPTS_PER_HOUR = 10;
/** Sign-in (login) codes may go on until this multiple of MAIL_DAILY_CAP, so sign-ups alone cannot exhaust them. */
export const LOGIN_CAP_FACTOR = 1.5;
/** Advisory lock key for the global daily count. Taken after the per-email lock, always in that order. */
export const CODE_DAILY_LOCK_KEY = 7300301;

/**
 * Create a code and link token for an interaction, unless a rate limit applies.
 *
 * The check and the insert run in one transaction. A transaction-scoped advisory lock per
 * address serialises concurrent requests for one address, and a second lock serialises the
 * daily count, so concurrent requests cannot go past a limit.
 *
 * Limits: per address per hour (`email`), failed attempts per address in the last hour
 * (`email`, the lockout), per IP per hour (`ip`), and the daily cap (`daily`). Sign-up codes
 * stop at MAIL_DAILY_CAP; login codes stop at LOGIN_CAP_FACTOR times that.
 * @param {import('pg').Pool} pool
 * @param {{ secret: string, limits: Limits, email: string, uid: string, ip: string | null, purpose: 'signup' | 'login' }} p
 * @returns {Promise<{ ok: true, code: string, linkToken: string } | { ok: false, reason: 'email' | 'ip' | 'daily' }>}
 */
export async function issueCode(pool, { secret, limits, email, uid, ip, purpose }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [email]);
    await client.query('SELECT pg_advisory_xact_lock($1)', [CODE_DAILY_LOCK_KEY]);
    const { rows } = await client.query(
      `SELECT count(*) FILTER (WHERE email = $1 AND created_at > now() - interval '1 hour')::int AS by_email,
              coalesce(sum(attempts) FILTER (WHERE email = $1 AND created_at > now() - interval '1 hour'), 0)::int AS failed_by_email,
              count(*) FILTER (WHERE ip = $2 AND created_at > now() - interval '1 hour')::int AS by_ip,
              count(*)::int AS by_day
         FROM email_codes WHERE created_at > now() - interval '1 day'`,
      [email, ip],
    );
    const r = rows[0];
    const refused = refusal(r, { limits, ip, purpose });
    if (refused) {
      await client.query('ROLLBACK');
      return { ok: false, reason: refused };
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const linkToken = randomBytes(32).toString('base64url');
    // A new code replaces any earlier one for the same interaction.
    await client.query(
      'UPDATE email_codes SET consumed_at = now() WHERE interaction_uid = $1 AND consumed_at IS NULL',
      [uid],
    );
    await client.query(
      `INSERT INTO email_codes (email, code_hash, code_enc, link_token_hash, purpose, interaction_uid, ip, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + $8 * interval '1 millisecond')`,
      [
        email,
        mac(secret, code),
        encryptWithKey(code, encKey(secret)),
        mac(secret, linkToken),
        purpose,
        uid,
        ip,
        CODE_TTL_MS,
      ],
    );
    await client.query('COMMIT');
    return { ok: true, code, linkToken };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Which limit, if any, refuses a new code. Pure: the counts come from issueCode's query.
 * @param {{ by_email: number, failed_by_email: number, by_ip: number, by_day: number }} r
 * @param {{ limits: Limits, ip: string | null, purpose: 'signup' | 'login' }} p
 * @returns {'email' | 'ip' | 'daily' | null}
 */
export function refusal(r, { limits, ip, purpose }) {
  if (r.failed_by_email >= FAILED_ATTEMPTS_PER_HOUR) return 'email';
  if (r.by_email >= limits.perEmailPerHour) return 'email';
  if (ip && r.by_ip >= limits.perIpPerHour) return 'ip';
  const dailyMax =
    purpose === 'login' ? Math.floor(limits.mailPerDay * LOGIN_CAP_FACTOR) : limits.mailPerDay;
  if (r.by_day >= dailyMax) return 'daily';
  return null;
}

/**
 * Count one attempt on the live code of an interaction and return it.
 * @param {import('pg').Pool} pool
 * @param {string} uid
 */
async function attempt(pool, uid) {
  const { rows } = await pool.query(
    `UPDATE email_codes SET attempts = attempts + 1
      WHERE id = (SELECT id FROM email_codes WHERE interaction_uid = $1 AND consumed_at IS NULL
                    AND verified_at IS NULL AND expires_at > now() ORDER BY id DESC LIMIT 1)
        AND attempts < $2
      RETURNING *`,
    [uid, MAX_ATTEMPTS],
  );
  return rows[0];
}

/**
 * Check a typed code. A wrong code counts against the attempt limit.
 * @param {import('pg').Pool} pool
 * @param {string} secret
 * @param {string} uid
 * @param {string} code
 * @returns {Promise<{ ok: true, email: string } | { ok: false, locked: boolean }>}
 */
export async function verifyCode(pool, secret, uid, code) {
  const row = await attempt(pool, uid);
  if (!row) return { ok: false, locked: true };
  if (!same(mac(secret, code.trim()), row.code_hash))
    return { ok: false, locked: row.attempts >= MAX_ATTEMPTS };
  await pool.query('UPDATE email_codes SET verified_at = now() WHERE id = $1', [row.id]);
  return { ok: true, email: row.email };
}

/**
 * Check a link token (same attempt counting as a code).
 * @param {import('pg').Pool} pool
 * @param {string} secret
 * @param {string} uid
 * @param {string} token
 * @param {{ consume: boolean }} opts consume=false only checks the token and returns the code
 * @returns {Promise<{ ok: true, email: string, code: string } | { ok: false }>}
 */
export async function verifyLink(pool, secret, uid, token, { consume }) {
  const row = await attempt(pool, uid);
  if (!row || !same(mac(secret, token), row.link_token_hash)) return { ok: false };
  if (consume)
    await pool.query('UPDATE email_codes SET verified_at = now() WHERE id = $1', [row.id]);
  else await pool.query('UPDATE email_codes SET attempts = attempts - 1 WHERE id = $1', [row.id]);
  return { ok: true, email: row.email, code: decryptWithKey(row.code_enc, encKey(secret)) };
}

/**
 * The verified, unused code of an interaction (the email that proved ownership).
 * @param {import('pg').Pool} pool
 * @param {string} uid
 * @returns {Promise<{ id: string, email: string } | undefined>}
 */
export async function getVerified(pool, uid) {
  const { rows } = await pool.query(
    `SELECT id, email FROM email_codes WHERE interaction_uid = $1 AND verified_at IS NOT NULL
        AND consumed_at IS NULL AND expires_at > now() ORDER BY id DESC LIMIT 1`,
    [uid],
  );
  return rows[0];
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} id
 */
export async function consume(pool, id) {
  await pool.query('UPDATE email_codes SET consumed_at = now() WHERE id = $1', [id]);
}
