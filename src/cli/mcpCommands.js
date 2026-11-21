import {
  allowCommitList,
  allowFixedTime,
  clearCommitList,
  disallowMutative,
  getFixedTimeRemainingMs,
  isFixedTimeRunning,
  loadMcpState,
  resolveMcpStatePath,
  saveMcpState,
} from '../client/mcpState.js';
import { ApiError, createApiClient, describeApiError } from '../client/http.js';
import { UsageError } from './args.js';

const MCP_HELP = `Usage:
  tunnus mcp allow [15m | --time <minutes>]
      Allow MCP mutative actions for a fixed time (default 15 minutes).
  tunnus mcp allow commit-list
      Allow MCP mutative actions to be staged into a commit list.
  tunnus mcp status
      Show status of the MCP fixed-time window and staged commit list.
  tunnus mcp list
      List all staged mutative actions in the commit list.
  tunnus mcp commit [--yes]
      Execute all staged actions in the commit list sequentially.
  tunnus mcp clear
      Clear all staged actions from the commit list without executing them.
  tunnus mcp disallow
      Disable MCP mutative actions and clear any active fixed-time window.
`;

/**
 * @param {NodeJS.ReadableStream} stdin
 * @returns {Promise<string>}
 */
function readLine(stdin) {
  return new Promise((resolve) => {
    let buf = '';
    const onData = (/** @type {Buffer | string} */ chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx !== -1) {
        stdin.removeListener('data', onData);
        resolve(buf.slice(0, idx).trim());
      }
    };
    stdin.on('data', onData);
    stdin.once('end', () => resolve(buf.trim()));
  });
}

/**
 * Handle `tunnus mcp ...` CLI commands.
 * @param {string[]} words
 * @param {string[]} rest
 * @param {Record<string, unknown>} globals
 * @param {any} io
 * @param {import('../client/operations.js').ClientOperation[]} operations
 * @param {import('../client/config.js').ResolvedConfig} config
 * @returns {Promise<number>}
 */
