import { describe, it, expect } from 'vitest';
import pg from 'pg';

describe('database', () => {
  it('connects', async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const r = await client.query('select 1 as ok');
    await client.end();
    expect(r.rows[0].ok).toBe(1);
  });
});
