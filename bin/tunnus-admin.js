#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { ensureDefaultGroups } from '../src/accounts.js';
import { bootstrapAdmin, BootstrapInputError, validateBootstrapInput } from '../src/bootstrap.js';
import { parseList } from '../src/config.js';
import { createPool, migrate } from '../src/db.js';

const USAGE = `Usage:
  tunnus-admin bootstrap --email <address> [--name <display name>]
                         [--label <label>] [--expires-days <1-365>]
  tunnus-admin --help

Creates the first admin (or promotes an existing user) and prints an admin
token on stdout. The token is shown only once. Reads DATABASE_URL and
DEFAULT_GROUPS from the environment.

Inside the container:
  docker compose exec app node bin/tunnus-admin.js bootstrap --email admin@example.org
`;

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {{ out: { write(s: string): unknown }, err: { write(s: string): unknown } }} io
 * @returns {Promise<number>} exit code: 0 success, 1 failure, 2 usage error
 */
async function main(argv, env, io) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        email: { type: 'string' },
        name: { type: 'string' },
        label: { type: 'string' },
        'expires-days': { type: 'string' },
      },
    });
  } catch (/** @type {any} */ err) {
    io.err.write(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out.write(USAGE);
    return 0;
  }
  if (positionals.length !== 1 || positionals[0] !== 'bootstrap') {
    io.err.write(`Expected the bootstrap command.\n\n${USAGE}`);
    return 2;
  }
  if (!values.email) {
    io.err.write(`--email is required.\n\n${USAGE}`);
    return 2;
  }
  let expiresDays = 90;
  if (values['expires-days'] !== undefined) {
    if (!/^\d+$/.test(values['expires-days'])) {
      io.err.write('--expires-days must be an integer from 1 to 365\n');
      return 2;
    }
    expiresDays = Number(values['expires-days']);
  }
  const input = {
    email: values.email,
    name: values.name,
    label: values.label,
    expiresDays,
    defaultGroups: parseList(env.DEFAULT_GROUPS),
  };
  try {
    validateBootstrapInput(input);
  } catch (err) {
    if (err instanceof BootstrapInputError) {
      io.err.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
  if (!env.DATABASE_URL) {
    io.err.write('DATABASE_URL is not set\n');
    return 1;
  }

  const pool = createPool(env.DATABASE_URL);
  try {
    await migrate(pool);
    await ensureDefaultGroups(pool, input.defaultGroups);
    const result = await bootstrapAdmin(pool, input);
    io.out.write(`${result.token}\n`);
    const email = input.email.trim().toLowerCase();
    io.err.write(
      result.created
        ? `Created admin user ${email} (id ${result.userId}).\n`
        : `Promoted existing user ${email} (id ${result.userId}) to active admin.\n`,
    );
    if (!result.created && values.name) {
      io.err.write('Note: --name is ignored for an existing user.\n');
    }
    io.err.write(
      `Token ${result.tokenId} expires ${result.expiresAt.toISOString()}. Store it now; it is not shown again.\n`,
    );
    return 0;
  } catch (/** @type {any} */ err) {
    io.err.write(`Bootstrap failed: ${err.message}\n`);
    return 1;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main(process.argv.slice(2), process.env, {
  out: process.stdout,
  err: process.stderr,
});
