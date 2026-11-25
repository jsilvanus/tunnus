import { describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadSpec } from '../src/admin/spec.js';
import { ApiError } from '../src/client/http.js';
import { createMcpServer, mcpTools } from '../src/mcp/server.js';

const spec = loadSpec();
const tools = mcpTools(spec);
const byName = (/** @type {string} */ name) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
};
const UUID = '6f1b1d0e-3c1e-4c7a-9a52-2f0f5a3c9b11';

/**
 * Connect an MCP client to a server over an in-memory transport.
 * @param {Parameters<typeof createMcpServer>[0]} deps
 */
async function connect(deps) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const state = deps.state ?? {
    mode: 'commit-list',
    fixedTimeUntil: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    commitList: [],
  };
  const server = createMcpServer({ ...deps, state });
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return { client, server };
}

describe('tool list', () => {
  it('exposes every operation except mcp:false ones, plus commit list tools', () => {
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'getMe',
        'listAdminTokens',
        'listUsers',
        'createUser',
        'getUser',
        'updateUser',
        'deleteUser',
        'revokeUserSessions',
        'listUserGroups',
        'listGroups',
        'createGroup',
        'getGroup',
        'updateGroup',
        'deleteGroup',
        'listGroupMembers',
        'grantMembership',
        'revokeMembership',
        'listGroupRules',
        'createGroupRule',
        'deleteGroupRule',
        'listKeys',
        'rotateKeys',
        'retireKey',
        'listAuditEvents',
        'listClients',
        'getClient',
        'putClient',
        'updateClient',
        'rotateClientSecret',
        'adoptClient',
        'deleteClient',
        'listServices',
        'getService',
        'createService',
        'putService',
        'updateService',
        'deleteService',
        'getCommitList',
        'executeCommitList',
        'clearCommitList',
      ].sort(),
    );
    for (const name of [
      'createAdminToken',
      'revokeAdminToken',
      'enableUserTotp',
      'disableUserTotp',
    ]) {
      expect(
        tools.some((t) => t.name === name),
        name,
      ).toBe(false);
    }
  });

  it('gives every tool a self-contained object schema with no $ref', () => {
    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain('$ref');
    }
  });

  it('puts path and query parameters at the top level and the body under body', () => {
    expect(byName('getUser').inputSchema.properties).toHaveProperty('userId');
    expect(byName('getUser').inputSchema.required).toEqual(['userId']);
    expect(byName('listUsers').inputSchema.properties).toHaveProperty('limit');
    expect(byName('listUsers').inputSchema.required).toBeUndefined();
    expect(byName('createUser').inputSchema).toMatchObject({ required: ['body'] });
    expect(byName('createUser').inputSchema.properties.body.properties).toHaveProperty('email');
    expect(byName('getMe').inputSchema.properties).toEqual({});
  });

  it('sets annotations from the method and the operation', () => {
    expect(byName('getUser').annotations).toEqual({
      title: 'Get a user',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName('updateUser').annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(byName('revokeMembership').annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(byName('grantMembership').annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(byName('createUser').annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(byName('putClient').annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(byName('rotateClientSecret').annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(byName('deleteClient').annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
  });
});

describe('tools over MCP', () => {
  it('lists the tools through the SDK client', async () => {
    const { client } = await connect({ spec, callApi: async () => ({ status: 200, body: {} }) });
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(tools.map((t) => t.name).sort());
    const getUser = listed.tools.find((t) => t.name === 'getUser');
    expect(getUser?.annotations?.readOnlyHint).toBe(true);
  });

  it('calls the operation with path, query and body split out, and returns the body', async () => {
    /** @type {any[]} */
    const calls = [];
    const { client } = await connect({
      spec,
      callApi: async (op, args) => {
        calls.push({ op: op.operationId, args });
        return { status: 200, body: { items: [{ id: 'a' }], next_cursor: null } };
      },
    });
    const result = await client.callTool({ name: 'listUsers', arguments: { limit: 5 } });
    expect(calls).toEqual([{ op: 'listUsers', args: { params: { limit: 5 }, body: undefined } }]);
    expect(result.structuredContent).toEqual({ items: [{ id: 'a' }], next_cursor: null });
    expect(result.isError).toBeFalsy();

    await client.callTool({
      name: 'createUser',
      arguments: { body: { email: 'ada@example.org' } },
    });
    expect(calls[1]).toEqual({
      op: 'createUser',
      args: { params: {}, body: { email: 'ada@example.org' } },
    });
  });

  it('returns API errors as tool errors with the code and details', async () => {
    const { client } = await connect({
      spec,
      callApi: async () => {
        throw new ApiError(400, 'invalid_request', 'Invalid input', [
          { path: '/email', message: 'bad' },
        ]);
      },
    });
    const result = await client.callTool({
      name: 'createUser',
      arguments: { body: { email: 'x' } },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: 'invalid_request: Invalid input\n  /email: bad' },
    ]);
  });

  it('rejects missing required and unknown arguments without calling the API', async () => {
    /** @type {number[]} */
    const calls = [];
    const { client } = await connect({
      spec,
      callApi: async () => {
        calls.push(1);
        return { status: 200, body: {} };
      },
    });
    const missing = await client.callTool({ name: 'getUser', arguments: {} });
    expect(missing.isError).toBe(true);
    expect(missing.content).toEqual([{ type: 'text', text: 'Missing required argument: userId' }]);
    const unknown = await client.callTool({
      name: 'getUser',
      arguments: { userId: UUID, nope: 1 },
    });
    expect(unknown.content).toEqual([{ type: 'text', text: 'Unknown argument: nope' }]);
    expect(calls).toHaveLength(0);
  });

  it('rejects an unknown tool name with a protocol error', async () => {
    const { client } = await connect({ spec, callApi: async () => ({ status: 200, body: {} }) });
    await expect(client.callTool({ name: 'fakeNonExistentTool', arguments: {} })).rejects.toThrow(
      /Unknown tool/,
    );
  });
});
