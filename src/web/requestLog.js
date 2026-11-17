import { randomUUID } from 'node:crypto';

/** Request ids the client may pass through: short and free of anything that could forge a log line. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The request path as it is logged: no query string, and link tokens (`/link/<token>`) replaced.
 * @param {string} originalUrl
 */
export function logPath(originalUrl) {
  return String(originalUrl)
    .split('?')[0]
    .replace(/\/link\/[^/]+/g, '/link/:token');
}

/**
 * Request log: one line per response with method, path (see logPath), status, duration and a
 * request id. The id is the client's X-Request-Id when it is safe, otherwise a random UUID; it is
 * set on the response as X-Request-Id and kept on `req.id` for the error handler.
 * @param {{ info: (o: object, m: string) => void }} logger
 * @returns {import('express').RequestHandler}
 */
export function requestLog(logger) {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    const id = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    /** @type {any} */ (req).id = id;
    res.set('X-Request-Id', id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      logger.info(
        {
          reqId: id,
          method: req.method,
          path: logPath(req.originalUrl),
          status: res.statusCode,
          durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100,
        },
        'request',
      );
    });
    next();
  };
}
