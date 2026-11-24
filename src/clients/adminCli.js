import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createPool, migrate } from '../db.js';
import {
  adoptClient,
  ClientError,
  clientJson,
  deleteClient,
  listClientRecords,
  putClient,
  rotateSecret,
} from './store.js';

export const CLIENTS_USAGE = `Usage:
  tunnus-admin clients put <client_id> --metadata-file <path|-> [--secret-env <VAR>] [--generate-secret]
  tunnus-admin clients rotate-secret <client_id> [--secret-env <VAR>] [--generate-secret] [--revoke-tokens]
  tunnus-admin clients adopt <client_id>
  tunnus-admin clients delete <client_id>
  tunnus-admin clients list [--json]

Reads DATABASE_URL (and KEY_ENCRYPTION_SECRET for put / rotate-secret) from the environment.
Secrets are passed via --secret-env <VAR> or generated with --generate-secret; never in argv.
`;

/**
 * Read a stream completely as UTF-8 text.
 * @param {NodeJS.ReadableStream} stream
 * @returns {Promise<string>}
 */
async function readStream(stream) {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Resolve secret input from `--secret-env` / `--generate-secret`.
 * Returns `{ error }` (exit 2) on invalid flag combinations or missing/empty env vars.
 * @param {string | undefined} secretEnv
 * @param {boolean | undefined} generateFlag
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ ok: true, clientSecret?: string, generateSecret: boolean } | { ok: false, message: string }}
 */
function resolveSecretOption(secretEnv, generateFlag, env) {
  if (secretEnv !== undefined && generateFlag) {
    return { ok: false, message: 'Cannot specify both --secret-env and --generate-secret' };
  }
  if (secretEnv !== undefined) {
    const varName = secretEnv.trim();
    if (!varName) {
      return { ok: false, message: '--secret-env requires a non-empty variable name' };
    }
    const val = env[varName];
    if (val === undefined || val === '') {
      return { ok: false, message: `Environment variable "${varName}" is not set or empty` };
    }
    return { ok: true, clientSecret: val, generateSecret: false };
  }
  return { ok: true, generateSecret: Boolean(generateFlag) };
}

/**
 * Validate KEY_ENCRYPTION_SECRET before encrypting client secrets.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
function checkKeyEncryptionSecret(env) {
  const s = env.KEY_ENCRYPTION_SECRET;
  if (!s) return 'KEY_ENCRYPTION_SECRET is not set';
  if (s === 'change-me') return 'KEY_ENCRYPTION_SECRET must not be the example placeholder';
  if (s.length < 32) return 'KEY_ENCRYPTION_SECRET must be at least 32 characters';
  return null;
}

/**
 * Format client records as a plain-text table for `tunnus-admin clients list`.
 * @param {ReturnType<typeof clientJson>[]} items
 * @returns {string}
 */
function formatClientsTable(items) {
  if (items.length === 0) return 'No clients.\n';
  const columns = /** @type {const} */ ([
    'client_id',
    'source',
    'disabled',
    'token_endpoint_auth_method',
    'first_party',
    'redirect_uris',
  ]);
  const rows = items.map((item) =>
    columns.map((c) => {
      const v = item[c];
      return Array.isArray(v) ? v.join(',') : String(v);
    }),
  );
  const widths = columns.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  /** @param {readonly string[]} cells */
  const line = (cells) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i])))
      .join('  ')
      .trimEnd();
  return `${[line(columns), ...rows.map(line)].join('\n')}\n`;
}

/**
 * Write a ClientError cleanly to stderr.
 * @param {{ write(s: string): unknown }} errWriter
 * @param {unknown} err
 */
