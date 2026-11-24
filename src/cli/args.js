/**
 * True for a non-null, non-array object.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A usage mistake: exit code 2. */
export class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Flags that every command accepts. Their kinds are `boolean` or `string`. */
export const GLOBAL_FLAGS = /** @type {Record<string, 'boolean' | 'string'>} */ ({
  help: 'boolean',
  json: 'boolean',
  yes: 'boolean',
  url: 'string',
  config: 'string',
  'token-file': 'string',
  spec: 'string',
});

/** Names an operation flag may not take, because they are global flags. */
const RESERVED = new Set(Object.keys(GLOBAL_FLAGS));

/**
 * @typedef {{
 *   flag: string,
 *   key: string,
 *   kind: 'path' | 'query' | 'body' | 'rawbody' | 'all',
 *   type: 'string' | 'integer' | 'number' | 'boolean' | 'json',
 *   schema: any,
 *   required: boolean,
 *   description?: string,
 * }} FlagDef
 */

/**
 * `userId` becomes `user-id`, `display_name` becomes `display-name`.
 * @param {string} key
 */
export function toFlagName(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

/**
 * The value type a schema maps to on the command line. Arrays and objects take JSON.
 * @param {any} schema
 * @returns {FlagDef['type']}
 */
export function scalarType(schema) {
  if (Array.isArray(schema?.oneOf ?? schema?.anyOf)) {
    for (const sub of schema.oneOf ?? schema.anyOf) {
      const t = scalarType(sub);
      if (t === 'integer' || t === 'number' || t === 'boolean') return t;
    }
  }
  const types = Array.isArray(schema?.type) ? schema.type : [schema?.type];
  const type = types.find((/** @type {string} */ t) => t !== 'null');
  if (type === 'integer' || type === 'number' || type === 'boolean') return type;
  if (type === 'array' || type === 'object') return 'json';
  return 'string';
}

/**
 * @param {string} key
 * @param {FlagDef['kind']} kind
 * @param {any} schema
 * @param {boolean} required
 * @param {string} [description]
 * @returns {FlagDef}
 */
function makeFlag(key, kind, schema, required, description) {
  return {
    flag: toFlagName(key),
    key,
    kind,
    type: scalarType(schema),
    schema,
    required,
    description: description ?? schema?.description,
  };
}

/**
 * Every flag an operation takes: path and query parameters, `--body` and one flag per top-level
 * body property, and `--all` for paged operations. Throws if two flags collide.
 * @param {import('../client/operations.js').ClientOperation} op
 * @returns {FlagDef[]}
 */
export function operationFlags(op) {
  /** @type {FlagDef[]} */
  const flags = [];
  for (const p of op.pathParams)
    flags.push(makeFlag(p.name, 'path', p.schema, true, p.description));
  for (const q of op.queryParams) {
    flags.push(makeFlag(q.name, 'query', q.schema, q.required, q.description));
  }
  if (op.bodySchema) {
    const required = new Set(op.bodySchema.required ?? []);
    flags.push({
      flag: 'body',
      key: 'body',
      kind: 'rawbody',
      type: 'json',
      schema: op.bodySchema,
      required: false,
      description: 'Whole request body as JSON, or @file.json. Flags override its keys.',
    });
    for (const [key, schema] of Object.entries(op.bodySchema.properties ?? {})) {
      flags.push(makeFlag(key, 'body', schema, required.has(key)));
    }
  }
  if (op.paged) {
    flags.push({
      flag: 'all',
      key: 'all',
      kind: 'all',
      type: 'boolean',
      schema: { type: 'boolean' },
      required: false,
      description: 'Follow next_cursor and print every item',
    });
  }
  /** @type {Set<string>} */
  const seen = new Set();
  for (const f of flags) {
    if (seen.has(f.flag) || RESERVED.has(f.flag)) {
      throw new Error(`${op.command}: flag --${f.flag} is defined twice or is reserved`);
    }
    seen.add(f.flag);
  }
  return flags;
}

/**
 * Split the global flags out of argv. They may appear anywhere. The rest is returned in order.
 * @param {string[]} argv
 * @returns {{ globals: Record<string, string | boolean>, rest: string[] }}
 */
export function splitGlobals(argv) {
  /** @type {Record<string, string | boolean>} */
  const globals = {};
  /** @type {string[]} */
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-h') {
      globals.help = true;
      continue;
    }
    const m = /^--([a-z][a-z-]*)(=.*)?$/s.exec(token);
    if (!m || !Object.hasOwn(GLOBAL_FLAGS, m[1])) {
      rest.push(token);
      continue;
    }
    const name = m[1];
    if (GLOBAL_FLAGS[name] === 'boolean') {
      if (m[2] !== undefined) throw new UsageError(`--${name} takes no value`);
      globals[name] = true;
      continue;
    }
    let value = m[2] === undefined ? undefined : m[2].slice(1);
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--'))
        throw new UsageError(`--${name} needs a value`);
      value = next;
      i++;
    }
    globals[name] = value;
  }
  return { globals, rest };
}

/**
 * The leading tokens that are not flags. Command words come first, and path arguments may follow them.
 * @param {string[]} tokens
 */
export function leadingWords(tokens) {
  const out = [];
  for (const token of tokens) {
    if (token.startsWith('-')) break;
    out.push(token);
  }
  return out;
}

/**
 * Find the operation a command line names: `users list`, the operationId `listUsers`, or a command
 * followed by arguments (`users get <id>`). The longest command wins. Returns the number of words used.
 * @param {string[]} words
 * @param {import('../client/operations.js').ClientOperation[]} operations
 * @returns {{ op: import('../client/operations.js').ClientOperation, words: number } | undefined}
 */
