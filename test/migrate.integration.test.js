import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { readdirSync } from 'node:fs';
import { createPool, migrate } from '../src/db.js';

describe('migrate under concurrency', () => {
  it('two runs at once both finish and apply each migration once', async () => {
    const schema = 'tunnus_migrate_race_test';
    const url = /** @type {string} */ (process.env.DATABASE_URL);
    const admin = new pg.Pool({ connectionString: url });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
    await admin.end();

    const pool = createPool(url, schema);
    try {
      await Promise.all([migrate(pool), migrate(pool)]);
      const { rows } = await pool.query('SELECT name FROM schema_migrations ORDER BY name');
      const files = readdirSync(new URL('../migrations/', import.meta.url))
        .filter((f) => f.endsWith('.sql'))
        .sort();
      expect(rows.map((r) => r.name)).toEqual(files);

      // The lock is released: a later run finds nothing to do and returns.
      await migrate(pool);
      const { rows: locks } = await pool.query(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted",
      );
      expect(locks[0].n).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
