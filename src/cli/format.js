import { operationFlags } from './args.js';

/** Cells longer than this are cut, ending with an ellipsis. */
export const CELL_MAX = 40;

const SCALAR_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'null']);

/**
 * @param {any} schema
 * @returns {string[]}
 */
function typesOf(schema) {
  return Array.isArray(schema?.type) ? schema.type : [schema?.type];
}

/**
 * A property shows as a column when it is a scalar, or an array of scalars.
 * @param {any} schema
 */
function isColumn(schema) {
  const types = typesOf(schema);
  if (types.every((t) => SCALAR_TYPES.has(t))) return true;
  return (
    types.includes('array') &&
    schema.items &&
    typesOf(schema.items).every((t) => SCALAR_TYPES.has(t))
  );
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function scalarText(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(scalarText).join(',');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function cell(value) {
  const text = scalarText(value).replace(/\s*\n\s*/g, ' ');
  return text.length > CELL_MAX ? `${text.slice(0, CELL_MAX - 1)}…` : text;
}

/**
 * A plain-text table of the item schema's scalar properties, in schema order.
 * @param {Record<string, unknown>[]} items
 * @param {any} itemSchema
 * @returns {string}
 */
export function formatTable(items, itemSchema) {
  if (items.length === 0) return 'No items.\n';
  const isRestrictedOutput = items.some(
    (item) =>
      typeof item.id === 'string' && (item.id.startsWith('pseudo:') || item.id.startsWith('ref:')),
  );
  const columns = Object.entries(itemSchema?.properties ?? {})
    .filter(([, schema]) => isColumn(schema))
    .map(([name]) => name)
    .filter((name) => !isRestrictedOutput || items.some((item) => item[name] !== undefined));
  const rows = items.map((item) => columns.map((c) => cell(item[c])));
  const widths = columns.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  /** @param {string[]} cells */
  const line = (cells) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i])))
      .join('  ')
      .trimEnd();
  return `${[line(columns), ...rows.map(line)].join('\n')}\n`;
}

/**
 * `key: value` lines for one object. Nested objects are flattened to dotted keys.
 * @param {Record<string, unknown>} obj
 * @param {string} [prefix]
 * @returns {string}
 */
export function formatObject(obj, prefix = '') {
  /** @type {string[]} */
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    const name = `${prefix}${key}`;
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0
    ) {
      lines.push(
        formatObject(/** @type {Record<string, unknown>} */ (value), `${name}.`).trimEnd(),
      );
    } else if (Array.isArray(value) && value.some((v) => typeof v === 'object' && v !== null)) {
      lines.push(`${name}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${name}: ${value === null ? 'null' : scalarText(value)}`);
    }
  }
  return `${lines.filter((l) => l !== '').join('\n')}\n`;
}

/**
 * The command list shown by `tunnus --help`, grouped by first word.
 * @param {import('../client/operations.js').ClientOperation[]} operations
 * @returns {string}
 */
export function formatOverview(operations) {
  /** @type {Map<string, import('../client/operations.js').ClientOperation[]>} */
  const groups = new Map();
  for (const op of operations) {
    const first = op.command.split(' ')[0];
    groups.set(first, [...(groups.get(first) ?? []), op]);
  }
  const width = Math.max(...operations.map((op) => op.command.length));
  const commands = [...groups.values()]
    .map((ops) => ops.map((op) => `  ${op.command.padEnd(width)}  ${op.summary}`).join('\n'))
    .join('\n\n');
  return `Usage:
  tunnus <command> [arguments] [flags]
  tunnus <command> --help

Commands:
${commands}

Global flags:
  --url <url>          Issuer URL (env TUNNUS_URL)
  --config <file>      Config file (env TUNNUS_CONFIG)
  --token-file <file>  Read the admin token from a file (env TUNNUS_ADMIN_TOKEN)
  --spec <file>        Use another openapi.yaml (env TUNNUS_SPEC)
  --json               Print the response body as JSON
  --yes                Confirm a destructive command
  --help               Show help

Configuration: the URL and token come from --url / TUNNUS_URL and TUNNUS_ADMIN_TOKEN, or from
a config file (default $XDG_CONFIG_HOME/tunnus/config.json, else ~/.config/tunnus/config.json)
holding {"url": "...", "token": "..."}. The token is never accepted on the command line.
`;
}

