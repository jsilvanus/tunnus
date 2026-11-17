import * as ajvModule from 'ajv/dist/2020.js';
import * as addFormatsModule from 'ajv-formats';

// Both packages are CommonJS. At runtime `default` is the constructor or plugin, but TypeScript
// (NodeNext) types it as the whole module, so the types are restated here.
const Ajv2020 = /** @type {new (opts: object) => any} */ (
  /** @type {unknown} */ (ajvModule.default)
);
const addFormats = /** @type {(ajv: any) => unknown} */ (
  /** @type {unknown} */ (addFormatsModule.default)
);

/** Id of the spec document registered with Ajv; operation schemas refer to it. */
const SPEC_ID = 'tunnus-spec';

/**
 * Copy a schema, pointing its local `#/components/...` references at the registered spec document.
 * @param {unknown} node
 * @returns {any}
 */
export function rewriteRefs(node) {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node).map(([k, v]) => [
      k,
      k === '$ref' && typeof v === 'string' && v.startsWith('#/')
        ? `${SPEC_ID}${v}`
        : rewriteRefs(v),
    ]),
  );
}

/**
 * @param {boolean} coerce
 * @param {any} components
 */
function makeAjv(coerce, components) {
  const ajv = new Ajv2020({
    allErrors: true,
    useDefaults: true,
    strict: false,
    coerceTypes: coerce,
  });
  addFormats(ajv);
  ajv.addSchema({ $id: SPEC_ID, components });
  return ajv;
}

/**
 * @typedef {{ ok: true } | { ok: false, details: { path: string, message: string }[] }} CheckResult
 */

/**
 * Turn Ajv errors into the API's `{ path, message }` details. Paths are JSON Pointers.
 * @param {import('ajv').ErrorObject[]} errors
 * @returns {{ path: string, message: string }[]}
 */
function toDetails(errors) {
  return errors.map((e) => {
    let path = e.instancePath;
    if (e.keyword === 'required') path += `/${e.params.missingProperty}`;
    if (e.keyword === 'additionalProperties') path += `/${e.params.additionalProperty}`;
    return {
      path: path || '/',
      message: e.keyword === 'additionalProperties' ? 'unknown property' : (e.message ?? 'invalid'),
    };
  });
}

/**
 * @param {((data: unknown) => boolean) & { errors?: import('ajv').ErrorObject[] | null }} fn
 * @param {unknown} data
 * @returns {CheckResult}
 */
function check(fn, data) {
  if (fn(data)) return { ok: true };
  return { ok: false, details: toDetails(fn.errors ?? []) };
}

/**
 * Compile every operation's parameter, query, body and response schemas, and every component schema on demand.
 * Path and query values are coerced to their schema types and defaults are applied; bodies and
 * responses are not coerced.
 * @param {any} spec
 * @param {import('./spec.js').Operation[]} operations
 */
export function createSpecValidators(spec, operations) {
  const coercing = makeAjv(true, spec.components);
  const plain = makeAjv(false, spec.components);

  /** @param {any[]} params */
  const objectSchema = (params) => ({
    type: 'object',
    properties: Object.fromEntries(params.map((p) => [p.name, p.schema ?? {}])),
    required: params.filter((p) => p.required).map((p) => p.name),
    additionalProperties: false,
  });

  /** @type {Map<string, any>} */
  const byOperation = new Map();
  for (const op of operations) {
    const responseValidators = Object.fromEntries(
      Object.entries(op.responses).map(([status, resp]) => {
        const schema = resp.content?.['application/json']?.schema;
        return [status, schema ? plain.compile(rewriteRefs(schema)) : null];
      }),
    );
    byOperation.set(op.operationId, {
      /** @param {Record<string, unknown>} data @returns {CheckResult} */
      params: check.bind(
        null,
        coercing.compile(rewriteRefs(objectSchema(op.parameters.filter((p) => p.in === 'path')))),
      ),
      /** @param {Record<string, unknown>} data @returns {CheckResult} */
      query: check.bind(
        null,
        coercing.compile(rewriteRefs(objectSchema(op.parameters.filter((p) => p.in === 'query')))),
      ),
      /** @param {unknown} data @returns {CheckResult} */
      body: check.bind(
        null,
        op.requestBodySchema ? plain.compile(rewriteRefs(op.requestBodySchema)) : () => true,
      ),
      /**
       * A status with its own entry (even without a body) is authoritative; otherwise `default` applies.
       * @param {number} status
       * @param {unknown} data
       * @returns {CheckResult}
       */
      response(status, data) {
        const key = String(status) in responseValidators ? String(status) : 'default';
        const fn = responseValidators[key];
        return fn ? check(fn, data) : { ok: true };
      },
    });
  }

  /** @type {Map<string, any>} */
  const components = new Map();
  return {
    /** @param {string} operationId */
    get(operationId) {
      const v = byOperation.get(operationId);
      if (!v) throw new Error(`no validators for ${operationId}`);
      return v;
    },
    /**
     * Validator for a named component schema, e.g. `User`.
     * @param {string} name
     */
    component(name) {
      if (!components.has(name)) {
        components.set(name, plain.compile({ $ref: `${SPEC_ID}#/components/schemas/${name}` }));
      }
      return (/** @type {unknown} */ data) => check(components.get(name), data);
    },
  };
}
