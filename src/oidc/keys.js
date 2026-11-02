import {
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  randomUUID,
} from 'node:crypto';

/** @param {string} secret */
function deriveKey(secret) {
  return scryptSync(secret, 'tunnus-signing-keys', 32);
}

/**
 * @param {string} plaintext
 * @param {string} secret
 */
export function encrypt(plaintext, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

/**
 * @param {string} encoded
 * @param {string} secret
 */
export function decrypt(encoded, secret) {
  const buf = Buffer.from(encoded, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

/**
 * Create the first RS256 signing key if none is active.
 * @param {import('pg').Pool} pool
 * @param {string} secret
 */
export async function ensureSigningKey(pool, secret) {
  const { rowCount } = await pool.query("SELECT 1 FROM signing_keys WHERE status = 'active'");
  if (rowCount) return;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomUUID();
  const priv = { ...privateKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const pub = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  await pool.query(
    "INSERT INTO signing_keys (kid, alg, private_jwk, public_jwk, status, activated_at) VALUES ($1, 'RS256', $2, $3, 'active', now())",
    [kid, encrypt(JSON.stringify(priv), secret), pub],
  );
}

/**
 * Private JWKS for oidc-provider: the active key first, then retired/next keys.
 * @param {import('pg').Pool} pool
 * @param {string} secret
 */
export async function loadJwks(pool, secret) {
  const { rows } = await pool.query(
    "SELECT private_jwk FROM signing_keys ORDER BY (status = 'active') DESC, created_at DESC",
  );
  return { keys: rows.map((r) => JSON.parse(decrypt(r.private_jwk, secret))) };
}
