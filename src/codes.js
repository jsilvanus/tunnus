import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { decrypt, encrypt } from './oidc/keys.js';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;

/**
 * @param {string} secret
 * @param {string} value
 */
const mac = (secret, value) => createHmac('sha256', secret).update(value).digest('hex');

/**
 * @param {string} a
 * @param {string} b
 */
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * @typedef {{ perEmailPerHour: number, perIpPerHour: number, mailPerDay: number }} Limits
 */

/**
 * Create a code and link token for an interaction, unless a rate limit applies.
 * @param {import('pg').Pool} pool
 * @param {{ secret: string, limits: Limits, email: string, uid: string, ip: string | null, purpose: 'signup' | 'login' }} p
 * @returns {Promise<{ ok: true, code: string, linkToken: string } | { ok: false, reason: 'email' | 'ip' | 'daily' }>}
 */
export async function issueCode(pool, { secret, limits, email, uid, ip, purpose }) {
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE email = $1 AND created_at > now() - interval '1 hour')::int AS by_email,
            count(*) FILTER (WHERE ip = $2 AND created_at > now() - interval '1 hour')::int AS by_ip,
            count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS by_day
       FROM email_codes WHERE created_at > now() - interval '1 day'`,
    [email, ip],
  );
  const r = rows[0];
  if (r.by_email >= limits.perEmailPerHour) return { ok: false, reason: 'email' };
  if (ip && r.by_ip >= limits.perIpPerHour) return { ok: false, reason: 'ip' };
  if (r.by_day >= limits.mailPerDay) return { ok: false, reason: 'daily' };

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const linkToken = randomBytes(32).toString('base64url');
  // A new code replaces any earlier one for the same interaction.
  await pool.query(
    'UPDATE email_codes SET consumed_at = now() WHERE interaction_uid = $1 AND consumed_at IS NULL',
    [uid],
  );
  await pool.query(
    `INSERT INTO email_codes (email, code_hash, code_enc, link_token_hash, purpose, interaction_uid, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + $8 * interval '1 millisecond')`,
    [
      email,
      mac(secret, code),
      encrypt(code, secret),
      mac(secret, linkToken),
      purpose,
      uid,
      ip,
      CODE_TTL_MS,
    ],
  );
  return { ok: true, code, linkToken };
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
  return { ok: true, email: row.email, code: decrypt(row.code_enc, secret) };
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