/**
 * Help for the commands under one first word (`tunnus users --help`).
 * @param {string} word
 * @param {import('../client/operations.js').ClientOperation[]} operations
 * @returns {string}
 */
export function formatGroupHelp(word, operations) {
  const width = Math.max(...operations.map((op) => op.command.length));
  return `Commands under "${word}":\n${operations
    .map((op) => `  ${op.command.padEnd(width)}  ${op.summary}`)
    .join('\n')}\n\nRun "tunnus <command> --help" for its flags.\n`;
}

/**
 * Constraints of a schema as short text: required, enum, default, range.
 * @param {any} schema
 * @param {boolean} required
 */
function constraints(schema, required) {
  /** @type {string[]} */
  const parts = [];
  if (required) parts.push('required');
  if (Array.isArray(schema?.enum)) parts.push(`one of ${schema.enum.join(', ')}`);
  if (schema?.default !== undefined) parts.push(`default ${JSON.stringify(schema.default)}`);
  const alternatives = schema?.oneOf ?? schema?.anyOf;
  const target = Array.isArray(alternatives) ? alternatives[0] : schema;
  const { minimum, maximum } = target ?? {};
  if (minimum !== undefined && maximum !== undefined) parts.push(`${minimum}..${maximum}`);
  else if (minimum !== undefined) parts.push(`at least ${minimum}`);
  else if (maximum !== undefined) parts.push(`at most ${maximum}`);
  return parts;
}

/**
 * Full help for one command.
 * @param {import('../client/operations.js').ClientOperation} op
 * @returns {string}
 */
export function formatCommandHelp(op) {
  const flags = operationFlags(op);
  const usage = [
    `tunnus ${op.command}`,
    ...op.pathParams.map((p) => `<${p.name}>`),
    ...(flags.some((f) => f.kind !== 'path') ? ['[flags]'] : []),
  ].join(' ');
  /** @type {string[]} */
  const out = [usage, `${op.method.toUpperCase()} ${op.path}`, '', op.summary];
  if (op.description) out.push('', op.description);
  if (op.pathParams.length) {
    out.push('', 'Arguments:');
    for (const p of op.pathParams) {
      const detail = [p.schema?.format ?? scalarType(p.schema), ...constraints(p.schema, true)];
      out.push(`  <${p.name}>  ${detail.join('; ')}`);
    }
  }
  const named = flags.filter((f) => f.kind !== 'path');
  if (named.length) {
    out.push('', 'Flags:');
    for (const f of named) {
      const parts = [f.description, ...constraints(f.schema, f.required)].filter(Boolean);
      const arg = f.type === 'boolean' ? '' : ` <${f.type}>`;
      out.push(`  --${f.flag}${arg}${parts.length ? `  ${parts.join('; ')}` : ''}`);
    }
  }
  out.push('', 'Global flags: see tunnus --help.');
  if (op.destructive) {
    out.push(
      '',
      'Destructive: asks for confirmation on a terminal; pass --yes to skip the question.',
    );
  }
  if (!op.mcp) out.push('Not exposed as an MCP tool.');
  return `${out.join('\n')}\n`;
}

/**
 * @param {any} schema
 * @returns {string}
 */
function scalarType(schema) {
  if (Array.isArray(schema?.oneOf ?? schema?.anyOf)) {
    for (const sub of schema.oneOf ?? schema.anyOf) {
      /** @type {string} */
      const t = scalarType(sub);
      if (t !== 'value' && t !== 'string') return t;
    }
  }
  const types = typesOf(schema).filter((t) => t !== 'null');
  return types[0] ?? 'value';
}
