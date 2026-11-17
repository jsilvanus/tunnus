import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadSpec } from '../src/admin/spec.js';
import { createApiClient } from '../src/client/http.js';
import { createMcpHttpApp } from '../src/mcp/http.js';
import { createMcpServer, mcpTools } from '../src/mcp/server.js';
import { ADMIN_EMAIL, startAdmin } from './helpers/admin.js';

/** @type {Awaited<ReturnType<typeof startAdmin>>} */
let t;
const spec = loadSpec();
/** @type {http.Server} */
let httpServer;
let base = '';

beforeAll(async () => {
  t = await startAdmin({ schema: 'mcp_it' });
  httpServer = http.createServer(createMcpHttpApp({ spec, url: t.issuer }));
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve(undefined)));
  base = `http://127.0.0.1:${/** @type {any} */ (httpServer.address()).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
  await t.close();
});

/**
 * An SDK client connected to a server over an in-memory transport, backed by the real admin API.
 * @param {string} token
 */
async function inMemoryClient(token) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    spec,
    callApi: (op, args) => createApiClient({ url: t.issuer, token }).call(op, args),
  });
  await server.connect(serverSide);
  const client = new Client({ name: 'integration', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

/** @param {any} result */
const text = (result) => result.content.map((/** @type {any} */ c) => c.text).join('\n');

describe('MCP over the admin API, in memory', () => {
  it('calls every exposed tool once against the running Tunnus', async () => {
    const client = await inMemoryClient(t.token);
    /** @type {Set<string>} */
    const called = new Set();
    /** @param {string} name @param {Record<string, unknown>} [args] */
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, `${name}: ${text(result)}`).toBeFalsy();
      called.add(name);
      return /** @type {any} */ (result.structuredContent);
    };

    const me = await call('getMe');
    expect(me.user.email).toBe(ADMIN_EMAIL);
    await call('listAdminTokens');

    const user = await call('createUser', {
      body: { email: 'mcp-ada@example.org', display_name: 'Ada' },
    });
    await call('listUsers', { q: 'mcp-ada' });
    expect((await call('getUser', { userId: user.id })).email).toBe('mcp-ada@example.org');
    expect(
      (await call('updateUser', { userId: user.id, body: { display_name: 'Ada M' } })).display_name,
    ).toBe('Ada M');
    await call('listUserGroups', { userId: user.id });

    const group = await call('createGroup', { body: { name: 'mcp-staff' } });
    expect((await call('listGroups', { name: 'mcp-staff' })).items).toHaveLength(1);
    await call('getGroup', { groupId: group.id });
    expect(
      (await call('updateGroup', { groupId: group.id, body: { description: 'Staff' } }))
        .description,
    ).toBe('Staff');
    await call('grantMembership', { groupId: group.id, userId: user.id });
    expect((await call('listGroupMembers', { groupId: group.id })).items).toHaveLength(1);
    await call('revokeMembership', { groupId: group.id, userId: user.id });

    await call('listKeys');
    await call('listAuditEvents', { limit: 5 });
    await call('listClients');

    expect([...called].sort()).toEqual(tools().sort());

    const audit = await t.pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'admin.getMe' AND actor_user_id = $1",
      [t.adminId],
    );
    expect(audit.rows[0].n).toBeGreaterThan(0);
    await client.close();
  });

  it('returns a validation failure from the API as a tool error', async () => {
    const client = await inMemoryClient(t.token);
    const result = await client.callTool({
      name: 'createUser',
      arguments: { body: { email: 'not-an-email' } },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^invalid_request: /);
    await client.close();
  });

  it('reports an unknown user as a not_found tool error', async () => {
    const client = await inMemoryClient(t.token);
    const result = await client.callTool({
      name: 'getUser',
      arguments: { userId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^not_found: /);
    await client.close();
  });
});

/** @returns {string[]} */
function tools() {
  return mcpTools(spec).map((tool) => tool.name);
}

describe('MCP over Streamable HTTP', () => {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  });
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };

  it('answers 401 with WWW-Authenticate when the bearer is missing or malformed', async () => {
    const none = await fetch(`${base}/mcp`, { method: 'POST', headers, body });
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe('Bearer');
    expect((await none.json()).error.code).toBe('unauthorized');

    const malformed = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...headers, authorization: 'Bearer not-a-token' },
      body,
    });
    expect(malformed.status).toBe(401);
    expect(malformed.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('answers 405 to GET and DELETE', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${base}/mcp`, {
        method,
        headers: { authorization: `Bearer ${t.token}` },
      });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });

  it('serves tools/list and a tool call for the caller, using the caller token', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${t.token}` } },
    });
    const client = new Client({ name: 'integration', version: '0.0.0' });
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map((x) => x.name)).toContain('getMe');
    expect(listed.tools.map((x) => x.name)).not.toContain('deleteUser');
    const result = await client.callTool({ name: 'getMe', arguments: {} });
    expect(result.structuredContent).toMatchObject({ user: { email: ADMIN_EMAIL } });
    await client.close();
  });

  it('passes an unknown but well-formed token to the admin API, which refuses it', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer tun_${'b'.repeat(43)}` } },
    });
    const client = new Client({ name: 'integration', version: '0.0.0' });
    await client.connect(transport);
    const result = await client.callTool({ name: 'getMe', arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^unauthorized: /);
    await client.close();
  });
});
