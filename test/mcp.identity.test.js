import { describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadSpec } from '../src/admin/spec.js';
import { ApiError } from '../src/client/http.js';
import { createMcpServer, mcpTools } from '../src/mcp/server.js';

const spec = loadSpec();
const USER_ID = '6f1b1d0e-3c1e-4c7a-9a52-2f0f5a3c9b11';
const USER = {
  id: USER_ID,
  email: 'person@example.org',
  display_name: 'Private Person',
  title: 'Private title',
  phone_number: '+358000000',
  status: 'active',
  is_admin: false,
  created_at: '2026-01-01T00:00:00.000Z',
  last_login_at: null,
  last_email_verified_at: null,
  activates_at: null,
  disables_at: null,
  disabled_at: null,
  totp_enabled: false,
  groups: [],
};

async function connect({ mode, callApi, state } = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const identity = {
    mode,
    resolveUser: async (value) => {
      if (value === 'pseudo:Person B' || value === 'ref:' + 'A'.repeat(43)) return USER_ID;
      throw new Error('invalid reference');
    },
    representUser: async (value) => {
      expect(value).toBe(USER_ID);
      return mode === 'ref_only' ? 'ref:' + 'A'.repeat(43) : 'pseudo:Person B';
    },
  };
  const server = createMcpServer({
    spec,
    callApi,
    identity,
    state: state ?? { mode: 'commit-list', fixedTimeUntil: null, listLocked: false, commitList: [] },
  });
  await server.connect(serverTransport);
  const client = new Client({ name: 'identity-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

describe('MCP restricted identity modes', () => {
  it('projects user records to the preferred pseudonym and removes direct identity fields', async () => {
    const { client } = await connect({
      mode: 'pseudo_ref',
      callApi: async () => ({ status: 200, body: { items: [USER], next_cursor: null } }),
    });
    const result = await client.callTool({ name: 'listUsers', arguments: {} });
    expect(result.structuredContent.items[0]).toMatchObject({
      id: 'pseudo:Person B',
      status: 'active',
      is_admin: false,
    });
    for (const key of ['email', 'display_name', 'title', 'phone_number']) {
      expect(result.structuredContent.items[0]).not.toHaveProperty(key);
    }
    expect(JSON.stringify(result)).not.toContain(USER_ID);
    expect(JSON.stringify(result)).not.toContain('person@example.org');
  });

  it('does not expose direct-identity search filters in restricted mode', () => {
    const tools = mcpTools(spec, 'pseudo_ref');
    const listUsers = tools.find((tool) => tool.name === 'listUsers');
    expect(listUsers.inputSchema.properties).not.toHaveProperty('q');
    expect(listUsers.inputSchema.properties).not.toHaveProperty('name');
    expect(listUsers.inputSchema.properties).not.toHaveProperty('email');
  });

  it('resolves a typed pseudonym before calling a user operation', async () => {
    const calls = [];
    const { client } = await connect({
      mode: 'pseudo_ref',
      callApi: async (op, args) => {
        calls.push({ operationId: op.operationId, args });
        return { status: 200, body: USER };
      },
    });
    const result = await client.callTool({
      name: 'getUser',
      arguments: { userId: 'pseudo:Person B' },
    });
    expect(calls[0].args.params.userId).toBe(USER_ID);
    expect(result.structuredContent.id).toBe('pseudo:Person B');
    expect(result.structuredContent).not.toHaveProperty('email');
  });

  it('returns temporary refs in ref-only mode and rejects pseudonym inputs', async () => {
    const calls = [];
    const { client } = await connect({
      mode: 'ref_only',
      callApi: async (op, args) => {
        calls.push(args);
        return { status: 200, body: USER };
      },
    });
    const bad = await client.callTool({
      name: 'getUser',
      arguments: { userId: 'pseudo:Person B' },
    });
    expect(bad.isError).toBe(true);
    expect(calls).toHaveLength(0);

    const good = await client.callTool({
      name: 'getUser',
      arguments: { userId: 'ref:' + 'A'.repeat(43) },
    });
    expect(calls[0].params.userId).toBe(USER_ID);
    expect(good.structuredContent.id).toBe('ref:' + 'A'.repeat(43));
    expect(good.structuredContent).not.toHaveProperty('email');
  });

  it('keeps getMe as the full-profile exception', async () => {
    const { client } = await connect({
      mode: 'ref_only',
      callApi: async () => ({ status: 200, body: { user: USER } }),
    });
    const result = await client.callTool({ name: 'getMe', arguments: {} });
    expect(result.structuredContent.user).toEqual(USER);
  });

  it('projects user identifiers in staged action previews', async () => {
    const state = {
      mode: 'commit-list',
      fixedTimeUntil: null,
      listLocked: false,
      commitList: [{
        id: 'stage-1',
        operationId: 'getUser',
        command: 'users get',
        summary: 'Get a user',
        params: { userId: USER_ID },
        stagedBy: { userId: USER_ID, email: 'private@example.org', label: 'OAuth' },
        stagedAt: '2026-01-01T00:00:00.000Z',
      }],
    };
    const { client } = await connect({
      mode: 'pseudo_ref',
      state,
      callApi: async () => ({ status: 200, body: {} }),
    });
    const result = await client.callTool({ name: 'getCommitList', arguments: {} });
    const item = result.structuredContent.commitList[0];
    expect(item.params.userId).toBe('pseudo:Person B');
    expect(item.stagedBy).toEqual({ label: 'OAuth' });
    expect(JSON.stringify(item)).not.toContain(USER_ID);
    expect(JSON.stringify(item)).not.toContain('private@example.org');
  });

  it('does not pass identifying API error details through restricted modes', async () => {
    const { client } = await connect({
      mode: 'pseudo_ref',
      callApi: async () => {
        throw new ApiError(404, 'not_found', 'User person@example.org not found: ' + USER_ID);
      },
    });
    const result = await client.callTool({
      name: 'getUser',
      arguments: { userId: 'pseudo:Person B' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(USER_ID);
    expect(JSON.stringify(result)).not.toContain('person@example.org');
  });

  it('mutative actions never execute directly when restricted mode is active and always queue', async () => {
    const executed = [];
    const fixedTimeUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const state = {
      mode: 'commit-list',
      fixedTimeUntil, // Fixed-time window is active!
      listLocked: false,
      commitList: [],
    };
    const { client } = await connect({
      mode: 'pseudo_ref',
      state,
      callApi: async (op, args) => {
        executed.push({ op, args });
        return { status: 200, body: USER };
      },
    });

    const res = await client.callTool({
      name: 'updateUser',
      arguments: { userId: 'pseudo:Person B', body: { status: 'active' } },
    });

    expect(executed).toHaveLength(0); // NEVER executed directly!
    expect(res.structuredContent.staged).toBe(true);
    expect(state.commitList).toHaveLength(1);
    expect(state.commitList[0].params.userId).toBe(USER_ID);

    const execRes = await client.callTool({
      name: 'executeCommitList',
      arguments: {},
    });
    expect(execRes.isError).toBe(true);
    expect(execRes.content[0].text).toContain('Executing staged actions is disabled for MCP in restricted identity mode');
  });
});
