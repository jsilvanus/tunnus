import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

/**
 * @param {string} connectionString
 * @param {string} [schema] optional search_path, used by tests
 */
export function createPool(connectionString, schema) {
  return new pg.Pool({
    connectionString,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
}

/**
 * Apply SQL files from the migrations directory that have not run yet.
 * @param {pg.Pool} pool
 * @param {URL} [dir]
 */
export async function migrate(pool, dir = new URL('../migrations/', import.meta.url)) {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const done = new Set(
    (await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (done.has(name)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(readFileSync(new URL(name, dir), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
