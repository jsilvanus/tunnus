import express from 'express';
import { createApiClient } from '../client/http.js';
import { createMcpServer } from './server.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const TOKEN = /^tun_[A-Za-z0-9_-]{43}$/;

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
 * admin token is passed to the admin API for that request; nothing is stored. Other methods get 405.
 * @param {{ spec: any, url: string, fetch?: typeof globalThis.fetch }} options
 */
export function createMcpHttpApp({ spec, url, fetch }) {
  const app = express();
  app.disable('x-powered-by');

  app.all('/mcp', (req, res, next) => {
    if (req.method === 'POST') return next();
    res.set('Allow', 'POST');
    sendError(res, 405, 'method_not_allowed', 'Use POST /mcp');
  });

  /** @type {express.RequestHandler} */
  const authenticate = (req, res, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
    if (!match || !TOKEN.test(match[1])) {
      res.set('WWW-Authenticate', 'Bearer');
      sendError(
        res,
        401,
        'unauthorized',
        'An admin token is required: Authorization: Bearer tun_...',
      );
      return;
    }
    res.locals.token = match[1];
    next();
  };

  app.post('/mcp', authenticate, express.json({ limit: '1mb' }), async (req, res) => {
    const client = createApiClient({ url, token: res.locals.token, fetch });
    const server = createMcpServer({ spec, callApi: (op, args) => client.call(op, args) });
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
