/**
 * Helpers shared by the user and group handlers.
 */
import { AdminError } from './errors.js';
import { decodeCursor } from './paging.js';

/** @param {string} message */
export const notFound = (message) => new AdminError(404, 'not_found', message);

/** @param {string} message */
export const conflict = (message) => new AdminError(409, 'conflict', message);

/**
 * The sort-key field of an opaque cursor, which must be a string.
 * @param {string} cursor
 * @param {string} field
 * @returns {string}
 * @throws {AdminError} 400 when the cursor carries no such field
 */
export function cursorField(cursor, field) {
  const value = decodeCursor(cursor)[field];
  if (typeof value !== 'string') {
    throw new AdminError(400, 'invalid_request', 'Invalid request', [
      { path: '/cursor', message: 'not a valid cursor' },
    ]);
  }
  return value;
}

/**
 * Escape LIKE wildcards so that user input matches literally.
 * @param {string} text
 */
export function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** @param {unknown} err */
function errorCode(err) {
  return typeof err === 'object' && err !== null
    ? /** @type {{ code?: unknown }} */ (err).code
    : undefined;
}

/** @param {unknown} err */
export const isUniqueViolation = (err) => errorCode(err) === '23505';

/** @param {unknown} err */
export const isForeignKeyViolation = (err) => errorCode(err) === '23503';

/**
 * Run `fn` in a transaction on one pooled client. Any error rolls back and is rethrown unchanged.
 * @template T
 * @param {import('pg').Pool} pool
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function inTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
 * Resolve a group reference (integer id or name) to a group row ({ id, name }).
 * @param {any} db
 * @param {string | number} ref
 * @returns {Promise<{ id: number, name: string }>}
 */
export async function resolveGroup(db, ref) {
  const str = String(ref).trim();
  if (/^\d+$/.test(str)) {
    const { rows } = await db.query('SELECT id, name FROM groups WHERE id = $1', [Number(str)]);
    if (rows[0]) return { id: Number(rows[0].id), name: rows[0].name };
  }
  const { rows } = await db.query('SELECT id, name FROM groups WHERE name = $1', [str]);
  if (rows[0]) return { id: Number(rows[0].id), name: rows[0].name };
  throw notFound(`Group not found: ${ref}`);
}

/**
 * Resolve a user reference (UUID or email address) to a user row ({ id, email }).
 * @param {any} db
 * @param {string} ref
 * @returns {Promise<{ id: string, email: string }>}
 */
export async function resolveUser(db, ref) {
  const str = String(ref).trim();
  if (str.includes('@')) {
    const { rows } = await db.query('SELECT id, email FROM users WHERE email = $1', [
      str.toLowerCase(),
    ]);
    if (rows[0]) return { id: String(rows[0].id), email: rows[0].email };
  } else {
    const { rows } = await db.query('SELECT id, email FROM users WHERE id = $1', [str]);
    if (rows[0]) return { id: String(rows[0].id), email: rows[0].email };
    const byEmail = await db.query('SELECT id, email FROM users WHERE email = $1', [
      str.toLowerCase(),
    ]);
    if (byEmail.rows[0]) return { id: String(byEmail.rows[0].id), email: byEmail.rows[0].email };
  }
  throw notFound(`User not found: ${ref}`);
}
