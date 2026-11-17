import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { readdirSync } from 'node:fs';
import { createPool, migrate, MIGRATION_LOCK_KEY } from '../src/db.js';

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

      // The lock is released: a fresh session can take it within a few seconds. Advisory locks are
      // database-wide, so other test files may hold it briefly; the retry loop allows for that.
      const probe = new pg.Client({ connectionString: url });
      await probe.connect();
      try {
        const deadline = Date.now() + 5000;
        let acquired = false;
        while (!acquired && Date.now() < deadline) {
          const { rows: got } = await probe.query('SELECT pg_try_advisory_lock($1) AS ok', [
            MIGRATION_LOCK_KEY,
          ]);
          acquired = got[0].ok === true;
          if (!acquired) await new Promise((r) => setTimeout(r, 50));
        }
        expect(acquired).toBe(true);
        await probe.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      } finally {
        await probe.end();
      }
    } finally {
      await pool.end();
    }
  });
});
