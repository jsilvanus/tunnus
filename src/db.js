import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

/** Session-level advisory lock for migrations. A constant key, distinct from the key and cleanup locks. */
export const MIGRATION_LOCK_KEY = 7300201;

/**
 * DB_POOL_MAX: a positive integer, default 10.
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
function poolMax(env) {
  const raw = env.DB_POOL_MAX;
  if (raw === undefined || raw === '') return 10;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error('DB_POOL_MAX must be a positive integer');
  return n;
}

/**
 * Create the pool. An error on an idle client (for example a database restart) is logged, not
 * thrown, so it does not end the process.
 * @param {string} connectionString
 * @param {string} [schema] optional search_path, used by tests
 * @param {NodeJS.ProcessEnv} [env]
 */
export function createPool(connectionString, schema, env = process.env) {
  const pool = new pg.Pool({
    connectionString,
    max: poolMax(env),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 30000,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
  pool.on('error', (err) => {
    console.error('database pool error on an idle client', err.message);
  });
  return pool;
}

/**
 * Apply SQL files from the migrations directory that have not run yet. The whole run holds a
 * session-level advisory lock, so concurrent starts run one after another, and the applied set is
 * read only after the lock is taken.
 * @param {pg.Pool} pool
 * @param {URL} [dir]
 */
export async function migrate(pool, dir = new URL('../migrations/', import.meta.url)) {
  const client = await pool.connect();
  // If the lock cannot be released, the connection is destroyed instead of being reused with the lock.
  let broken = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const done = new Set(
        (await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
      );
      for (const name of readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort()) {
        if (done.has(name)) continue;
        await client.query('BEGIN');
        try {
          await client.query(readFileSync(new URL(name, dir), 'utf8'));
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {
        broken = true;
      });
    }
  } finally {
    client.release(broken ? new Error('migration lock could not be released') : undefined);
  }
}
