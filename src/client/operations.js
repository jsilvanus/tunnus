import { listOperations } from '../admin/spec.js';

/**
 * @typedef {{
 *   name: string,
 *   required: boolean,
 *   schema: any,
 *   description?: string,
 * }} ParamDef
 */

/**
 * One operation as the CLI and MCP server see it. Built from openapi.yaml at run time.
 * @typedef {{
 *   operationId: string,
 *   command: string,
 *   method: string,
 *   path: string,
 *   summary: string,
 *   description: string,
 *   destructive: boolean,
 *   mcp: boolean,
 *   pathParams: ParamDef[],
 *   queryParams: ParamDef[],
 *   bodySchema: any | null,
 *   bodyRequired: boolean,
 *   responseSchema: any | null,
 *   paged: boolean,
 * }} ClientOperation
 */

/**
 * Follow a local `#/...` JSON pointer.
 * @param {any} spec
 * @param {string} ref
 */
function resolvePointer(spec, ref) {
  if (!ref.startsWith('#/')) throw new Error(`Unsupported $ref ${ref}`);
  const target = ref
    .slice(2)
    .split('/')
    .reduce(
      (/** @type {any} */ node, /** @type {string} */ key) =>
        node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')],
      spec,
    );
  if (target === undefined) throw new Error(`Unresolvable $ref ${ref}`);
  return target;
}

/**
 * Replace every `$ref` in a schema with its target, so the result is self-contained JSON Schema.
 * Sibling keywords next to a `$ref` (such as `description`) are kept and win over the target's.
 * @param {any} spec
 * @param {any} node
 * @param {string[]} [stack] references being expanded, to detect cycles
 * @returns {any}
 */
export function inlineRefs(spec, node, stack = []) {
  if (Array.isArray(node)) return node.map((item) => inlineRefs(spec, item, stack));
  if (node === null || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string') {
    const { $ref, ...siblings } = node;
    if (stack.includes($ref)) throw new Error(`Recursive $ref ${$ref} cannot be inlined`);
    return {
      ...inlineRefs(spec, resolvePointer(spec, $ref), [...stack, $ref]),
      ...inlineRefs(spec, siblings, stack),
    };
  }
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, inlineRefs(spec, value, stack)]),
  );
}

/**
 * Build the operation model. Throws when an operation has no `x-tunnus-cli` or two share a command.
 * @param {any} spec
 * @returns {ClientOperation[]}
 */
export function clientOperations(spec) {
  /** @type {Map<string, string>} */
  const commands = new Map();
  /** @type {ClientOperation[]} */
  const out = [];
  for (const op of listOperations(spec)) {
    const raw = spec.paths[op.path][op.method];
    const command = raw['x-tunnus-cli'];
    if (typeof command !== 'string' || command.trim() === '') {
      throw new Error(`${op.operationId} has no x-tunnus-cli`);
    }
    const clash = commands.get(command);
    if (clash !== undefined) {
      throw new Error(`x-tunnus-cli "${command}" is used by ${clash} and ${op.operationId}`);
    }
    commands.set(command, op.operationId);

    /** @type {ParamDef[]} */
    const pathParams = [];
    /** @type {ParamDef[]} */
    const queryParams = [];
    for (const p of op.parameters) {
      if (p.in !== 'path' && p.in !== 'query') {
        throw new Error(`${op.operationId}: unsupported parameter location ${p.in}`);
      }
      /** @type {ParamDef} */
      const def = {
        name: p.name,
        required: p.in === 'path' ? true : Boolean(p.required),
        schema: inlineRefs(spec, p.schema ?? { type: 'string' }),
        description: p.description,
      };
      if (p.in === 'path') pathParams.push(def);
      else queryParams.push(def);
    }
    // Path parameters in the order they appear in the path, which is the order positional arguments take.
    pathParams.sort((a, b) => op.path.indexOf(`{${a.name}}`) - op.path.indexOf(`{${b.name}}`));

    const successKey = ['200', '201'].find((k) => op.responses[k]);
    const responseSchema = successKey
      ? op.responses[successKey].content?.['application/json']?.schema
      : undefined;

    const destructive = raw['x-tunnus-destructive'] === true;
    out.push({
      operationId: op.operationId,
      command,
      method: op.method,
      path: op.path,
      summary: raw.summary ?? op.operationId,
      description: raw.description ?? '',
      destructive,
      mcp: raw['x-tunnus-mcp'] !== false && !destructive,
      pathParams,
      queryParams,
      bodySchema: op.requestBodySchema ? inlineRefs(spec, op.requestBodySchema) : null,
      bodyRequired: op.requestBodyRequired,
      responseSchema: responseSchema ? inlineRefs(spec, responseSchema) : null,
      paged: queryParams.some((q) => q.name === 'cursor'),
    });
  }
  return out;
}
