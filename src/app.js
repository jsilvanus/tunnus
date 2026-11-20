import { existsSync, readFileSync } from 'node:fs';
import express from 'express';
import { createInteractionRouter } from './web/interactions.js';
import { createProviderHolder } from './oidc/providerHolder.js';
import { securityHeaders } from './web/security.js';
import { createAdminRouter } from './admin/router.js';
import { createHealthRouter, PACKAGE_VERSION } from './health.js';
import { createPrivacyRouter } from './web/privacy.js';
import { createMailRelayRouter } from './web/mailRelay.js';
import { createMetrics } from './metrics.js';
import { setAuditMetrics } from './audit.js';
import { logger } from './logger.js';
import { requestLog } from './web/requestLog.js';
import { errorHandler } from './web/errorHandler.js';

/**
 * Build the Express app. Everything is mounted under the issuer's path so a
 * reverse proxy can route a prefix without stripping it.
 * @param {{ config: import('./config.js').Config, pool: import('pg').Pool, clients: Record<string, any>[], mailer: import('./mail.js').Mailer }} deps
 * @param {{ validateResponses?: boolean }} [options]
 */
export async function createApp({ config, pool, clients, mailer }, options = {}) {
  const validateResponses = options.validateResponses ?? config.adminValidateResponses;
  const holder = await createProviderHolder({ config, pool, clients });
  const metrics = createMetrics();
  setAuditMetrics(metrics);
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(requestLog(logger));

  const router = express.Router();
  router.use(securityHeaders(config));
  const logoFile = process.env.BRAND_LOGO_FILE || '/app/logo.png';
  const logoBytes = existsSync(logoFile) ? readFileSync(logoFile) : null;
  if (logoBytes) {
    router.get('/logo.png', (_req, res) => {
      res.set('Cache-Control', 'public, max-age=86400');
      res.type('image/png').send(logoBytes);
    });
  }
  router.use(createHealthRouter({ pool, version: PACKAGE_VERSION }));
  router.use(metrics.router({ pool, token: config.metricsBearerToken }));
  router.use(createPrivacyRouter({ config }));
  router.use(createInteractionRouter({ config, pool, getProvider: () => holder.current, mailer }));
  router.use(createMailRelayRouter({ pool, token: config.mailRelayToken, mailer }));
  router.use(
    '/admin/api/v1',
    createAdminRouter({ config, pool, clients, reloadKeys: holder.reload, validateResponses }),
  );

  // The provider's callback is built once per provider instance, not per request.
  let callbackFor = /** @type {import('oidc-provider').Provider | undefined} */ (undefined);
  let callback = /** @type {any} */ (undefined);
  router.use((req, res, next) => {
    const current = holder.current;
    if (current !== callbackFor) {
      callbackFor = current;
      callback = current.callback();
    }
    callback(req, res, next);
  });
  router.use(errorHandler({ config, logger }));
  app.use(config.basePath || '/', router);
  return { app, provider: holder.current, holder, metrics };
}
