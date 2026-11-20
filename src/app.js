import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import express from 'express';
import { createInteractionRouter } from './web/interactions.js';
import { createAccountRouter } from './web/account.js';
import { createProviderHolder } from './oidc/providerHolder.js';
import { securityHeaders } from './web/security.js';
import { createAdminRouter } from './admin/router.js';
import { loadSpec, readSpecText } from './admin/spec.js';
import { createHealthRouter, PACKAGE_VERSION } from './health.js';
import { createPrivacyRouter } from './web/privacy.js';
import { createMailRelayRouter } from './web/mailRelay.js';
import { createMetrics } from './metrics.js';
import { setAuditMetrics } from './audit.js';
import { logger } from './logger.js';
import { requestLog } from './web/requestLog.js';
import { errorHandler } from './web/errorHandler.js';
import { createMcpHttpApp } from './mcp/http.js';
import { createMcpJwtVerifier } from './mcp/oauth.js';
import { loadJwks } from './oidc/keys.js';

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
  router.use(createAccountRouter({ config, pool, getProvider: () => holder.current, mailer }));
  router.use(createMailRelayRouter({ pool, token: config.mailRelayToken, mailer }));
  const verifyOAuthToken = config.mcp?.oauthEnabled
    ? createMcpJwtVerifier({
        issuer: config.issuer,
        audience: config.mcp.resourceUrl,
        fetchJwks: () => loadJwks(pool, config.keyEncryptionSecret),
      })
    : undefined;

  const adminRouter = createAdminRouter({
    config,
    pool,
    clients,
    reloadKeys: holder.reload,
    validateResponses,
    verifyOAuthToken,
  });
  router.use('/admin/api/v1', adminRouter);

  if (config.mcp?.enabled && verifyOAuthToken) {
    const spec = loadSpec(readSpecText());
    const localFetch = createLocalAdminFetch(adminRouter, `${config.issuer}/admin/api/v1`);
    router.use(
      createMcpHttpApp({
        spec,
        url: config.issuer,
        fetch: localFetch,
        oauth: {
          resourceUrl: config.mcp.resourceUrl,
          authorizationServerUrl: config.issuer,
          resourceMetadataUrl: `${config.issuer}/.well-known/oauth-protected-resource/mcp`,
          verifyToken: verifyOAuthToken,
        },
      }),
    );
  }

  // The provider's callback is built once per provider instance, not per request.
  let callbackFor = /** @type {import('oidc-provider').Provider | undefined} */ (undefined);
  let callback = /** @type {any} */ (undefined);
  const providerCallback = (
    /** @type {any} */ req,
    /** @type {any} */ res,
    /** @type {any} */ next,
  ) => {
    const current = holder.current;
    if (current !== callbackFor) {
      callbackFor = current;
      callback = current.callback();
    }
    callback(req, res, next);
  };

  if (config.mcp?.oauthEnabled) {
    // RFC 8414 authorization server metadata alias for MCP clients such as ChatGPT.
    router.get('/.well-known/oauth-authorization-server', (req, res, next) => {
      req.url = '/.well-known/openid-configuration';
      providerCallback(req, res, next);
    });
  }

  router.use(providerCallback);
  router.use(errorHandler({ config, logger }));
  app.use(config.basePath || '/', router);
  return { app, provider: holder.current, holder, metrics };
}

/**
 * In-process fetch adapter for dispatching `/admin/api/v1` calls directly to `adminRouter`.
 * @param {express.Router} adminRouter
 * @param {string} adminBaseUrl
 * @returns {typeof globalThis.fetch}
 */
export function createLocalAdminFetch(adminRouter, adminBaseUrl) {
  const basePath = new URL(adminBaseUrl).pathname.replace(/\/+$/, '');
  const localApp = express();
  localApp.disable('x-powered-by');
  localApp.use(adminRouter);
  return async (targetUrl, init = {}) => {
    const parsed = new URL(String(targetUrl));
    const relUrl = parsed.pathname.slice(basePath.length) + parsed.search;
    const bodyBuf = init.body != null ? Buffer.from(String(init.body)) : Buffer.alloc(0);
    const socket = new PassThrough();
    Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
    const req = new http.IncomingMessage(/** @type {any} */ (socket));
    req.method = init.method ?? 'GET';
    req.url = relUrl || '/';
    req.headers = {
      ...Object.fromEntries(
        Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
      ),
      ...(bodyBuf.length ? { 'content-length': String(bodyBuf.length) } : {}),
    };
    const res = new http.ServerResponse(req);
    /** @type {Buffer[]} */
    const chunks = [];
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    res.write = (/** @type {any} */ chunk, /** @type {any} */ ...rest) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return origWrite(chunk, ...rest);
    };
    return await new Promise((resolve) => {
      res.end = (/** @type {any} */ chunk, /** @type {any} */ ...rest) => {
        if (chunk && typeof chunk !== 'function') {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        origEnd(chunk, ...rest);
        const text = Buffer.concat(chunks).toString('utf8');
        const rawHeaders = res.getHeaders();
        /** @type {Record<string, string>} */
        const headers = {};
        for (const [k, v] of Object.entries(rawHeaders)) {
          if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
        }
        resolve(
          new Response(res.statusCode === 204 ? null : text, {
            status: res.statusCode,
            headers,
          }),
        );
        return res;
      };
      localApp(/** @type {any} */ (req), /** @type {any} */ (res));
      if (bodyBuf.length) req.push(bodyBuf);
      req.push(null);
    });
  };
}
