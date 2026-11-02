import express from 'express';
import { createInteractionRouter } from './web/interactions.js';
import { createProvider } from './oidc/provider.js';
import { loadJwks } from './oidc/keys.js';
import { securityHeaders } from './web/security.js';

/**
 * Build the Express app. Everything is mounted under the issuer's path so a
 * reverse proxy can route a prefix without stripping it.
 * @param {{ config: import('./config.js').Config, pool: import('pg').Pool, clients: Record<string, any>[], mailer: import('./mail.js').Mailer }} deps
 */
export async function createApp({ config, pool, clients, mailer }) {
  const jwks = await loadJwks(pool, config.keyEncryptionSecret);
  const provider = createProvider({ config, pool, clients, jwks });
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  const router = express.Router();
  router.use(securityHeaders(config));
  router.use(createInteractionRouter({ config, pool, provider, mailer }));
  router.use(provider.callback());
  app.use(config.basePath || '/', router);
  return { app, provider };
}
