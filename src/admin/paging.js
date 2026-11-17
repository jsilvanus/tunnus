import { AdminError } from './errors.js';

/**
 * Encode a cursor: base64url of the JSON sort key of the last row returned.
 * @param {Record<string, unknown>} obj
 * @returns {string}
 */
export function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

/**
 * Decode a cursor produced by encodeCursor.
 * @param {string} str
 * @returns {Record<string, any>}
 * @throws {AdminError} 400 invalid_request when the cursor is not one we issued
 */
export function decodeCursor(str) {
  /** @type {unknown} */
  let obj;
  try {
    obj = JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));
  } catch {
    obj = undefined;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new AdminError(400, 'invalid_request', 'Invalid request', [
      { path: '/cursor', message: 'not a valid cursor' },
    ]);
  }
  return /** @type {Record<string, any>} */ (obj);
}

/**
 * Shape one page. The caller fetched `limit + 1` rows; the extra row only signals that a next page exists.
 * `keyOf` returns the JSON-safe sort key of a row (ids as strings, timestamps as ISO strings).
 * @template T
 * @param {T[]} rows
 * @param {number} limit
 * @param {(row: T) => Record<string, unknown>} keyOf
 * @returns {{ items: T[], next_cursor: string | null }}
 */
export function page(rows, limit, keyOf) {
  const items = rows.slice(0, limit);
  return {
    items,
    next_cursor: rows.length > limit ? encodeCursor(keyOf(items[limit - 1])) : null,
  };
}
