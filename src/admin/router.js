import express from 'express';
import { audit } from '../audit.js';
import { errorFields, logger } from '../logger.js';
import {
  getMcpIdentitySettings,
  resolveMcpSubjectReference,
  resolveMcpUserReference,
  representMcpUser,
  mapOperationInput,
  projectOperationOutput,
} from '../mcp/identity.js';

import { createAdminAuth } from './auth.js';
import { AdminError, errorBody, sendError } from './errors.js';
import { listOperations, loadSpec, readSpecText } from './spec.js';
import { clientOperations } from '../client/operations.js';
import { createSpecValidators } from './validate.js';
import { handlers as allHandlers } from './handlers/index.js';

const INTERNAL = errorBody('internal', 'Internal error');

/**
 * Admin API router, mounted at `<issuer>/admin/api/v1`. One route per operation in openapi.yaml.
 * @param {{
 *   config: import('../config.js').Config,
 *   pool: import('pg').Pool,
 *   clients?: Record<string, any>[],
 *   getClients?: () => Record<string, any>[],
 *   reloadKeys: () => Promise<void>,
 *   getProvider?: () => any | any,
 *   validateResponses?: boolean,
 *   verifyOAuthToken?: (token: string) => Promise<{ ok: true, sub: string } | { ok: false, reason: string }>,
 * }} deps
 * @returns {express.Router}
 */
