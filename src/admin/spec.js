import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

/** The contract, at the repository root. */
export const SPEC_URL = new URL('../../openapi.yaml', import.meta.url);

/** @returns {string} */
export function readSpecText() {
  return readFileSync(SPEC_URL, 'utf8');
}

/**
 * Parse the OpenAPI document.
 * @param {string} [text]
 * @returns {any}
 */
export function loadSpec(text = readSpecText()) {
  return parse(text);
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/**
 * Follow a local `$ref` (`#/...`) to its target. Only used for parameters, request bodies and responses;
 * schema references are kept as they are for Ajv.
 * @param {any} doc
 * @param {any} node
 * @returns {any}
 */
function deref(doc, node) {
  let cur = node;
  for (let depth = 0; cur && typeof cur.$ref === 'string'; depth++) {
    if (depth > 10 || !cur.$ref.startsWith('#/')) throw new Error(`Unsupported $ref ${cur.$ref}`);
    cur = cur.$ref
      .slice(2)
      .split('/')
      .reduce(
        (/** @type {any} */ o, /** @type {string} */ k) =>
          o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')],
        doc,
      );
    if (cur === undefined) throw new Error(`Unresolvable $ref ${node.$ref}`);
  }
  return cur;
}

/**
 * Path-level parameters, overridden by operation-level ones with the same name and location.
 * @param {any} doc
 * @param {any[]} pathLevel
 * @param {any[]} opLevel
 */
function mergeParameters(doc, pathLevel, opLevel) {
  /** @type {Map<string, any>} */
  const byKey = new Map();
  for (const raw of [...pathLevel, ...opLevel]) {
    const p = deref(doc, raw);
    byKey.set(`${p.in}:${p.name}`, p);
  }
  return [...byKey.values()];
}

/**
 * One entry per operation in the spec.
 * @typedef {{
 *   operationId: string,
 *   method: string,
 *   path: string,
 *   expressPath: string,
 *   parameters: any[],
 *   hasRequestBody: boolean,
 *   requestBodyRequired: boolean,
 *   requestBodySchema: any,
 *   responses: Record<string, any>,
 * }} Operation
 */

/**
 * List every operation. `expressPath` uses Express syntax (`/users/:userId`).
 * `method` is lowercase. `responses` maps status keys (and `default`) to resolved response objects.
 * @param {any} spec
 * @returns {Operation[]}
 */
export function listOperations(spec) {
  /** @type {Operation[]} */
  const out = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) {
      const op = /** @type {any} */ (item)[method];
      if (!op) continue;
      const body = op.requestBody ? deref(spec, op.requestBody) : undefined;
      /** @type {Record<string, any>} */
      const responses = {};
      for (const [status, raw] of Object.entries(op.responses ?? {})) {
        responses[status] = deref(spec, raw);
      }
      out.push({
        operationId: op.operationId,
        method,
        path,
        expressPath: path.replace(/\{([^}]+)\}/g, ':$1'),
        parameters: mergeParameters(spec, item.parameters ?? [], op.parameters ?? []),
        hasRequestBody: body !== undefined,
        requestBodyRequired: Boolean(body?.required),
        requestBodySchema: body?.content?.['application/json']?.schema ?? null,
        responses,
      });
    }
  }
  return out;
}
