import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { ApiError, describeApiError } from '../client/http.js';
import { clientOperations } from '../client/operations.js';

/** @typedef {import('../client/operations.js').ClientOperation} ClientOperation */

export const SERVER_NAME = 'tunnus';
export const SERVER_VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;

const INSTRUCTIONS =
  'Tunnus admin API. Each tool is one operation of the admin API. Deleting users or groups, ' +
  'ending sessions, rotating or retiring signing keys, and managing admin tokens are not available ' +
  'here; they need the tunnus CLI.';

/**
 * @typedef {{
 *   name: string,
 *   title: string,
 *   description: string,
 *   inputSchema: any,
 *   annotations: Record<string, boolean | string>,
 *   operation: ClientOperation,
 * }} McpTool
 */

/**
 * The JSON Schema of a tool's input: path and query parameters as properties, the request body as `body`.
 * @param {ClientOperation} op
 */
function inputSchemaFor(op) {
  /** @type {Record<string, any>} */
  const properties = {};
  /** @type {string[]} */
  const required = [];
  for (const p of [...op.pathParams, ...op.queryParams]) {
    properties[p.name] = p.description ? { ...p.schema, description: p.description } : p.schema;
    if (p.required) required.push(p.name);
  }
  if (op.bodySchema) {
    if ('body' in properties)
      throw new Error(`${op.operationId}: parameter named body clashes with the body`);
    properties.body = op.bodySchema;
    if (op.bodyRequired) required.push('body');
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

/**
 * Hints as in the design: GET is read-only; GET, PUT and DELETE are idempotent; DELETE and
 * updateUser (which can disable a user) are destructive.
 * @param {ClientOperation} op
 */
function annotationsFor(op) {
  return {
    title: op.summary,
    readOnlyHint: op.method === 'get',
    destructiveHint: op.method === 'delete' || op.operationId === 'updateUser',
    idempotentHint: ['get', 'put', 'delete'].includes(op.method),
    openWorldHint: false,
  };
}

/**
 * The MCP tools: one per operation, except destructive operations and those marked `x-tunnus-mcp: false`.
 * @param {any} spec
 * @returns {McpTool[]}
 */
export function mcpTools(spec) {
  return clientOperations(spec)
    .filter((op) => op.mcp)
    .map((op) => ({
      name: op.operationId,
      title: op.summary,
      description: op.description ? `${op.summary}\n\n${op.description}` : op.summary,
      inputSchema: inputSchemaFor(op),
      annotations: annotationsFor(op),
      operation: op,
    }));
}

/** @param {string} text */
function errorResult(text) {
  return { isError: true, content: [{ type: 'text', text }] };
}

/**
 * An MCP server over the admin API, with the low-level SDK `Server`.
 * `callApi` performs one operation: `(op, { params, body }) => { status, body }`, and throws ApiError.
 * @param {{
 *   spec: any,
 *   callApi: (op: ClientOperation, args: { params: Record<string, unknown>, body?: unknown }) => Promise<{ status: number, body: any }>,
 * }} deps
 */
export function createMcpServer({ spec, callApi }) {
  const tools = mcpTools(spec);
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({
      name,
      title,
      description,
      inputSchema,
      annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    const args = /** @type {Record<string, unknown>} */ (request.params.arguments ?? {});

    const unknown = Object.keys(args).filter((k) => !(k in tool.inputSchema.properties));
    if (unknown.length) return errorResult(`Unknown argument: ${unknown.join(', ')}`);
    const missing = /** @type {string[]} */ (tool.inputSchema.required ?? []).filter(
      (k) => args[k] === undefined,
    );
    if (missing.length) return errorResult(`Missing required argument: ${missing.join(', ')}`);

    const { body, ...params } = args;
    try {
      const res = await callApi(tool.operation, {
        params,
        body: tool.operation.bodySchema ? body : undefined,
      });
      const structured = res.body ?? {};
      return {
        content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
      };
    } catch (err) {
      if (err instanceof ApiError) return errorResult(describeApiError(err).join('\n'));
      throw err;
    }
  });

  return server;
}
