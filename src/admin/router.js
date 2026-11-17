import express from 'express';
import { audit } from '../audit.js';
import { createAdminAuth } from './auth.js';
import { AdminError, errorBody, sendError } from './errors.js';
import { listOperations, loadSpec, readSpecText } from './spec.js';
import { createSpecValidators } from './validate.js';
import { handlers as allHandlers } from './handlers/index.js';

const INTERNAL = errorBody('internal', 'Internal error');

/**
 * Admin API router, mounted at `<issuer>/admin/api/v1`. One route per operation in openapi.yaml.
 * @param {{
 *   config: import('../config.js').Config,
 *   pool: import('pg').Pool,
 *   clients: Record<string, any>[],
 *   reloadKeys: () => Promise<void>,
 *   validateResponses?: boolean,
 * }} deps
 * @returns {express.Router}
 */
export function createAdminRouter({
  config,
  pool,
  clients,
  reloadKeys,
  validateResponses = config.adminValidateResponses,
}) {
  const specText = readSpecText();
  const spec = loadSpec(specText);
  const operations = listOperations(spec);
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
    const actor = /** @type {import('./types.js').AdminRequest} */ (req).admin;
    /** @type {number} */
    let status;
    /** @type {unknown} */
    let body;
    /** @type {string | null} */
    let errorCode = null;
    /** @type {{ targetType?: string, targetId?: string, details?: Record<string, unknown> }} */
    let target = {};
    try {
      const params = { ...req.params };
      const query = { ...req.query };
      const paramCheck = v.params(params);
      if (!paramCheck.ok) throw invalid('Invalid request', paramCheck.details);
      const queryCheck = v.query(query);
      if (!queryCheck.ok) throw invalid('Invalid request', queryCheck.details);
      const requestBody = bodyOf(op, v, req);

      const result =
        (await handler({
          req,
          pool,
          config,
          clients,
          actor: { userId: actor.userId, tokenId: actor.tokenId },
          ip: req.ip ?? null,
          params,
          query,
          body: requestBody,
          reloadKeys,
        })) ?? {};
      status = result.status ?? 200;
      body = status === 204 ? undefined : result.body;
      target = result.audit ?? {};
    } catch (err) {
      if (err instanceof AdminError) {
        status = err.status;
        body = errorBody(err.code, err.message, err.details);
        errorCode = err.code;
      } else {
        console.error('admin handler failed', { operationId: op.operationId, err });
        status = 500;
        body = INTERNAL;
        errorCode = 'internal';
      }
    }

    if (validateResponses && errorCode !== 'internal') {
      const check = v.response(status, body);
      if (!check.ok) {
        console.error('admin response does not match openapi.yaml', {
          operationId: op.operationId,
          status,
          details: check.details,
        });
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
      console.error('admin audit write failed', { operationId: op.operationId, err });
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
  router.use(createAdminAuth({ pool }));

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
