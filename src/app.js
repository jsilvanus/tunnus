import express from 'express';
import { createInteractionRouter } from './web/interactions.js';
import { createProviderHolder } from './oidc/providerHolder.js';
import { securityHeaders } from './web/security.js';
import { createAdminRouter } from './admin/router.js';
import { createHealthRouter, PACKAGE_VERSION } from './health.js';
import { createMetrics } from './metrics.js';
import { setAuditMetrics } from './audit.js';

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

  const router = express.Router();
  router.use(securityHeaders(config));
  router.use(createHealthRouter({ pool, version: PACKAGE_VERSION }));
  router.use(metrics.router({ pool, token: config.metricsBearerToken }));
  router.use(createInteractionRouter({ config, pool, getProvider: () => holder.current, mailer }));
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
  app.use(config.basePath || '/', router);
  return { app, provider: holder.current, holder, metrics };
}