export function createAdminRouter({
  config,
  pool,
  clients,
  getClients,
  reloadKeys,
  getProvider,
  validateResponses = config.adminValidateResponses,
  verifyOAuthToken,
}) {
  const specText = readSpecText();
  const spec = loadSpec(specText);
  const operations = listOperations(spec);
  const clientOpMap = new Map(clientOperations(spec).map((cop) => [cop.operationId, cop]));
  const handlers = /** @type {Record<string, (ctx: any) => Promise<any>>} */ (allHandlers);

  const declared = new Set(operations.map((op) => op.operationId));
  const missing = [...declared].filter((id) => typeof handlers[id] !== 'function');
  const orphaned = Object.keys(handlers).filter((id) => !declared.has(id));
  if (missing.length || orphaned.length) {
    throw new Error(
      `admin handlers do not match openapi.yaml: missing ${missing.join(', ') || 'none'}; ` +
        `without operation ${orphaned.join(', ') || 'none'}`,
    );
  }

  const validators = createSpecValidators(spec, operations);
  const parseJson = express.json({ limit: '100kb' });

  /**
   * Parse a JSON body; malformed or oversized bodies get a 400 in the API's error shape.
   * @type {import('express').RequestHandler}
   */
  const jsonBody = (req, res, next) => {
    parseJson(req, res, (/** @type {any} */ err) => {
      if (err) {
        const message =
          err.type === 'entity.too.large' ? 'Request body too large' : 'Invalid JSON body';
        return void sendError(res, 400, 'invalid_request', message);
      }
      next();
    });
  };

  /**
   * Validate the request body against the operation. Returns the body, with defaults applied.
   * An empty request has no body even when it declares a JSON content type (express.json gives {}).
   * @param {import('./spec.js').Operation} op
   * @param {any} v
   * @param {express.Request} req
   */
  function bodyOf(op, v, req) {
    const sent =
      Number(req.headers['content-length'] ?? 0) > 0 ||
      req.headers['transfer-encoding'] !== undefined;
    if (!sent) {
      if (op.requestBodyRequired)
        throw invalid('Request body required', [{ path: '/', message: 'required' }]);
      return undefined;
    }
    if (!op.hasRequestBody)
      throw invalid('Request body not allowed', [{ path: '/', message: 'no body expected' }]);
    if (req.body === undefined) {
      throw invalid('Request body must be JSON', [
        { path: '/', message: 'expected application/json' },
      ]);
    }
    return checked(v.body(req.body), req.body);
  }

  /**
   * @param {string} message
   * @param {{ path: string, message: string }[]} [details]
   */
  function invalid(message, details) {
    return new AdminError(400, 'invalid_request', message, details);
  }

  /**
   * @template T
   * @param {{ ok: true } | { ok: false, details: { path: string, message: string }[] }} result
   * @param {T} [data]
   * @returns {T}
   */
  function checked(result, data) {
    if (!result.ok) throw invalid('Invalid request', result.details);
    return /** @type {T} */ (data);
  }

  /**
   * Run one operation: validate, call the handler, audit, validate the response, send.
   * @param {import('./spec.js').Operation} op
   * @param {express.Request} req
   * @param {express.Response} res
   */
  async function run(op, req, res) {
    const v = validators.get(op.operationId);
    const handler = handlers[op.operationId];
    const clientOp = clientOpMap.get(op.operationId) ?? op;
    const actor = /** @type {import('./types.js').AdminRequest} */ (req).admin;
    /** @type {number} */
    let status;
    /** @type {unknown} */
    let body;
    /** @type {string | null} */
    let errorCode = null;
    /** @type {{ targetType?: string, targetId?: string, details?: Record<string, unknown> }} */
    let target = {};

    let identityScope = null;
    let identityMode = 'open';
    if (actor?.tokenId) {
      identityScope = {
        ownerUserId: actor.userId,
        authKind: 'admin_token',
        authClientKey: actor.tokenId,
      };
    } else if (actor?.clientId) {
      identityScope = {
        ownerUserId: actor.userId,
        authKind: 'oauth',
        authClientKey: actor.clientId,
      };
    } else if (actor?.userId) {
      identityScope = {
        ownerUserId: actor.userId,
        authKind: 'admin_token',
        authClientKey: actor.userId,
      };
    }
    if (identityScope) {
      try {
        identityMode = await getMcpIdentitySettings(pool, identityScope);
      } catch {
        identityMode = 'open';
      }
    }

    try {
      const params = { ...req.params };
      const query = { ...req.query };

      if (identityMode !== 'open') {
        const queryParams =
          clientOp.queryParams ?? op.parameters?.filter((p) => p.in === 'query') ?? [];
        const hasSensitiveSearch = queryParams.some(
          (p) =>
            p.sensitiveUserSearch ||
            p.schema?.['x-tunnus-sensitive-user-search'] ||
            p['x-tunnus-sensitive-user-search'],
        );
        if (hasSensitiveSearch && (query.q || query.name || query.title || query.email)) {
          throw invalid('Search by direct email or name is disabled in restricted identity mode', [
            { path: '/q', message: 'disallowed in restricted identity mode' },
          ]);
        }
      }

      const paramCheck = v.params(params);
      if (!paramCheck.ok) throw invalid('Invalid request', paramCheck.details);
      const queryCheck = v.query(query);
      if (!queryCheck.ok) throw invalid('Invalid request', queryCheck.details);
      const requestBody = bodyOf(op, v, req);

      let mappedParams = params;
      let mappedBody = requestBody;
      if (identityMode !== 'open') {
        try {
          const mapped = await mapOperationInput(
            clientOp,
            params,
            requestBody,
            async (val, options) => {
              if (
                identityMode === 'ref_only' &&
                typeof val === 'string' &&
                val.startsWith('pseudo:')
              ) {
                throw new AdminError(
                  400,
                  'invalid_request',
                  'Pseudonym inputs are not allowed in ref_only mode',
                );
              }
              if (options?.allowUnlinked) {
                const subject = await resolveMcpSubjectReference(
                  pool,
                  identityScope,
                  val,
                  identityMode,
                );
                if (subject.tunnus_user_id) {
                  throw new AdminError(
                    409,
                    'conflict',
                    'This identity is already linked to a Tunnus account',
                  );
                }
                return val;
              }
              return await resolveMcpUserReference(pool, identityScope, val, identityMode);
            },
          );
          mappedParams = mapped.params;
          mappedBody = mapped.body;
        } catch (err) {
          if (err instanceof AdminError) throw err;
          throw invalid(
            err?.code === 'target_not_linked'
              ? 'This identity is not linked to a Tunnus account'
              : err?.code === 'target_already_linked'
                ? 'This identity is already linked to a Tunnus account'
                : 'Unknown, expired, or invalid user reference',
          );
        }
      }

      const result =
        (await handler({
          req,
          pool,
          config,
          clients: getClients ? getClients() : (clients ?? []),
          getClients,
          actor: { userId: actor.userId, tokenId: actor.tokenId, clientId: actor.clientId },
          identityScope,
          identityMode,
          ip: req.ip ?? null,
          params: mappedParams,
          query,
          body: mappedBody,
          reloadKeys,
          getProvider,
        })) ?? {};
      status = result.status ?? 200;
      body = status === 204 ? undefined : result.body;
      target = result.audit ?? {};

      if (
        identityMode !== 'open' &&
        status < 300 &&
        body !== undefined &&
        op.operationId !== 'getMe'
      ) {
        body = await projectOperationOutput(clientOp, body, (uid) =>
          representMcpUser(pool, identityScope, uid, identityMode),
        );
      }
    } catch (err) {
      if (err instanceof AdminError) {
        status = err.status;
        let msg = err.message;
        if (identityMode !== 'open') {
          msg = msg.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[redacted]');
          msg = msg.replace(
            /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
            '[redacted]',
          );
        }
        body = errorBody(err.code, msg, identityMode === 'open' ? err.details : undefined);
        errorCode = err.code;
      } else {
        logger.error(
          { operationId: op.operationId, err: errorFields(err) },
          'admin handler failed',
        );
        status = 500;
        body = INTERNAL;
        errorCode = 'internal';
      }
    }

    if (validateResponses && identityMode === 'open' && errorCode !== 'internal') {
      const check = v.response(status, body);
      if (!check.ok) {
        logger.error(
          { operationId: op.operationId, status, details: check.details },
          'admin response does not match openapi.yaml',
        );
        status = 500;
        body = INTERNAL;
        errorCode = 'internal';
      }
    }

    try {
      await audit(pool, {
        actorUserId: actor.userId,
        action: `admin.${op.operationId}`,
        targetType: target.targetType,
        targetId: target.targetId,
        ip: req.ip ?? null,
        details: errorCode === null ? { status, ...target.details } : { status, error: errorCode },
      });
    } catch (err) {
      logger.error(
        { operationId: op.operationId, err: errorFields(err) },
        'admin audit write failed',
      );
      status = 500;
      body = INTERNAL;
    }

    if (status === 204) return void res.status(204).end();
    res.status(status).json(body);
  }

  const router = express.Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/openapi.yaml', (_req, res) => {
    res.type('application/yaml').send(specText);
  });
  router.use(jsonBody);
  router.use(createAdminAuth({ pool, verifyOAuthToken }));

  for (const op of operations) {
    // Express has no per-operation method table here, so each route checks its method.
    router.route(op.expressPath).all((req, res, next) => {
      if (req.method !== op.method.toUpperCase()) return next();
      void run(op, req, res);
    });
  }

  router.use((_req, res) => {
    sendError(res, 404, 'not_found', 'Not found');
  });
  return router;
}
