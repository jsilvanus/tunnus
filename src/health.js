import { readFileSync } from 'node:fs';
import express from 'express';

/** Package version, read the same way as the MCP server does. */
export const PACKAGE_VERSION = /** @type {string} */ (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
);

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {import('pg').Pool} pool
 * @param {number} timeoutMs
 * @returns {Promise<'ok' | 'fail'>}
 */
async function checkDatabase(pool, timeoutMs) {
  try {
    await withTimeout(pool.query('SELECT 1'), timeoutMs);
    return 'ok';
  } catch {
    return 'fail';
  }
}

/**
 * An active key must exist. A missing next key is not a failure.
 * @param {import('pg').Pool} pool
 * @param {number} timeoutMs
 * @returns {Promise<'ok' | 'missing' | 'fail'>}
 */
async function checkSigningKey(pool, timeoutMs) {
  try {
    const { rows } = await withTimeout(
      pool.query("SELECT 1 FROM signing_keys WHERE status = 'active' LIMIT 1"),
      timeoutMs,
    );
    return rows.length > 0 ? 'ok' : 'missing';
  } catch {
    return 'fail';
  }
}

/**
 * Public liveness and readiness endpoint. Reports no error messages or counts.
 * @param {{ pool: import('pg').Pool, version?: string, timeoutMs?: number }} options
 */
export function createHealthRouter({ pool, version = PACKAGE_VERSION, timeoutMs = 2000 }) {
  const router = express.Router();
  router.get('/health', async (_req, res) => {
    const [database, signingKey] = await Promise.all([
      checkDatabase(pool, timeoutMs),
      checkSigningKey(pool, timeoutMs),
    ]);
    const ok = database === 'ok' && signingKey === 'ok';
    res
      .set('Cache-Control', 'no-store')
      .status(ok ? 200 : 503)
      .json({
        status: ok ? 'ok' : 'fail',
        version,
        checks: { database, signing_key: signingKey },
      });
  });
  return router;
}
