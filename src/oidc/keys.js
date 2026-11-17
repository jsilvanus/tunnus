import {
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  scryptSync,
  randomUUID,
} from 'node:crypto';

/**
 * Advisory lock key for every write to signing_keys. Key changes are serialised under it, so
 * concurrent starts and concurrent rotate/retire calls cannot leave two active or two next keys.
 */
const KEY_LOCK = 7300101;

/**
 * A key is published (in JWKS) when it is active or next, or retired and inside its grace period.
 * `IS TRUE` turns a NULL published_until into "not published".
 */
const PUBLISHED =
  "((status IN ('active', 'next') OR (status = 'retired' AND published_until > now())) IS TRUE)";

/** Published keys in JWKS order. The active key must come first: oidc-provider signs with the first match. */
const PUBLISHED_ORDER =
  "ORDER BY (status = 'active') DESC, (status = 'next') DESC, created_at DESC";

/** Columns for SigningKey rows. Never selects private_jwk. */
const KEY_COLUMNS = `kid, alg, status, created_at, activated_at, retired_at, published_until,
       public_jwk, ${PUBLISHED} AS published`;

/**
 * Error for a key operation the caller got wrong. `code` is one of not_found or key_active.
 */
export class KeyError extends Error {
  /**
   * @param {'not_found' | 'key_active'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'KeyError';
    this.code = code;
  }
}

/**
 * Derived keys per secret. scrypt is deliberately slow, so it runs once per secret, not per call.
 * @type {Map<string, Buffer>}
 */
const derivedKeys = new Map();

/**
 * The AES key for signing_keys, derived with scrypt. The derivation is kept as it was so that
 * existing rows stay decryptable.
 * @param {string} secret
 */
function deriveKey(secret) {
  let key = derivedKeys.get(secret);
  if (!key) {
    key = scryptSync(secret, 'tunnus-signing-keys', 32);
    derivedKeys.set(secret, key);
  }
  return key;
}

/**
 * A 32-byte subkey for one purpose, derived from the secret with HKDF-SHA256. Used for the
 * short-lived email codes, so a different purpose never shares a key with another.
 * @param {string} secret
 * @param {string} purpose
 * @returns {Buffer}
 */
export function deriveSubkey(secret, purpose) {
  return Buffer.from(hkdfSync('sha256', secret, 'tunnus-subkeys', `tunnus:${purpose}:v1`, 32));
}

/**
 * AES-256-GCM encryption with a 32-byte key. Output is base64 of iv, tag and ciphertext.
 * @param {string} plaintext
 * @param {Buffer} key
 */
export function encryptWithKey(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

/**
 * Inverse of encryptWithKey. Throws if the key is wrong or the data was altered.
 * @param {string} encoded
 * @param {Buffer} key
 */
export function decryptWithKey(encoded, key) {
  const buf = Buffer.from(encoded, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

/**
 * Encrypt a signing key (scrypt-derived key from the secret).
 * @param {string} plaintext
 * @param {string} secret
 */
export function encrypt(plaintext, secret) {
  return encryptWithKey(plaintext, deriveKey(secret));
}

/**
 * Decrypt a signing key (scrypt-derived key from the secret).
 * @param {string} encoded
 * @param {string} secret
 */
export function decrypt(encoded, secret) {
  return decryptWithKey(encoded, deriveKey(secret));
}

/**
 * A new RS256 key pair. `priv` is the private JWK (with `d` and the CRT parameters); `pub` is public only.
 * Both carry the same kid.
 * @returns {{ kid: string, priv: Record<string, any>, pub: Record<string, any> }}
 */
export function generateKey() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomUUID();
  const priv = { ...privateKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const pub = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  return { kid, priv, pub };
}

/**
 * Run fn in a transaction that holds the key lock. Every signing_keys write goes through here.
 * @template T
 * @param {import('pg').Pool} pool
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withKeyLock(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [KEY_LOCK]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Insert a new key with the given status and return its kid. The private key is stored encrypted.
 * @param {import('pg').PoolClient} client
 * @param {'active' | 'next'} status
 * @param {string} secret
 * @returns {Promise<string>}
 */
async function insertKey(client, status, secret) {
  const { kid, priv, pub } = generateKey();
  await client.query(
    `INSERT INTO signing_keys (kid, alg, private_jwk, public_jwk, status, created_at, activated_at)
     VALUES ($1, 'RS256', $2, $3, $4, clock_timestamp(), $5::timestamptz)`,
    [
      kid,
      encrypt(JSON.stringify(priv), secret),
      pub,
      status,
      status === 'active' ? new Date().toISOString() : null,
    ],
  );
  return kid;
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string} kid
 */
async function fetchKey(client, kid) {
  const { rows } = await client.query(`SELECT ${KEY_COLUMNS} FROM signing_keys WHERE kid = $1`, [
    kid,
  ]);
  return rows[0];
}

/**
 * Make sure one active and one next key exist, creating whichever is missing. Idempotent, and safe
 * when several processes start at once.
 * @param {import('pg').Pool} pool
 * @param {string} secret
 */
export async function ensureSigningKey(pool, secret) {
  await withKeyLock(pool, async (client) => {
    for (const status of /** @type {const} */ (['active', 'next'])) {
      const { rowCount } = await client.query('SELECT 1 FROM signing_keys WHERE status = $1', [
        status,
      ]);
      if (!rowCount) await insertKey(client, status, secret);
    }
  });
}

/**
 * Private JWKS for oidc-provider: the published keys, active first.
 * @param {import('pg').Pool} pool
 * @param {string} secret
 */
export async function loadJwks(pool, secret) {
  const { rows } = await pool.query(
    `SELECT private_jwk FROM signing_keys WHERE ${PUBLISHED} ${PUBLISHED_ORDER}`,
  );
  return { keys: rows.map((r) => JSON.parse(decrypt(r.private_jwk, secret))) };
}

/**
 * Kids of the keys that loadJwks publishes, in the same order. Used to detect key changes made elsewhere.
 * @param {import('pg').Pool} pool
 * @returns {Promise<string[]>}
 */
export async function publishedKids(pool) {
  const { rows } = await pool.query(
    `SELECT kid FROM signing_keys WHERE ${PUBLISHED} ${PUBLISHED_ORDER}`,
  );
  return rows.map((r) => r.kid);
}

/**
 * Keys newest first. Retired keys whose grace period has ended are left out unless includeUnpublished.
 * @param {import('pg').Pool} pool
 * @param {{ includeUnpublished?: boolean }} [options]
 */
export async function listKeys(pool, { includeUnpublished = false } = {}) {
  const { rows } = await pool.query(
    `SELECT ${KEY_COLUMNS} FROM signing_keys
      WHERE ($1::boolean OR status <> 'retired' OR published_until > now())
      ORDER BY created_at DESC, kid DESC`,
    [includeUnpublished],
  );
  return rows;
}

/**
 * Rotate: the next key becomes active, the old active key is retired and stays published for
 * graceDays, and a new next key is created. With no next key, one is created and promoted, and the
 * warning next_key_missing is returned.
 * @param {import('pg').Pool} pool
 * @param {string} secret
 * @param {number} graceDays
 * @returns {Promise<{ active: Record<string, any>, next: Record<string, any>, retired: Record<string, any>, warnings: string[] }>}
 */
export async function rotateKeys(pool, secret, graceDays) {
  return withKeyLock(pool, async (client) => {
    const { rows: actives } = await client.query(
      "SELECT kid FROM signing_keys WHERE status = 'active' FOR UPDATE",
    );
    if (!actives[0]) throw new Error('no active signing key to rotate');
    const oldActive = actives[0].kid;

    const warnings = [];
    let promoted = await client
      .query(
        "SELECT kid FROM signing_keys WHERE status = 'next' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
      )
      .then((r) => r.rows[0]?.kid);
    if (!promoted) {
      warnings.push('next_key_missing');
      promoted = await insertKey(client, 'next', secret);
    }

    await client.query(
      `UPDATE signing_keys
          SET status = 'retired', retired_at = now(),
              published_until = now() + ($2::int * interval '1 day')
        WHERE kid = $1`,
      [oldActive, graceDays],
    );
    await client.query(
      "UPDATE signing_keys SET status = 'active', activated_at = now() WHERE kid = $1",
      [promoted],
    );
    const newNext = await insertKey(client, 'next', secret);

    return {
      active: await fetchKey(client, promoted),
      next: await fetchKey(client, newNext),
      retired: await fetchKey(client, oldActive),
      warnings,
    };
  });
}

/**
 * Retire one key, removing it from JWKS at the next reload.
 * - retired: the grace period ends now (idempotent).
 * - next: retired unpublished, and a new next key is created in the same transaction.
 * - active: refused with key_active; rotate first.
 * @param {import('pg').Pool} pool
 * @param {string} secret
 * @param {string} kid
 * @returns {Promise<{ row: Record<string, any>, previousStatus: string, newNextKid: string | null }>}
 * @throws {KeyError} not_found or key_active
 */
export async function retireKey(pool, secret, kid) {
  return withKeyLock(pool, async (client) => {
    const { rows } = await client.query(
      'SELECT status FROM signing_keys WHERE kid = $1 FOR UPDATE',
      [kid],
    );
    if (!rows[0]) throw new KeyError('not_found', 'Key not found');
    const previousStatus = /** @type {string} */ (rows[0].status);
    if (previousStatus === 'active') {
      throw new KeyError('key_active', 'The active key cannot be retired; rotate first');
    }

    /** @type {string | null} */
    let newNextKid = null;
    if (previousStatus === 'next') {
      await client.query(
        "UPDATE signing_keys SET status = 'retired', retired_at = now(), published_until = now() WHERE kid = $1",
        [kid],
      );
      newNextKid = await insertKey(client, 'next', secret);
    } else {
      await client.query(
        'UPDATE signing_keys SET published_until = LEAST(published_until, now()) WHERE kid = $1',
        [kid],
      );
    }
    return { row: await fetchKey(client, kid), previousStatus, newNextKid };
  });
}