export async function handleMcpCli(words, rest, globals, io, operations, config) {
  const { out, err } = { out: io.stdout, err: io.stderr };
  const action = words[0];

  if (!action || globals.help || action === 'help' || action === '--help') {
    out.write(MCP_HELP);
    return 0;
  }

  const statePath = resolveMcpStatePath({
    env: io.env,
    configPath: config.configPath,
    home: io.home,
    platform: io.platform,
  });

  const state = loadMcpState({
    statePath,
    readFile: io.readFile,
  });

  const save = () =>
    saveMcpState({
      statePath,
      state,
      writeFile: io.writeFile,
      mkdir: io.mkdir,
    });

  if (action === 'allow') {
    const sub = words[1];
    if (
      sub === 'commit-list' ||
      rest.includes('--commit-list') ||
      globals['commit-list'] === true
    ) {
      allowCommitList(state);
      save();
      out.write('Mutative actions allowed into commit list for MCP.\n');
      return 0;
    }

    let minutes = 15;
    if (sub) {
      const match = /^(\d+)m?$/i.exec(sub);
      if (match) {
        minutes = parseInt(match[1], 10);
      } else {
        throw new UsageError(`Invalid allow argument "${sub}". Use 15m or commit-list.`);
      }
    }
    const timeFlagIdx = rest.indexOf('--time');
    if (timeFlagIdx !== -1 && rest[timeFlagIdx + 1]) {
      const val = parseInt(rest[timeFlagIdx + 1], 10);
      if (!Number.isNaN(val) && val > 0) minutes = val;
    }

    allowFixedTime(state, minutes);
    save();
    out.write(
      `Mutative actions allowed for MCP for ${minutes} minutes (until ${state.fixedTimeUntil}).\n`,
    );
    return 0;
  }

  if (action === 'disallow' || action === 'revoke') {
    disallowMutative(state);
    save();
    out.write('MCP mutative actions disabled.\n');
    return 0;
  }

  if (action === 'status') {
    const running = isFixedTimeRunning(state);
    const remainingMs = getFixedTimeRemainingMs(state);
    const remainingMin = Math.floor(remainingMs / 60000);
    const remainingSec = Math.floor((remainingMs % 60000) / 1000);

    const statusObj = {
      mode: state.mode,
      fixedTimeRunning: running,
      fixedTimeUntil: state.fixedTimeUntil,
      remainingMs,
      stagedActionsCount: state.commitList.length,
    };

    if (globals.json) {
      out.write(`${JSON.stringify(statusObj, null, 2)}\n`);
      return 0;
    }

    out.write('MCP Mutative Actions Status:\n');
    out.write(`  Commit-list mode: ${state.mode === 'commit-list' ? 'enabled' : 'disabled'}\n`);
    out.write(
      `  Fixed-time window: ${
        running
          ? `active (${remainingMin}m ${remainingSec}s remaining, until ${state.fixedTimeUntil})`
          : 'inactive'
      }\n`,
    );
    out.write(`  Staged actions: ${state.commitList.length}\n`);
    return 0;
  }

  if (action === 'list' || action === 'commit-list') {
    if (globals.json) {
      out.write(`${JSON.stringify(state.commitList, null, 2)}\n`);
      return 0;
    }
    if (state.commitList.length === 0) {
      out.write('Commit list is empty.\n');
      return 0;
    }
    out.write(`Staged actions (${state.commitList.length}):\n`);
    for (let i = 0; i < state.commitList.length; i++) {
      const item = state.commitList[i];
      out.write(
        `  ${i + 1}. [${item.id}] ${item.command} - ${item.summary} (staged ${item.stagedAt})\n`,
      );
      if (item.params && Object.keys(item.params).length > 0) {
        out.write(`     params: ${JSON.stringify(item.params)}\n`);
      }
      if (item.body && Object.keys(/** @type {object} */ (item.body)).length > 0) {
        out.write(`     body: ${JSON.stringify(item.body)}\n`);
      }
    }
    return 0;
  }

  if (action === 'clear') {
    clearCommitList(state);
    save();
    out.write('Commit list cleared.\n');
    return 0;
  }

  if (action === 'commit') {
    if (state.commitList.length === 0) {
      out.write('Commit list is empty.\n');
      return 0;
    }

    if (!config.url || !config.token) {
      throw new UsageError(
        'Executing the commit list requires a configured Tunnus URL and admin token.',
      );
    }

    const opsById = new Map(operations.map((o) => [o.operationId, o]));
    const hasDestructive = state.commitList.some((item) => {
      const op = opsById.get(item.operationId);
      return op?.destructive;
    });

    if (hasDestructive && globals.yes !== true) {
      if (!io.isTTY || !io.stdin) {
        throw new UsageError(
          'The commit list contains destructive actions. Pass --yes to run without a terminal.',
        );
      }
      err.write('The commit list contains destructive actions. Type yes to continue: ');
      const answer = await readLine(io.stdin);
      if (answer !== 'yes') {
        err.write('Aborted.\n');
        return 1;
      }
    }

    const client = createApiClient({
      url: config.url,
      token: config.token,
      fetch: io.fetch,
    });

    const results = [];
    while (state.commitList.length > 0) {
      const item = state.commitList[0];
      const op = opsById.get(item.operationId);
      if (!op) {
        err.write(`Unknown operation ${item.operationId} for staged action ${item.id}\n`);
        return 1;
      }
      try {
        const res = await client.call(op, {
          params: item.params,
          body: item.body,
        });
        results.push({ id: item.id, command: item.command, status: res.status, body: res.body });
        state.commitList.shift();
        save();
        out.write(`✔ [${item.id}] ${item.command} (${res.status})\n`);
      } catch (/** @type {any} */ e) {
        if (e instanceof ApiError) {
          err.write(`Failed to execute ${item.command} (${item.id}):\n`);
          err.write(`${describeApiError(e).join('\n')}\n`);
          return 1;
        }
        err.write(`Failed to execute ${item.command} (${item.id}): ${e?.message ?? e}\n`);
        return 1;
      }
    }

    if (globals.json) {
      out.write(`${JSON.stringify(results, null, 2)}\n`);
    } else {
      out.write('All staged actions executed successfully.\n');
    }
    return 0;
  }

  throw new UsageError(`Unknown mcp command "${action}". Run "tunnus mcp --help" for help.`);
}
