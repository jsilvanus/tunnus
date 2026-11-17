import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { loadSpec, readSpecText } from '../admin/spec.js';
import { ConfigError, resolveConfig } from '../client/config.js';
import { ApiError, createApiClient, describeApiError } from '../client/http.js';
import { clientOperations } from '../client/operations.js';
import {
  leadingWords,
  matchCommand,
  parseOperationArgs,
  splitGlobals,
  UsageError,
} from './args.js';
import {
  formatCommandHelp,
  formatGroupHelp,
  formatObject,
  formatOverview,
  formatTable,
} from './format.js';

/**
 * @typedef {{ write(text: string): unknown }} Writer
 * @typedef {{
 *   env: Record<string, string | undefined>,
 *   stdout: Writer,
 *   stderr: Writer,
 *   stdin?: NodeJS.ReadableStream,
 *   isTTY?: boolean,
 *   home?: string,
 *   fetch?: typeof globalThis.fetch,
 *   readFile?: (path: string) => string,
 *   stat?: (path: string) => { mode: number },
 * }} CliIo
 * @typedef {import('../client/operations.js').ClientOperation} ClientOperation
 */

/**
 * Read one line from a stream. Resolves with an empty string when the stream ends first.
 * @param {NodeJS.ReadableStream} stdin
 * @returns {Promise<string>}
 */
function readLine(stdin) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, terminal: false });
    let answered = false;
    rl.once('line', (line) => {
      answered = true;
      rl.close();
      resolve(line);
    });
    rl.once('close', () => {
      if (!answered) resolve('');
    });
  });
}

/**
 * Follow `next_cursor` until the last page and return every item as one list.
 * @param {ReturnType<typeof createApiClient>} client
 * @param {ClientOperation} op
 * @param {{ params: Record<string, unknown>, body: unknown }} args
 */
async function listAll(client, op, { params, body }) {
  /** @type {unknown[]} */
  const items = [];
  let cursor = params.cursor;
  for (;;) {
    const res = await client.call(op, { params: { ...params, cursor }, body });
    items.push(...res.body.items);
    cursor = res.body.next_cursor;
    if (!cursor) break;
  }
  return { status: 200, body: { items, next_cursor: null } };
}

/**
 * Run the CLI. Returns the exit code: 0 success, 1 failure (API, network or refused confirmation),
 * 2 usage or configuration problem.
 * @param {string[]} argv
 * @param {CliIo} io
 * @returns {Promise<number>}
 */
export async function main(argv, io) {
  const err = io.stderr;
  const readFile = io.readFile ?? ((/** @type {string} */ path) => readFileSync(path, 'utf8'));
  const stat = io.stat ?? ((/** @type {string} */ path) => statSync(path));
  try {
    return await run(argv, { ...io, readFile, stat, fetch: io.fetch ?? globalThis.fetch });
  } catch (/** @type {any} */ e) {
    if (e instanceof UsageError || e instanceof ConfigError) {
      err.write(`${e.message}\n`);
      return 2;
    }
    if (e instanceof ApiError) {
      err.write(`${describeApiError(e).join('\n')}\n`);
      return 1;
    }
    err.write(`Error: ${e?.message ?? e}\n`);
    return 1;
  }
}

/**
 * @param {string[]} argv
 * @param {CliIo & { readFile: (path: string) => string, stat: (path: string) => { mode: number }, fetch: typeof globalThis.fetch }} io
 * @returns {Promise<number>}
 */
async function run(argv, io) {
  const { out, err } = { out: io.stdout, err: io.stderr };
  const { globals, rest } = splitGlobals(argv);

  const specPath = typeof globals.spec === 'string' ? globals.spec : io.env.TUNNUS_SPEC;
  let specText;
  try {
    specText = specPath ? io.readFile(specPath) : readSpecText();
  } catch (/** @type {any} */ e) {
    throw new ConfigError(`Cannot read the spec ${specPath}: ${e?.message}`);
  }
  const operations = clientOperations(loadSpec(specText));

  const words = leadingWords(rest);
  if (words.length === 0) {
    if (globals.help) {
      out.write(formatOverview(operations));
      return 0;
    }
    err.write(formatOverview(operations));
    return 2;
  }
  const match = matchCommand(words, operations);
  if (!match) {
    if (globals.help) {
      const group = operations.filter((op) => op.command.split(' ')[0] === words[0]);
      if (group.length) {
        out.write(formatGroupHelp(words[0], group));
        return 0;
      }
    }
    throw new UsageError(`Unknown command "${words.join(' ')}". Run "tunnus --help" for the list.`);
  }
  const { op } = match;
  if (globals.help) {
    out.write(formatCommandHelp(op));
    return 0;
  }

  const parsed = parseOperationArgs(op, rest.slice(match.words), io.readFile);

  const config = resolveConfig({
    flags: {
      url: typeof globals.url === 'string' ? globals.url : undefined,
      config: typeof globals.config === 'string' ? globals.config : undefined,
      tokenFile: typeof globals['token-file'] === 'string' ? globals['token-file'] : undefined,
    },
    env: io.env,
    home: io.home ?? homedir(),
    readFile: io.readFile,
    stat: io.stat,
  });
  for (const warning of config.warnings) err.write(`warning: ${warning}\n`);
  if (!config.url) {
    throw new UsageError(
      'No Tunnus URL. Set TUNNUS_URL, pass --url, or add "url" to the config file (see tunnus --help).',
    );
  }
  if (!config.token) {
    throw new UsageError(
      'No admin token. Set TUNNUS_ADMIN_TOKEN, pass --token-file, or add "token" to the config file.',
    );
  }

  if (op.destructive && globals.yes !== true) {
    if (!io.isTTY || !io.stdin) {
      throw new UsageError(
        `"${op.command}" is destructive. Pass --yes to run it without a terminal.`,
      );
    }
    err.write(`"${op.command}" cannot be undone. Type yes to continue: `);
    const answer = await readLine(io.stdin);
    if (answer.trim() !== 'yes') {
      err.write('Aborted.\n');
      return 1;
    }
  }

  const client = createApiClient({ url: config.url, token: config.token, fetch: io.fetch });
  const result = parsed.all ? await listAll(client, op, parsed) : await client.call(op, parsed);

  if (globals.json === true) {
    if (result.body !== undefined) out.write(`${JSON.stringify(result.body, null, 2)}\n`);
  } else if (result.body !== undefined) {
    const itemSchema = op.responseSchema?.properties?.items?.items;
    out.write(
      itemSchema && Array.isArray(result.body.items)
        ? formatTable(result.body.items, itemSchema)
        : formatObject(result.body),
    );
  }
  if (!parsed.all && result.body?.next_cursor) {
    err.write(`More results: add --cursor ${result.body.next_cursor}\n`);
  }
  if (op.operationId === 'createAdminToken' && result.status === 201) {
    err.write('The token is shown only once. Store it now.\n');
  }
  return 0;
}
