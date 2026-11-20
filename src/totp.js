import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { decryptWithKey, deriveSubkey, encryptWithKey } from './oidc/keys.js';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;
export const TOTP_MAX_ATTEMPTS = 5;
export const TOTP_LOCK_MS = 60 * 60 * 1000;
export const CHALLENGE_TTL_MS = 10 * 60 * 1000;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DAY_MS = 86_400_000;

/** @param {string} secret */
const encKey = (secret) => deriveSubkey(secret, 'totp-encrypt');

/**
 * @param {Buffer} buf
 * @returns {string}
 */
export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/**
 * @param {string} input
 * @returns {Buffer}
 */
export function base32Decode(input) {
  const clean = input.trim().replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Generate a 160-bit TOTP secret.
 * @returns {{ raw: Buffer, base32: string }}
 */
export function generateTotpSecret() {
  const raw = randomBytes(20);
  return { raw, base32: base32Encode(raw) };
}

/**
 * RFC 4226 HOTP with HMAC-SHA1 and 6 digits.
 * @param {Buffer} secret
 * @param {number} counter
 * @returns {string}
 */
export function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * RFC 6238 TOTP code for a given timestamp in milliseconds.
 * @param {Buffer} secret
 * @param {number} [nowMs]
 * @returns {string}
 */
export function totpCode(secret, nowMs = Date.now()) {
  const step = Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
  return hotp(secret, step);
}

/**
 * Verify a 6-digit TOTP token with clock-skew tolerance and replay protection.
 * @param {Buffer} secret
 * @param {string} token
 * @param {{ nowMs?: number, lastStep?: number | null, window?: number }} [opts]
 * @returns {{ ok: true, step: number } | { ok: false, reason: 'invalid' | 'replayed' }}
 */
export function verifyTotpToken(secret, token, opts = {}) {
  const clean = token.trim();
  if (!/^\d{6}$/.test(clean)) return { ok: false, reason: 'invalid' };
  const nowMs = opts.nowMs ?? Date.now();
  const win = opts.window ?? TOTP_WINDOW;
  const currentStep = Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
  const tokenBuf = Buffer.from(clean);

  let matchedStep = null;
  for (let delta = -win; delta <= win; delta++) {
    const step = currentStep + delta;
    if (step < 0) continue;
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(tokenBuf, expected)) {
      matchedStep = step;
    }
  }
  if (matchedStep === null) return { ok: false, reason: 'invalid' };
  if (
    opts.lastStep !== null &&
    opts.lastStep !== undefined &&
    matchedStep <= Number(opts.lastStep)
  ) {
    return { ok: false, reason: 'replayed' };
  }
  return { ok: true, step: matchedStep };
}

/**
 * @param {{ secretBase32: string, email: string, issuer: string }} p
 * @returns {string}
 */
export function buildOtpAuthUri({ secretBase32, email, issuer }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(email)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * @param {string} secretBase32
 * @param {string} keyEncryptionSecret
 * @returns {string}
 */
export function encryptTotpSecret(secretBase32, keyEncryptionSecret) {
  return encryptWithKey(secretBase32, encKey(keyEncryptionSecret));
}

/**
 * @param {string} encrypted
 * @param {string} keyEncryptionSecret
 * @returns {string}
 */
export function decryptTotpSecret(encrypted, keyEncryptionSecret) {
  return decryptWithKey(encrypted, encKey(keyEncryptionSecret));
}

/**
 * True when the user can sign in with TOTP without needing an email code first.
 * @param {{
 *   status?: string,
 *   totp_enabled_at?: string | Date | null,
 *   totp_secret_enc?: string | null,
 *   totp_locked_until?: string | Date | null,
 *   last_email_verified_at?: string | Date | null,
 * } | null | undefined} user
 * @param {{ reverifyDays: number, nowMs?: number }} opts
 * @returns {boolean}
 */
export function isTotpEligible(user, { reverifyDays, nowMs = Date.now() }) {
  if (!user || user.status !== 'active') return false;
  if (!user.totp_enabled_at || !user.totp_secret_enc) return false;
  if (user.totp_locked_until && new Date(user.totp_locked_until).getTime() > nowMs) return false;
  if (reverifyDays > 0) {
    if (!user.last_email_verified_at) return false;
    const ageMs = nowMs - new Date(user.last_email_verified_at).getTime();
    if (ageMs >= reverifyDays * DAY_MS) return false;
  }
  return true;
}

/**
 * Verify a user's TOTP code atomically, updating replay step and lockout counters.
 * @param {import('pg').Pool} pool
 * @param {{ secret: string, email: string, code: string, reverifyDays: number, nowMs?: number }} p
 * @returns {Promise<
 *   | { ok: true, userId: string }
 *   | { ok: false, reason: 'not_eligible' }
 *   | { ok: false, reason: 'invalid' | 'replayed', locked: boolean, userId: string }
 * >}
 */
export async function verifyUserTotp(
  pool,
  { secret, email, code, reverifyDays, nowMs = Date.now() },
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, status, totp_secret_enc, totp_enabled_at, totp_last_step,
              totp_failed_attempts, totp_locked_until, last_email_verified_at
         FROM users
        WHERE email = $1
        FOR UPDATE`,
      [email.trim().toLowerCase()],
    );
    const user = rows[0];
    if (!isTotpEligible(user, { reverifyDays, nowMs })) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_eligible' };
    }
    const secretBuf = base32Decode(decryptTotpSecret(user.totp_secret_enc, secret));
    const check = verifyTotpToken(secretBuf, code, {
      nowMs,
      lastStep: user.totp_last_step !== null ? Number(user.totp_last_step) : null,
    });
    if (check.ok) {
      await client.query(
        `UPDATE users
            SET totp_last_step = $2,
                totp_failed_attempts = 0,
                totp_locked_until = NULL
          WHERE id = $1`,
        [user.id, check.step],
      );
      await client.query('COMMIT');
      return { ok: true, userId: user.id };
    }
    const attempts = Number(user.totp_failed_attempts ?? 0) + 1;
    const locked = attempts >= TOTP_MAX_ATTEMPTS;
    await client.query(
      `UPDATE users
          SET totp_failed_attempts = $2,
              totp_locked_until = CASE WHEN $3 THEN $4 ELSE totp_locked_until END
        WHERE id = $1`,
      [user.id, attempts, locked, new Date(nowMs + TOTP_LOCK_MS)],
    );
    await client.query('COMMIT');
    return { ok: false, reason: check.reason, locked, userId: user.id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Record the email address bound to an interaction so TOTP / resend know which account to check.
 * @param {import('pg').Pool} pool
 * @param {string} uid
 * @param {string} email
 */
export async function saveLoginChallenge(pool, uid, email) {
  await pool.query(
    `INSERT INTO login_challenges (interaction_uid, email, expires_at)
     VALUES ($1, $2, now() + $3 * interval '1 millisecond')
     ON CONFLICT (interaction_uid) DO UPDATE
       SET email = EXCLUDED.email, expires_at = EXCLUDED.expires_at`,
    [uid, email.trim().toLowerCase(), CHALLENGE_TTL_MS],
  );
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} uid
 * @returns {Promise<string | null>}
 */
export async function getLoginChallenge(pool, uid) {
  const { rows } = await pool.query(
    'SELECT email FROM login_challenges WHERE interaction_uid = $1 AND expires_at > now()',
    [uid],
  );
  return rows[0]?.email ?? null;
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} uid
 */
export async function deleteLoginChallenge(pool, uid) {
  await pool.query('DELETE FROM login_challenges WHERE interaction_uid = $1', [uid]);
}
