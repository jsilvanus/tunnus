import { errorBody } from '../admin/errors.js';
import { errorFields } from '../logger.js';
import { pickLocale } from '../i18n.js';
import { errorPage } from './pages.js';
import { logPath } from './requestLog.js';

/**
 * Last error middleware. Logs the error without its message and answers 500: JSON under the admin
 * API, the branded error page everywhere else. If the response has started, the error goes on to
 * Express, which closes the connection.
 * @param {{ config: import('../config.js').Config, logger: { error: (o: object, m: string) => void } }} deps
 * @returns {import('express').ErrorRequestHandler}
 */
export function errorHandler({ config, logger }) {
  return (err, req, res, next) => {
    logger.error(
      {
        reqId: /** @type {any} */ (req).id,
        method: req.method,
        path: logPath(req.originalUrl),
        err: errorFields(err),
      },
      'request failed',
    );
    if (res.headersSent) return next(err);
    if (req.path.startsWith('/admin/api/') || req.path.startsWith('/api/')) {
      res.status(500).json(errorBody('internal', 'Internal error'));
      return;
    }
    res.status(500).send(errorPage({ config, locale: pickLocale(req, config.defaultLocale) }));
  };
}
