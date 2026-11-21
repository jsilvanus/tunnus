import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadSpec } from '../src/admin/spec.js';
import {
  allowCommitList,
  allowFixedTime,
  clearCommitList,
  createDefaultState,
  disallowMutative,
  getFixedTimeRemainingMs,
  isFixedTimeRunning,
  loadMcpState,
  resolveMcpStatePath,
  saveMcpState,
  stageAction,
} from '../src/client/mcpState.js';
import { createMcpServer } from '../src/mcp/server.js';
import { main } from '../src/cli/main.js';

const spec = loadSpec();

/**
 * @param {Parameters<typeof createMcpServer>[0]} deps
 */
async function connect(deps) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(deps);
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return { client, server };
}

describe('mcpState module', () => {
  it('resolves state path from TUNNUS_MCP_STATE, configPath, XDG_CONFIG_HOME or HOME', () => {
    expect(resolveMcpStatePath({ env: { TUNNUS_MCP_STATE: '/custom/state.json' } })).toBe(
      '/custom/state.json',
    );
    expect(
      resolveMcpStatePath({
        env: {},
        configPath: '/home/alex/.config/tunnus/config.json',
        platform: 'linux',
      }),
    ).toBe('/home/alex/.config/tunnus/mcp-state.json');
    expect(
      resolveMcpStatePath({
        env: { XDG_CONFIG_HOME: '/xdg' },
        home: '/home/alex',
        platform: 'linux',
      }),
    ).toBe('/xdg/tunnus/mcp-state.json');
    expect(
      resolveMcpStatePath({
        env: {},
        home: '/home/alex',
        platform: 'linux',
      }),
    ).toBe('/home/alex/.config/tunnus/mcp-state.json');
  });

  it('loads default state when file is missing or invalid', () => {
    expect(
      loadMcpState({
        statePath: '/missing.json',
        readFile: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toEqual(createDefaultState());
    expect(
      loadMcpState({
        statePath: '/invalid.json',
        readFile: () => 'not json',
      }),
    ).toEqual(createDefaultState());
  });

  it('saves and loads state', () => {
    /** @type {Record<string, string>} */
    const store = {};
    const state = createDefaultState();
    allowCommitList(state);
    allowFixedTime(state, 15, 1000000);
    stageAction(
      state,
      {
        operationId: 'createUser',
        command: 'users create',
        summary: 'Create user',
        method: 'post',
        path: '/users',
        params: {},
        body: { email: 'a@example.org' },
      },
      1000000,
    );

    saveMcpState({
      statePath: '/state.json',
      state,
      writeFile: (p, c) => {
        store[p] = c;
      },
      mkdir: () => {},
    });

    const loaded = loadMcpState({
      statePath: '/state.json',
      readFile: (p) => store[p],
    });

    expect(loaded.mode).toBe('commit-list');
    expect(loaded.fixedTimeUntil).toBe(new Date(1000000 + 15 * 60 * 1000).toISOString());
    expect(loaded.commitList).toHaveLength(1);
    expect(loaded.commitList[0].operationId).toBe('createUser');
  });

  it('manages fixed-time window and calculations', () => {
    const state = createDefaultState();
    expect(isFixedTimeRunning(state, 1000)).toBe(false);
    expect(getFixedTimeRemainingMs(state, 1000)).toBe(0);

    allowFixedTime(state, 15, 100000);
    expect(isFixedTimeRunning(state, 100000)).toBe(true);
    expect(getFixedTimeRemainingMs(state, 100000)).toBe(15 * 60 * 1000);
    expect(isFixedTimeRunning(state, 100000 + 16 * 60 * 1000)).toBe(false);
    expect(getFixedTimeRemainingMs(state, 100000 + 16 * 60 * 1000)).toBe(0);

    disallowMutative(state);
    expect(state.mode).toBe('disabled');
    expect(state.fixedTimeUntil).toBeNull();
    expect(isFixedTimeRunning(state, 100000)).toBe(false);
  });

  it('stages and clears actions in commit list', () => {
    const state = createDefaultState();
    const action = stageAction(
      state,
      {
        operationId: 'deleteUser',
        command: 'users delete',
        summary: 'Delete user',
        method: 'delete',
        path: '/users/123',
        params: { userId: '123' },
        body: undefined,
      },
      2000,
    );

    expect(action.id).toBeDefined();
    expect(action.stagedAt).toBe(new Date(2000).toISOString());
    expect(state.commitList).toHaveLength(1);

    clearCommitList(state);
    expect(state.commitList).toEqual([]);
  });
});

describe('MCP server mutative action enforcement', () => {
  it('allows read-only actions even when mutative actions are disabled', async () => {
    let called = false;
    const { client } = await connect({
      spec,
      state: { mode: 'disabled', fixedTimeUntil: null, commitList: [] },
      callApi: async (op) => {
        called = true;
        expect(op.method).toBe('get');
        return { status: 200, body: { email: 'admin@example.org' } };
      },
    });

    const res = await client.callTool({ name: 'getMe', arguments: {} });
    expect(called).toBe(true);
    expect(res.isError).toBeFalsy();
  });

  it('rejects mutative actions when mode is disabled and no window is active', async () => {
    let called = false;
    const { client } = await connect({
      spec,
      state: { mode: 'disabled', fixedTimeUntil: null, commitList: [] },
      callApi: async () => {
        called = true;
        return { status: 200, body: {} };
      },
    });

    const res = await client.callTool({
      name: 'createUser',
      arguments: { body: { email: 'new@example.org' } },
    });
    expect(called).toBe(false);
    expect(res.isError).toBe(true);
    expect(/** @type {any} */ (res).content[0].text).toContain(
      'Mutative actions are currently disabled',
    );
  });

  it('stages mutative action into commit list when mode is commit-list and no window is active', async () => {
    let called = false;
    const state = {
      mode: /** @type {const} */ ('commit-list'),
      fixedTimeUntil: null,
      commitList: /** @type {import('../src/client/mcpState.js').StagedAction[]} */ ([]),
    };
    const { client } = await connect({
      spec,
      state,
      callApi: async () => {
        called = true;
        return { status: 200, body: {} };
      },
    });

    const res = await client.callTool({
      name: 'createUser',
      arguments: { body: { email: 'staged@example.org' } },
    });
    expect(called).toBe(false);
    expect(res.isError).toBeFalsy();
    expect(/** @type {any} */ (res.structuredContent).staged).toBe(true);
    expect(state.commitList).toHaveLength(1);
    expect(state.commitList[0].operationId).toBe('createUser');
    expect(state.commitList[0].body).toEqual({ email: 'staged@example.org' });
  });

  it('executes mutative actions directly when fixed-time window is active', async () => {
    let called = false;
    const state = {
      mode: /** @type {const} */ ('disabled'),
      fixedTimeUntil: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      commitList: [],
    };
    const { client } = await connect({
      spec,
      state,
      callApi: async (op, args) => {
        called = true;
        expect(op.operationId).toBe('createUser');
        expect(args.body).toEqual({ email: 'direct@example.org' });
        return { status: 201, body: { id: 'u-1', email: 'direct@example.org' } };
      },
    });

    const res = await client.callTool({
      name: 'createUser',
      arguments: { body: { email: 'direct@example.org' } },
    });
    expect(called).toBe(true);
    expect(res.isError).toBeFalsy();
    expect(/** @type {any} */ (res.structuredContent).id).toBe('u-1');
    expect(state.commitList).toHaveLength(0);
  });

  it('supports destructive actions in MCP under the mutative gate', async () => {
    let called = false;
    const state = {
      mode: /** @type {const} */ ('disabled'),
      fixedTimeUntil: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      commitList: [],
    };
    const { client } = await connect({
      spec,
      state,
      callApi: async (op, args) => {
        called = true;
        expect(op.operationId).toBe('deleteUser');
        expect(args.params.userId).toBe('6f1b1d0e-3c1e-4c7a-9a52-2f0f5a3c9b11');
        return { status: 204, body: {} };
      },
    });

    const res = await client.callTool({
      name: 'deleteUser',
      arguments: { userId: '6f1b1d0e-3c1e-4c7a-9a52-2f0f5a3c9b11' },
    });
    expect(called).toBe(true);
    expect(res.isError).toBeFalsy();
  });

  it('inspects commit list via getCommitList tool', async () => {
    const state = {
      mode: /** @type {const} */ ('commit-list'),
      fixedTimeUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      commitList: [
        {
          id: 'c-1',
          operationId: 'createGroup',
          command: 'groups create',
          summary: 'Create group',
          method: 'post',
          path: '/groups',
          params: {},
          body: { name: 'devs' },
          stagedAt: new Date().toISOString(),
        },
      ],
    };

    const { client } = await connect({
      spec,
      state,
      callApi: async () => ({ status: 200, body: {} }),
    });

    const res = await client.callTool({ name: 'getCommitList', arguments: {} });
    expect(res.isError).toBeFalsy();
    const data = /** @type {any} */ (res.structuredContent);
    expect(data.mode).toBe('commit-list');
    expect(data.fixedTimeRunning).toBe(true);
    expect(data.commitList).toHaveLength(1);
  });

  it('refuses to execute commit list via MCP when fixed-time window is not running', async () => {
    const state = {
      mode: /** @type {const} */ ('commit-list'),
      fixedTimeUntil: null,
      commitList: [
        {
          id: 'c-1',
          operationId: 'createGroup',
          command: 'groups create',
          summary: 'Create group',
          method: 'post',
          path: '/groups',
          params: {},
          body: { name: 'devs' },
          stagedAt: new Date().toISOString(),
        },
      ],
    };

    const { client } = await connect({
      spec,
      state,
      callApi: async () => ({ status: 200, body: {} }),
    });

    const res = await client.callTool({ name: 'executeCommitList', arguments: {} });
    expect(res.isError).toBe(true);
    expect(/** @type {any} */ (res).content[0].text).toContain('fixed-time window is running');
    expect(state.commitList).toHaveLength(1);
  });

  it('executes commit list via MCP when fixed-time window is active', async () => {
    /** @type {string[]} */
    const executedOps = [];
    const state = {
      mode: /** @type {const} */ ('commit-list'),
      fixedTimeUntil: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      listLocked: true,
      commitList: [
        {
          id: 'c-1',
          operationId: 'createGroup',
          command: 'groups create',
          summary: 'Create group',
          method: 'post',
          path: '/groups',
          params: {},
          body: { name: 'devs' },
          stagedAt: new Date().toISOString(),
        },
        {
          id: 'c-2',
          operationId: 'createUser',
          command: 'users create',
          summary: 'Create user',
          method: 'post',
          path: '/users',
          params: {},
          body: { email: 'dev@example.org' },
          stagedAt: new Date().toISOString(),
        },
      ],
    };

    const { client } = await connect({
      spec,
      state,
      callApi: async (op) => {
        executedOps.push(op.operationId);
        return { status: 201, body: { id: op.operationId } };
      },
    });

    const res = await client.callTool({ name: 'executeCommitList', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(executedOps).toEqual(['createGroup', 'createUser']);
    expect(state.commitList).toHaveLength(0);
  });

  it('refuses to execute commit list via MCP when list is not locked', async () => {
    const state = {
      mode: /** @type {const} */ ('commit-list'),
      fixedTimeUntil: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      listLocked: false,
      commitList: [
        {
          id: 'c-1',
          operationId: 'createGroup',
          command: 'groups create',
          summary: 'Create group',
          method: 'post',
          path: '/groups',
          params: {},
          body: { name: 'devs' },
          stagedAt: new Date().toISOString(),
        },
      ],
    };

    const { client } = await connect({
      spec,
      state,
      callApi: async () => ({ status: 201, body: {} }),
    });

    const res = await client.callTool({ name: 'executeCommitList', arguments: {} });
    expect(res.isError).toBe(true);
    expect(/** @type {any} */ (res).content[0].text).toContain(
      'The commit list must be locked before execution',
    );
  });

  it('clears commit list via clearCommitList tool', async () => {
    const state = {
      mode: /** @type {const} */ ('commit-list'),
      fixedTimeUntil: null,
      commitList: [
        {
          id: 'c-1',
          operationId: 'createGroup',
          command: 'groups create',
          summary: 'Create group',
          method: 'post',
          path: '/groups',
          params: {},
          body: { name: 'devs' },
          stagedAt: new Date().toISOString(),
        },
      ],
    };

    const { client } = await connect({
      spec,
      state,
      callApi: async () => ({ status: 200, body: {} }),
    });

    const res = await client.callTool({ name: 'clearCommitList', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(state.commitList).toHaveLength(0);
  });
});

describe('CLI tunnus mcp commands', () => {
  /**
   * Helper to run CLI with injected in-memory files and streams.
   * @param {string[]} argv
   * @param {{ files?: Record<string, string>, fetch?: any, isTTY?: boolean, stdin?: NodeJS.ReadableStream }} [opts]
   */
  async function runCli(argv, opts = {}) {
    /** @type {string[]} */
    const out = [];
    /** @type {string[]} */
    const err = [];
    /** @type {Record<string, string>} */
    const files = {
      '/home/alex/.config/tunnus/config.json': JSON.stringify({
        url: 'https://id.example.org',
        token: 'tun_test_token',
      }),
      ...(opts.files ?? {}),
    };

    const code = await main(argv, {
      env: { TUNNUS_URL: 'https://id.example.org', TUNNUS_ADMIN_TOKEN: 'tun_test_token' },
      home: '/home/alex',
      platform: 'linux',
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      stdin: opts.stdin,
      isTTY: opts.isTTY ?? false,
      fetch: opts.fetch ?? (async () => new Response(JSON.stringify({}), { status: 200 })),
      readFile: (p) => {
        if (p in files) return files[p];
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      writeFile: (p, c) => {
        files[p] = c;
      },
      mkdir: () => {},
      stat: () => ({ mode: 0o600 }),
    });

    return { code, out: out.join(''), err: err.join(''), files };
  }

  it('prints mcp help on tunnus mcp --help', async () => {
    const { code, out } = await runCli(['mcp', '--help']);
    expect(code).toBe(0);
    expect(out).toContain('tunnus mcp allow');
    expect(out).toContain('tunnus mcp commit');
    expect(out).toContain('tunnus mcp status');
  });

  it('allows fixed time for 15 minutes by default or with custom duration', async () => {
    const res1 = await runCli(['mcp', 'allow']);
    expect(res1.code).toBe(0);
    expect(res1.out).toContain('allowed for MCP for 15 minutes');
    const state1 = JSON.parse(res1.files['/home/alex/.config/tunnus/mcp-state.json']);
    expect(state1.fixedTimeUntil).toBeDefined();

    const res2 = await runCli(['mcp', 'allow', '30m'], { files: res1.files });
    expect(res2.code).toBe(0);
    expect(res2.out).toContain('allowed for MCP for 30 minutes');
  });

  it('allows commit-list mode', async () => {
    const res = await runCli(['mcp', 'allow', 'commit-list']);
    expect(res.code).toBe(0);
    expect(res.out).toContain('allowed into commit list');
    const state = JSON.parse(res.files['/home/alex/.config/tunnus/mcp-state.json']);
    expect(state.mode).toBe('commit-list');
  });

  it('disables mutative actions with tunnus mcp disallow', async () => {
    const res1 = await runCli(['mcp', 'allow', '15m']);
    const res2 = await runCli(['mcp', 'disallow'], { files: res1.files });
    expect(res2.code).toBe(0);
    expect(res2.out).toContain('MCP mutative actions disabled');
    const state = JSON.parse(res2.files['/home/alex/.config/tunnus/mcp-state.json']);
    expect(state.mode).toBe('disabled');
    expect(state.fixedTimeUntil).toBeNull();
  });

  it('displays status and lists staged actions', async () => {
    const state = {
      mode: 'commit-list',
      fixedTimeUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      commitList: [
        {
          id: 'c-1',
          operationId: 'createUser',
          command: 'users create',
          summary: 'Create user',
          method: 'post',
          path: '/users',
          params: {},
          body: { email: 'test@example.org' },
          stagedAt: '2026-11-21T09:00:00.000Z',
        },
      ],
    };

    const files = {
      '/home/alex/.config/tunnus/mcp-state.json': JSON.stringify(state),
    };

    const statusRes = await runCli(['mcp', 'status'], { files });
    expect(statusRes.code).toBe(0);
    expect(statusRes.out).toContain('Commit-list mode: enabled');
    expect(statusRes.out).toContain('Fixed-time window: active');
    expect(statusRes.out).toContain('Staged actions: 1');

    const listRes = await runCli(['mcp', 'list'], { files });
    expect(listRes.code).toBe(0);
    expect(listRes.out).toContain('[c-1] users create');
    expect(listRes.out).toContain('test@example.org');
  });

  it('clears commit list with tunnus mcp clear', async () => {
    const state = {
      mode: 'commit-list',
      fixedTimeUntil: null,
      commitList: [{ id: 'c-1', command: 'users create' }],
    };
    const files = {
      '/home/alex/.config/tunnus/mcp-state.json': JSON.stringify(state),
    };

    const res = await runCli(['mcp', 'clear'], { files });
    expect(res.code).toBe(0);
    expect(res.out).toContain('Commit list cleared');
    const updated = JSON.parse(res.files['/home/alex/.config/tunnus/mcp-state.json']);
    expect(updated.commitList).toEqual([]);
  });

  it('executes commit list on tunnus mcp commit with --yes for destructive actions', async () => {
    /** @type {any[]} */
    const calls = [];
    const state = {
      mode: 'commit-list',
      fixedTimeUntil: null,
      commitList: [
        {
          id: 'c-1',
          operationId: 'deleteUser',
          command: 'users delete',
          summary: 'Delete user',
          method: 'delete',
          path: '/users/6f1b1d0e-3c1e-4c7a-9a52-2f0f5a3c9b11',
          params: { userId: '6f1b1d0e-3c1e-4c7a-9a52-2f0f5a3c9b11' },
          body: undefined,
          stagedAt: '2026-11-21T09:00:00.000Z',
        },
      ],
    };
    const files = {
      '/home/alex/.config/tunnus/mcp-state.json': JSON.stringify(state),
    };

    // Without --yes and non-TTY: fails
    const failRes = await runCli(['mcp', 'commit'], { files, isTTY: false });
    expect(failRes.code).toBe(2);
    expect(failRes.err).toContain('The commit list contains destructive actions. Pass --yes');

    // With --yes: succeeds
    const okRes = await runCli(['mcp', 'commit', '--yes'], {
      files,
      fetch: async (/** @type {any} */ url, /** @type {any} */ init) => {
        calls.push({ url, method: init.method });
        return new Response(null, { status: 204 });
      },
    });

    expect(okRes.code).toBe(0);
    expect(okRes.out).toContain('✔ [c-1] users delete (204)');
    expect(calls).toHaveLength(1);
    const updated = JSON.parse(okRes.files['/home/alex/.config/tunnus/mcp-state.json']);
    expect(updated.commitList).toHaveLength(0);
  });
});