export function matchCommand(words, operations) {
  /** @type {{ op: import('../client/operations.js').ClientOperation, words: number } | undefined} */
  let best;
  for (const op of operations) {
    const cmd = op.command.split(' ');
    if (words.length >= cmd.length && cmd.every((w, i) => words[i] === w)) {
      if (!best || cmd.length > best.words) best = { op, words: cmd.length };
    }
    if (words[0] === op.operationId && (!best || best.words < 1)) {
      best = { op, words: 1 };
    }
  }
  return best;
}

/**
 * Convert one raw flag or argument value by the flag's type.
 * Values the CLI cannot convert are passed on as strings, so the server's validation reports them.
 * @param {string | true} raw
 * @param {FlagDef} def
 * @returns {unknown}
 */
export function convertValue(raw, def) {
  if (def.type === 'boolean') {
    if (raw === true || raw === 'true') return true;
    if (raw === 'false') return false;
    return raw;
  }
  if (raw === true) throw new UsageError(`--${def.flag} needs a value`);
  switch (def.type) {
    case 'integer':
      return /^-?\d+$/.test(raw) ? Number(raw) : raw;
    case 'number':
      return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    case 'json':
      try {
        return JSON.parse(raw);
      } catch {
        throw new UsageError(`--${def.flag} must be JSON`);
      }
    default:
      return raw;
  }
}

/**
 * Read the `--body` argument: JSON text, or `@file` holding it. Must be an object.
 * @param {string | true} raw
 * @param {(path: string) => string} readFile
 * @returns {Record<string, unknown>}
 */
function readBodyArg(raw, readFile) {
  let text = String(raw);
  if (text.startsWith('@')) {
    const path = text.slice(1);
    try {
      text = readFile(path);
    } catch (/** @type {any} */ err) {
      throw new UsageError(`Cannot read ${path}: ${err?.message}`);
    }
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError('--body must be a JSON object, or @file containing one');
  }
  if (!isPlainObject(parsed)) throw new UsageError('--body must be a JSON object');
  return parsed;
}

/**
 * Turn the arguments of one command into path and query params and a request body.
 * Positional arguments fill the path parameters, in path order, that no flag has set.
 * @param {import('../client/operations.js').ClientOperation} op
 * @param {string[]} tokens the arguments after the command words
 * @param {(path: string) => string} readFile
 * @returns {{ params: Record<string, unknown>, body: Record<string, unknown> | undefined, all: boolean }}
 */
export function parseOperationArgs(op, tokens, readFile) {
  const flags = operationFlags(op);
  const byFlag = new Map(flags.map((f) => [f.flag, f]));
  /** @type {Map<FlagDef, string | true>} */
  const values = new Map();
  /** @type {string[]} */
  const positionals = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const m = /^--([^=]+)(?:=(.*))?$/s.exec(token);
    if (!m) {
      if (token.startsWith('-'))
        throw new UsageError(`Unknown flag ${token}. ${flagHint(op, flags)}`);
      positionals.push(token);
      continue;
    }
    const name = m[1];
    const def = byFlag.get(name);
    if (!def)
      throw new UsageError(`Unknown flag --${name} for "${op.command}". ${flagHint(op, flags)}`);
    if (values.has(def)) throw new UsageError(`--${name} is given more than once`);
    if (def.type === 'boolean') {
      if (m[2] !== undefined) {
        values.set(def, m[2]);
      } else if (tokens[i + 1] === 'true' || tokens[i + 1] === 'false') {
        values.set(def, tokens[++i]);
      } else {
        values.set(def, true);
      }
    } else {
      let value = m[2];
      if (value === undefined) {
        const next = tokens[i + 1];
        if (next === undefined || next.startsWith('--'))
          throw new UsageError(`--${name} needs a value`);
        value = next;
        i++;
      }
      values.set(def, value);
    }
  }

  const freePath = flags.filter((f) => f.kind === 'path' && !values.has(f));
  if (positionals.length > freePath.length) {
    const extra = positionals.slice(freePath.length);
    throw new UsageError(`Unexpected argument${extra.length > 1 ? 's' : ''}: ${extra.join(' ')}`);
  }
  positionals.forEach((raw, i) => values.set(freePath[i], raw));

  /** @type {Record<string, unknown>} */
  const params = {};
  /** @type {Record<string, unknown>} */
  const fields = {};
  /** @type {Record<string, unknown> | undefined} */
  let base;
  let all = false;
  for (const [def, raw] of values) {
    if (def.kind === 'all') {
      all = true;
    } else if (def.kind === 'rawbody') {
      base = readBodyArg(raw, readFile);
    } else if (def.kind === 'body') {
      fields[def.key] = convertValue(raw, def);
    } else {
      params[def.key] = convertValue(raw, def);
    }
  }

  for (const p of op.pathParams) {
    if (params[p.name] === undefined) {
      throw new UsageError(
        `Missing <${p.name}>: give it as an argument or as --${toFlagName(p.name)}`,
      );
    }
  }
  for (const q of op.queryParams) {
    if (q.required && params[q.name] === undefined)
      throw new UsageError(`--${toFlagName(q.name)} is required`);
  }

  const hasBody = base !== undefined || Object.keys(fields).length > 0 || op.bodyRequired;
  return { params, body: hasBody ? { ...base, ...fields } : undefined, all };
}

/**
 * @param {import('../client/operations.js').ClientOperation} op
 * @param {FlagDef[]} flags
 */
function flagHint(op, flags) {
  const names = flags.map((f) => `--${f.flag}`).join(', ');
  return names
    ? `Flags for this command: ${names}. Run "tunnus ${op.command} --help".`
    : 'This command takes no flags.';
}
