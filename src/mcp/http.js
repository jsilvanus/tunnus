import express from 'express';
import { createApiClient } from '../client/http.js';
import { createMcpServer } from './server.js';
import { getMcpIdentitySettings, representMcpUser, resolveMcpUserReference } from './identity.js';
import { protectedResourceMetadata, wwwAuthenticate } from './oauth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const TOKEN = /^tun_[A-Za-z0-9_-]{43}$/;

/**
 * @typedef {{
 *   resourceUrl: string,
 *   authorizationServerUrl: string,
 *   resourceMetadataUrl: string,
 *   verifyToken: (token: string) => Promise<{ ok: true, sub: string, claims: Record<string, any> } | { ok: false, reason: string }>,
 * }} McpOAuthOptions
 */

/**
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
function sendError(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

/**
 * Express app serving the MCP endpoint at `POST /mcp` (stateless Streamable HTTP). Each request's
 * admin token (or OAuth JWT when `oauth` is configured) is passed to the admin API for that
 * request; nothing is stored. Other methods get 405.
 * @param {{
 *   spec: any,
 *   url: string,
 *   fetch?: typeof globalThis.fetch,
 *   oauth?: McpOAuthOptions,
 *   statePath?: string,
 *   state?: import('../client/mcpState.js').McpState,
 *   stateStore?: any,
 *   issuer?: string,
 *   accountUrl?: string,
 *   identityPool?: import('pg').Pool,
 *   resolveTokenUser?: (token: string) => Promise<
 *     | { ok: true, user: { id: string, email?: string }, token?: { id: string, label?: string }, label?: string }
 *     | { ok: false, reason: string }
 *   >,
 * }} options
 */
export function createMcpHttpApp({
  spec,
  url,
  fetch,
  oauth,
  statePath,
  state,
  stateStore,
  issuer,
  accountUrl,
  resolveTokenUser,
}) {
  const app = express();
  app.disable('x-powered-by');

  if (oauth) {
    const metadata = protectedResourceMetadata(oauth.resourceUrl, oauth.authorizationServerUrl);
    app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => res.json(metadata));
    app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(metadata));
  }

  app.all('/mcp', (req, res, next) => {
    if (req.method === 'POST') return next();
    res.set('Allow', 'POST');
    sendError(res, 405, 'method_not_allowed', 'Use POST /mcp');
  });

  /**
   * @param {import('express').Response} res
   * @param {string} [error]
   */
  const sendUnauthorized = (res, error) => {
    res.set(
      'WWW-Authenticate',
      oauth ? wwwAuthenticate(oauth.resourceMetadataUrl, error) : 'Bearer',
    );
    sendError(
      res,
      401,
      'unauthorized',
      oauth
        ? 'A valid OAuth access token or admin token is required'
        : 'An admin token is required: Authorization: Bearer tun_...',
    );
  };

  /** @type {express.RequestHandler} */
  const authenticate = async (req, res, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
    const token = match?.[1];
    if (!token) return void sendUnauthorized(res);

    if (TOKEN.test(token)) {
      if (resolveTokenUser) {
        try {
          const found = await resolveTokenUser(token);
          if (!found.ok) return void sendUnauthorized(res, 'invalid_token');
          res.locals.token = token;
          res.locals.user = found.user;
          res.locals.identityScope = { ownerUserId: found.user.id, authKind: 'admin_token', authClientKey: found.token.id };
          res.locals.actor = {
            userId: found.user.id,
            email: found.user.email,
            label: found.token?.label || found.label || 'token',
          };
          return void next();
        } catch {
          return void sendUnauthorized(res, 'invalid_token');
        }
      }
      res.locals.token = token;
      return void next();
    }

    if (!oauth) return void sendUnauthorized(res);

    try {
      const verified = await oauth.verifyToken(token);
      if (!verified.ok) return void sendUnauthorized(res, 'invalid_token');
      if (typeof verified.claims?.client_id !== 'string' || !verified.claims.client_id) {
        return void sendUnauthorized(res, 'invalid_token');
      }
      res.locals.identityScope = {
        ownerUserId: verified.sub,
        authKind: 'oauth',
        authClientKey: verified.claims.client_id,
      };
      res.locals.token = token;
      res.locals.user = { id: verified.sub };
      res.locals.actor = {
        userId: verified.sub,
        label: 'oauth',
      };
      next();
    } catch {
      sendUnauthorized(res, 'invalid_token');
    }
  };

  app.post('/mcp', authenticate, express.json({ limit: '1mb' }), async (req, res) => {
    const client = createApiClient({ url, token: res.locals.token, fetch });
    let identity = null;
    if (identityPool && res.locals.identityScope) {
      const scope = res.locals.identityScope;
      const mode = await getMcpIdentitySettings(identityPool, scope);
      identity = {
        mode,
        resolveUser: (value) => resolveMcpUserReference(identityPool, scope, value, mode),
        representUser: (value) => representMcpUser(identityPool, scope, value, mode),
      };
    }
    const server = createMcpServer({
      spec,
      callApi: (op, args) => client.call(op, args),
      statePath,
      state,
      stateStore,
      issuer: issuer || url,
      accountUrl,
      userId: res.locals.user?.id,
      actor: res.locals.actor,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) sendError(res, 500, 'internal', 'Internal error');
    }
  });

  /** @type {express.ErrorRequestHandler} */
  const onError = (err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err?.type === 'entity.parse.failed')
      sendError(res, 400, 'invalid_request', 'Body is not valid JSON');
    else
      sendError(
        res,
        err?.status ?? 500,
        err?.status ? 'invalid_request' : 'internal',
        err?.message ?? 'Internal error',
      );
  };
  app.use(onError);

  return app;
}
