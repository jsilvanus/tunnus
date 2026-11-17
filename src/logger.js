import pino from 'pino';

/**
 * The application logger. The level comes from LOG_LEVEL (default `info`).
 */
export const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Fields that describe an error for a log line, without its message. A message can carry values
 * (a database constraint error names the key), and link tokens or addresses must not reach the
 * log. The name, the code and the stack frames are kept.
 * @param {unknown} err
 * @returns {{ name: string, code?: unknown, frames: string[] }}
 */
export function errorFields(err) {
  const e = /** @type {any} */ (err);
  const frames =
    typeof e?.stack === 'string'
      ? e.stack
          .split('\n')
          .filter((/** @type {string} */ line) => line.trimStart().startsWith('at '))
      : [];
  return {
    name: typeof e?.name === 'string' ? e.name : typeof err,
    code: e?.code,
    frames,
  };
}
