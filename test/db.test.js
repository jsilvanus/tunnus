import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPool } from '../src/db.js';
import { logger } from '../src/logger.js';

/** @type {import('pg').Pool[]} */
const pools = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(pools.splice(0).map((p) => p.end()));
});

/** @param {string} [schema] @param {NodeJS.ProcessEnv} [env] */
const make = (schema, env = {}) => {
  const pool = createPool('postgres://user:pw@127.0.0.1:1/db', schema, env);
  pools.push(pool);
  return pool;
};

describe('createPool', () => {
  it('uses the documented pool limits and timeouts', () => {
    const pool = make();
    expect(pool.options).toMatchObject({
      max: 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      statement_timeout: 30000,
    });
  });

  it('reads DB_POOL_MAX and rejects a bad value', () => {
    expect(make(undefined, { DB_POOL_MAX: '4' }).options.max).toBe(4);
    expect(() => make(undefined, { DB_POOL_MAX: '0' })).toThrow('DB_POOL_MAX');
    expect(() => make(undefined, { DB_POOL_MAX: 'many' })).toThrow('DB_POOL_MAX');
  });

  it('keeps the optional schema as search_path', () => {
    expect(make('tunnus_test').options.options).toBe('-c search_path=tunnus_test');
    expect(make().options.options).toBeUndefined();
  });

  it('attaches an error handler that logs and does not throw', () => {
    const pool = make();
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
    const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
    expect(() => pool.emit('error', new Error('terminating connection'))).not.toThrow();
    expect(log).toHaveBeenCalledWith(
      { err: expect.objectContaining({ name: 'Error' }) },
      'database pool error on an idle client',
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('terminating connection');
  });
});