function writeStoreError(errWriter, err) {
  if (err instanceof ClientError) {
    errWriter.write(`${err.code}: ${err.message}\n`);
    for (const d of err.details ?? []) {
      errWriter.write(`  ${d.path}: ${d.message}\n`);
    }
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  errWriter.write(`Error: ${msg}\n`);
}

/**
 * Execute `tunnus-admin clients <subcommand> ...`.
 * @param {string[]} argv arguments after `clients`
 * @param {NodeJS.ProcessEnv} env
 * @param {{
 *   out: { write(s: string): unknown },
 *   err: { write(s: string): unknown },
 *   stdin?: NodeJS.ReadableStream,
 *   readFile?: (path: string) => string,
 * }} io
 * @returns {Promise<number>} exit code: 0 success, 1 runtime/API error, 2 usage error
 */
export async function runClientsAdmin(argv, env, io) {
  const stdin = io.stdin ?? process.stdin;
  const readFile = io.readFile ?? ((/** @type {string} */ p) => readFileSync(p, 'utf8'));

  if (argv.length === 0) {
    io.err.write(`Expected a clients subcommand.\n\n${CLIENTS_USAGE}`);
    return 2;
  }
  if (argv[0] === '--help' || argv[0] === '-h') {
    io.out.write(CLIENTS_USAGE);
    return 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  if (!['put', 'rotate-secret', 'adopt', 'delete', 'list'].includes(sub)) {
    io.err.write(`Unknown clients subcommand "${sub}".\n\n${CLIENTS_USAGE}`);
    return 2;
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    io.out.write(CLIENTS_USAGE);
    return 0;
  }

  /** @type {{ values: Record<string, any>, positionals: string[] }} */
  let parsed;
  try {
    if (sub === 'put') {
      parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          'metadata-file': { type: 'string' },
          'secret-env': { type: 'string' },
          'generate-secret': { type: 'boolean' },
        },
      });
    } else if (sub === 'rotate-secret') {
      parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          'secret-env': { type: 'string' },
          'generate-secret': { type: 'boolean' },
          'revoke-tokens': { type: 'boolean' },
        },
      });
    } else if (sub === 'list') {
      parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          json: { type: 'boolean' },
        },
      });
    } else {
      parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {},
      });
    }
  } catch (/** @type {any} */ err) {
    io.err.write(`${err.message}\n\n${CLIENTS_USAGE}`);
    return 2;
  }

  const { values, positionals } = parsed;

  if (sub === 'list') {
    if (positionals.length !== 0) {
      io.err.write(`Unexpected argument(s): ${positionals.join(' ')}\n\n${CLIENTS_USAGE}`);
      return 2;
    }
  } else {
    if (positionals.length !== 1) {
      io.err.write(`Expected <client_id>.\n\n${CLIENTS_USAGE}`);
      return 2;
    }
  }

  const clientId = positionals[0];
  /** @type {Record<string, any> | undefined} */
  let metadata;
  /** @type {{ clientSecret?: string, generateSecret: boolean } | undefined} */
  let secretOpt;

  if (sub === 'put') {
    const metadataFile = values['metadata-file'];
    if (!metadataFile) {
      io.err.write(`--metadata-file is required.\n\n${CLIENTS_USAGE}`);
      return 2;
    }
    const resolvedSecret = resolveSecretOption(
      values['secret-env'],
      values['generate-secret'],
      env,
    );
    if (!resolvedSecret.ok) {
      io.err.write(`${resolvedSecret.message}\n`);
      return 2;
    }
    secretOpt = resolvedSecret;

    let rawText;
    try {
      rawText = metadataFile === '-' ? await readStream(stdin) : readFile(metadataFile);
    } catch (/** @type {any} */ err) {
      io.err.write(`Cannot read metadata file ${metadataFile}: ${err.message}\n`);
      return 2;
    }
    let parsedJson;
    try {
      parsedJson = JSON.parse(rawText);
    } catch {
      io.err.write('Metadata file must contain valid JSON\n');
      return 2;
    }
    if (parsedJson === null || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
      io.err.write('Metadata file must contain a JSON object\n');
      return 2;
    }
    metadata = parsedJson;
  }

  if (sub === 'rotate-secret') {
    const resolvedSecret = resolveSecretOption(
      values['secret-env'],
      values['generate-secret'],
      env,
    );
    if (!resolvedSecret.ok) {
      io.err.write(`${resolvedSecret.message}\n`);
      return 2;
    }
    secretOpt = resolvedSecret;
  }

  if (!env.DATABASE_URL) {
    io.err.write('DATABASE_URL is not set\n');
    return 1;
  }

  if (sub === 'put' || sub === 'rotate-secret') {
    const secretErr = checkKeyEncryptionSecret(env);
    if (secretErr) {
      io.err.write(`${secretErr}\n`);
      return 1;
    }
  }

  const pool = createPool(env.DATABASE_URL);
  try {
    await migrate(pool);

    if (sub === 'list') {
      const rows = await listClientRecords(pool);
      const items = rows.map(clientJson);
      if (values.json) {
        io.out.write(`${JSON.stringify({ items }, null, 2)}\n`);
      } else {
        io.out.write(formatClientsTable(items));
      }
      return 0;
    }

    if (sub === 'put') {
      const result = await putClient(pool, /** @type {string} */ (env.KEY_ENCRYPTION_SECRET), {
        clientId,
        metadata: /** @type {Record<string, any>} */ (metadata),
        clientSecret: secretOpt?.clientSecret,
        generateSecret: secretOpt?.generateSecret,
        actorUserId: null,
        via: 'tunnus-admin',
      });
      if (result.generatedSecret) {
        io.out.write(`${result.generatedSecret}\n`);
        io.err.write(
          `Client "${clientId}" ${result.created ? 'created' : 'updated'}. The generated secret is shown only once on stdout; store it now.\n`,
        );
      } else {
        const state = result.created ? 'created' : result.changed ? 'updated' : 'unchanged';
        io.err.write(`Client "${clientId}" ${state}.\n`);
      }
      return 0;
    }

    if (sub === 'rotate-secret') {
      const result = await rotateSecret(pool, /** @type {string} */ (env.KEY_ENCRYPTION_SECRET), {
        clientId,
        clientSecret: secretOpt?.clientSecret,
        revokeTokens: Boolean(values['revoke-tokens']),
        actorUserId: null,
        via: 'tunnus-admin',
      });
      const revokedNote = result.revoked ? ` (revoked ${result.revoked} token/grant rows)` : '';
      if (result.generatedSecret) {
        io.out.write(`${result.generatedSecret}\n`);
        io.err.write(
          `Rotated secret for "${clientId}"${revokedNote}. The generated secret is shown only once on stdout; store it now.\n`,
        );
      } else {
        io.err.write(`Rotated secret for "${clientId}"${revokedNote}.\n`);
      }
      return 0;
    }

    if (sub === 'adopt') {
      const result = await adoptClient(pool, {
        clientId,
        actorUserId: null,
        via: 'tunnus-admin',
      });
      io.out.write(
        result.adopted
          ? `Client "${clientId}" adopted (source is now api).\n`
          : `Client "${clientId}" is already managed via api.\n`,
      );
      return 0;
    }

    if (sub === 'delete') {
      const result = await deleteClient(pool, {
        clientId,
        actorUserId: null,
        via: 'tunnus-admin',
      });
      io.out.write(`Deleted client "${clientId}" (revoked ${result.revoked} token/grant rows).\n`);
      return 0;
    }

    return 2;
  } catch (err) {
    writeStoreError(io.err, err);
    return 1;
  } finally {
    await pool.end();
  }
}
