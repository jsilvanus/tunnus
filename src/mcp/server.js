import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { ApiError, describeApiError } from '../client/http.js';
import {
  clearCommitList,
  getFixedTimeRemainingMs,
  isFixedTimeRunning,
  loadMcpState,
  resolveMcpStatePath,
  saveMcpState,
  stageAction,
} from '../client/mcpState.js';
import { clientOperations } from '../client/operations.js';

/** @typedef {import('../client/operations.js').ClientOperation} ClientOperation */

export const SERVER_NAME = 'tunnus';
export const SERVER_VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;

export function serverInstructions(accountUrl = '/account') {
  return (
    'Tunnus admin API. Each tool is one operation of the admin API. Mutative actions are staged ' +
    'into a commit list unless a 15-minute fixed-time window is active. ' +
    `Users can manage the 15-minute lease, lock/unlock the commit list, and review/execute staged actions at ${accountUrl} (or via CLI). ` +
    'Admin token management is not available here; it needs the tunnus CLI.'
  );
}

export const INSTRUCTIONS = serverInstructions();

/**
 * @typedef {{
 *   name: string,
 *   title: string,
 *   description: string,
 *   inputSchema: any,
 *   annotations: Record<string, boolean | string>,
 *   operation: ClientOperation | null,
 * }} McpTool
 */

function identityInputSchema(schema, mode) {
  if (!schema || typeof schema !== 'object') return schema;
  if (mode !== 'open' && schema['x-tunnus-user-reference'] === true) {
    return { type: 'string', description: mode === 'ref_only'
      ? 'Use a temporary ref:<handle> identifier.'
      : 'Use pseudo:<alias> or ref:<handle>; raw names and UUIDs are not accepted.' };
  }
  if (Array.isArray(schema)) return schema.map((item) => identityInputSchema(item, mode));
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [
    key,
    key === 'properties' && value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, identityInputSchema(child, mode)]))
      : ['items', 'oneOf', 'anyOf', 'allOf'].includes(key) ? identityInputSchema(value, mode) : value,
  ]));
}
/**
 * The JSON Schema of a tool's input: path and query parameters as properties, the request body as `body`.
 * @param {ClientOperation} op
 */
function inputSchemaFor(op, mode = 'open') {
  /** @type {Record<string, any>} */
  const properties = {};
  /** @type {string[]} */
  const required = [];
  for (const p of [...op.pathParams, ...op.queryParams]) {
    if (mode !== 'open' && p.sensitiveUserSearch) continue;
    properties[p.name] = identityInputSchema(p.description ? { ...p.schema, description: p.description } : p.schema, mode);
    if (p.required) required.push(p.name);
  }
  if (op.bodySchema) {
    if ('body' in properties)
      throw new Error(`${op.operationId}: parameter named body clashes with the body`);
    properties.body = identityInputSchema(op.bodySchema, mode);
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
 * Hints: GET is read-only; GET, PUT and DELETE are idempotent; DELETE, updateUser and destructive ops are destructive.
 * @param {ClientOperation} op
 */
function annotationsFor(op) {
  return {
    title: op.summary,
    readOnlyHint: op.method === 'get',
    destructiveHint: Boolean(
      op.destructive || op.method === 'delete' || op.operationId === 'updateUser',
    ),
    idempotentHint: ['get', 'put', 'delete'].includes(op.method),
    openWorldHint: false,
  };
}

export const COMMIT_LIST_TOOLS = /** @type {McpTool[]} */ ([
  {
    name: 'getCommitList',
    title: 'Get staged commit list and mutative status',
    description:
      'Inspect the list of staged mutative actions and check if a 15-minute fixed-time window is active.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      title: 'Get staged commit list and mutative status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    operation: null,
  },
  {
    name: 'executeCommitList',
    title: 'Execute staged commit list',
    description:
      'Execute all staged mutative actions against the admin API in order. Can only be executed by MCP if the 15-minute fixed-time window is active and the list is locked.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      title: 'Execute staged commit list',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    operation: null,
  },
  {
    name: 'clearCommitList',
    title: 'Clear staged commit list',
    description: 'Clear all staged mutative actions without executing them.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      title: 'Clear staged commit list',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    operation: null,
  },
]);

/**
 * The MCP tools: all exposed operations (including mutative ones) plus commit list tools.
 * Operations marked `x-tunnus-mcp: false` stay excluded.
 * @param {any} spec
 * @returns {McpTool[]}
 */
export function mcpTools(spec, mode = 'open') {
  const ops = clientOperations(spec)
    .filter((op) => op.mcp)
    .map((op) => ({
      name: op.operationId,
      title: op.summary,
      description: mode === 'open' ? (op.description ? `${op.summary}\n\n${op.description}` : op.summary) : op.summary + String.fromCharCode(10, 10) + (mode === 'pseudo_ref' ? 'Use pseudo:<alias> or ref:<handle> for users. Never use raw names, emails, or UUIDs.' : 'Use ref:<handle> only for users.'),
      inputSchema: inputSchemaFor(op, mode),
      annotations: annotationsFor(op),
      operation: op,
    }));
  return [...ops, ...COMMIT_LIST_TOOLS];
}

/** @param {string} text */
function errorResult(text) {
  return { isError: true, content: [{ type: 'text', text }] };
}

async function mapIdentitySchema(value, schema, convert, direction) {
  if (value === null || value === undefined || !schema) return value;
  if (direction === 'input' && schema['x-tunnus-user-reference'] === true) {
    if (typeof value !== 'string') throw new Error('Invalid user reference');
    return convert(value);
  }
  if (direction === 'output' && (schema['x-tunnus-user-id'] === true || schema['x-tunnus-user-reference'] === true)) {
    if (typeof value !== 'string' || !value) return value;
    return convert(value);
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => mapIdentitySchema(item, schema.items, convert, direction)));
  if (typeof value !== 'object') return value;
  const out = { ...value };
  if (direction === 'output' && schema['x-tunnus-user-record'] === true) {
    if (typeof out.id === 'string') out.id = await convert(out.id);
    for (const key of ['email', 'display_name', 'title', 'phone_number']) delete out[key];
  }
  if (direction === 'output' && schema['x-tunnus-membership-record'] === true) {
    delete out.email;
    delete out.display_name;
  }
  for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
    if (!Object.hasOwn(out, key)) continue;
    if (direction === 'output' && childSchema?.['x-tunnus-omit-in-restricted'] === true) { delete out[key]; continue; }
    const condition = childSchema?.['x-tunnus-user-id-when'];
    const effective = condition ? { ...childSchema, 'x-tunnus-user-id': direction === 'output' && out[condition.field] === condition.equals } : childSchema;
    out[key] = await mapIdentitySchema(out[key], effective, convert, direction);
  }
  return out;
}

async function mapOperationInput(op, params, body, resolve) {
  const mapped = { ...params };
  for (const p of [...op.pathParams, ...op.queryParams]) {
    if (Object.hasOwn(mapped, p.name)) mapped[p.name] = await mapIdentitySchema(mapped[p.name], p.schema, resolve, 'input');
  }
  return { params: mapped, body: op.bodySchema ? await mapIdentitySchema(body, op.bodySchema, resolve, 'input') : body };
}

async function projectOperationOutput(op, body, represent) {
  if (!op?.responseSchema || op.operationId === 'getMe') return body;
  return mapIdentitySchema(body, op.responseSchema, represent, 'output');
}

/**
 * An MCP server over the admin API, with the low-level SDK `Server`.
 * `callApi` performs one operation: `(op, { params, body }) => { status, body }`, and throws ApiError.
 * @param {{
 *   spec: any,
 *   callApi: (op: ClientOperation, args: { params: Record<string, unknown>, body?: unknown }) => Promise<{ status: number, body: any }>,
 *   state?: import('../client/mcpState.js').McpState,
 *   stateStore?: any,
 *   statePath?: string,
 *   issuer?: string,
 *   accountUrl?: string,
 *   userId?: string,
 *   actor?: { userId?: string, email?: string, label?: string } | null,
 *   identity?: { mode: 'open' | 'pseudo_ref' | 'ref_only', resolveUser: (value: string) => Promise<string>, representUser: (value: string) => Promise<string> } | null,
 *   loadState?: typeof loadMcpState,
 *   saveState?: typeof saveMcpState,
 *   readFile?: (path: string) => string,
 *   writeFile?: (path: string, content: string) => void,
 *   mkdir?: (path: string, options: { recursive: boolean }) => void,
 * }} deps
 */
export function createMcpServer({
  spec,
  callApi,
  state: memoryState,
  stateStore,
  statePath,
  issuer,
  accountUrl,
  userId,
  actor,
  identity = null,
  loadState = loadMcpState,
  saveState = saveMcpState,
  readFile,
  writeFile,
  mkdir,
}) {
  const identityMode = identity?.mode ?? 'open';
  const resolvedCache = new Map();
  const representedCache = new Map();
  const resolveIdentityUser = async (value) => {
    if (resolvedCache.has(value)) return resolvedCache.get(value);
    if (!identity?.resolveUser) throw new Error('Restricted MCP identity context is unavailable');
    const result = await identity.resolveUser(value);
    resolvedCache.set(value, result);
    return result;
  };
  const representIdentityUser = async (value) => {
    if (representedCache.has(value)) return representedCache.get(value);
    if (!identity?.representUser) throw new Error('Restricted MCP identity context is unavailable');
    const result = await identity.representUser(value);
    representedCache.set(value, result);
    return result;
  };
  const tools = mcpTools(spec, identityMode);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const operations = clientOperations(spec);
  const opsById = new Map(operations.map((o) => [o.operationId, o]));

  const resolvedAccountUrl = accountUrl || (issuer ? `${issuer}/account` : '/account');

  const getState = async () => {
    if (stateStore) return await stateStore.getState(userId);
    if (memoryState) return memoryState;
    const resolvedPath = statePath ?? resolveMcpStatePath();
    return loadState({ statePath: resolvedPath, readFile });
  };

  /** @param {import('../client/mcpState.js').McpState} s */
  const persistState = async (s) => {
    if (stateStore || memoryState) return;
    const resolvedPath = statePath ?? resolveMcpStatePath();
    saveState({ statePath: resolvedPath, state: s, writeFile, mkdir });
  };

  const instructions = serverInstructions(resolvedAccountUrl);
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions },
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

    // Handle commit-list specific tools
    if (tool.name === 'getCommitList') {
      const state = await getState();
      const remainingSeconds = Math.round(getFixedTimeRemainingMs(state) / 1000);
      const running = isFixedTimeRunning(state);
      const commitList = identityMode === 'open' ? state.commitList : await Promise.all(state.commitList.map(async (item) => {
        const op = opsById.get(item.operationId);
        if (!op) return { id: item.id, operationId: item.operationId, command: item.command, summary: item.summary, stagedAt: item.stagedAt };
        const paramSchema = { type: 'object', properties: Object.fromEntries([...op.pathParams, ...op.queryParams].map((p) => [p.name, p.schema])) };
        return {
          ...item,
          params: await mapIdentitySchema(item.params ?? {}, paramSchema, representIdentityUser, 'output'),
          body: await mapIdentitySchema(item.body, op.bodySchema, representIdentityUser, 'output'),
          stagedBy: item.stagedBy ? { label: item.stagedBy.label ?? 'MCP client' } : null,
        };
      }));
      const data = {
        mode: state.mode ?? (running ? 'direct' : 'commit-list'),
        fixedTimeRunning: running,
        fixedTimeUntil: state.fixedTimeUntil,
        remainingSeconds,
        listLocked: Boolean(state.listLocked),
        commitList,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
      };
    }

    if (tool.name === 'clearCommitList') {
      if (stateStore?.clearCommitList) {
        await stateStore.clearCommitList({ userId });
      } else {
        const state = await getState();
        clearCommitList(state);
        await persistState(state);
      }
      return {
        content: [{ type: 'text', text: 'Commit list cleared.' }],
        structuredContent: { cleared: true },
      };
    }

    if (tool.name === 'executeCommitList') {
      const state = await getState();
      if (!isFixedTimeRunning(state)) {
        return errorResult(
          'Commit list can only be executed by MCP when a fixed-time window is running. ' +
            `Execute it on the web interface at ${resolvedAccountUrl} (or CLI with "tunnus mcp commit"), or activate a 15-minute window at ${resolvedAccountUrl}.`,
        );
      }
      if (!state.listLocked) {
        return errorResult(
          `The commit list must be locked before execution to prevent concurrent additions. Visit ${resolvedAccountUrl} to lock and review the list before execution.`,
        );
      }
      if (state.commitList.length === 0) {
        return {
          content: [{ type: 'text', text: 'Commit list is empty.' }],
          structuredContent: { executed: [] },
        };
      }
      if (stateStore?.executeCommitList) {
        const res = await stateStore.executeCommitList({ userId, callApi, opsById });
        if (!res.ok) {
          return errorResult(identityMode === 'open' ? res.error : 'One or more staged operations failed. Review the commit list in the account page.');
        }
        return {
          content: [
            { type: 'text', text: `Executed ${res.executed.length} action(s) from commit list.` },
          ],
          structuredContent: { executed: identityMode === 'open' ? res.executed : await Promise.all(res.executed.map(async (item) => ({ ...item, body: await projectOperationOutput(opsById.get(item.operationId), item.body, representIdentityUser) }))) },
        };
      }

      /** @type {any[]} */
      const executed = [];
      while (state.commitList.length > 0) {
        const item = state.commitList[0];
        const op = opsById.get(item.operationId);
        if (!op) {
          await persistState(state);
          return errorResult(`Unknown operation in commit list: ${item.operationId}`);
        }
        try {
          const res = await callApi(op, { params: item.params, body: item.body });
          const safeBody = identityMode === 'open' ? res.body : await projectOperationOutput(op, res.body, representIdentityUser);
          executed.push({
            id: item.id,
            operationId: item.operationId,
            command: item.command,
            status: res.status,
            body: safeBody,
          });
          state.commitList.shift();
          await persistState(state);
        } catch (err) {
          await persistState(state);
          if (err instanceof ApiError) {
            return errorResult(
              identityMode === 'open' ? `Failed executing ${item.command} (${item.id}):\n${describeApiError(err).join('\n')}` : 'A staged operation failed. Review the commit list in the account page.',
            );
          }
          throw err;
        }
      }
      return {
        content: [
          { type: 'text', text: `Executed ${executed.length} action(s) from commit list.` },
        ],
        structuredContent: { executed },
      };
    }

    if (!tool.operation) {
      throw new McpError(ErrorCode.InternalError, `No operation for ${tool.name}`);
    }

    const { body, ...rawParams } = args;
    let params = rawParams;
    let mappedBody = body;
    if (identityMode !== 'open') {
      try {
        const mapped = await mapOperationInput(tool.operation, rawParams, body, resolveIdentityUser);
        params = mapped.params;
        mappedBody = mapped.body;
      } catch (err) {
        return errorResult(err?.code === 'target_not_linked' ? 'This identity is not linked to a Tunnus account.' : 'Unknown, expired, or invalid user reference. Use a valid typed reference from the pseudonyms page.');
      }
    }
    const isMutative = tool.operation.method !== 'get';

    if (isMutative) {
      const state = await getState();
      if (isFixedTimeRunning(state)) {
        // Direct execution allowed by active fixed-time window
        try {
          const res = await callApi(tool.operation, {
            params,
            body: tool.operation.bodySchema ? mappedBody : undefined,
          });
          const structured = identityMode === 'open' ? (res.body ?? {}) : await projectOperationOutput(tool.operation, res.body ?? {}, representIdentityUser);
          return {
            content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
            structuredContent: structured,
          };
        } catch (err) {
          if (err instanceof ApiError) return errorResult(describeApiError(err).join('\n'));
          throw err;
        }
      }

      if (state.mode === 'disabled') {
        return errorResult(
          `Mutative actions are currently disabled for MCP. Direct the user to ${resolvedAccountUrl} to enable a 15-minute direct window or allow staging (or run "tunnus mcp allow" on CLI).`,
        );
      }

      // Check if list is locked
      if (state.listLocked) {
        return errorResult(
          `The commit list is currently locked against new entries (pending review or execution). Direct the user to ${resolvedAccountUrl} to unlock the list or execute current actions.`,
        );
      }

      const actionPayload = {
        operationId: tool.name,
        command: tool.operation.command,
        summary: tool.operation.summary,
        method: tool.operation.method,
        path: tool.operation.path,
        params,
        body: tool.operation.bodySchema ? mappedBody : undefined,
        stagedBy: actor ?? null,
      };

      let stagedId;
      if (stateStore?.stageAction) {
        const res = await stateStore.stageAction({ userId, action: actionPayload, actor });
        if (!res.ok) {
          return errorResult(
            `The commit list is currently locked against new entries. Direct the user to ${resolvedAccountUrl} to unlock the list.`,
          );
        }
        stagedId = res.staged.id;
      } else {
        const staged = stageAction(state, actionPayload);
        await persistState(state);
        stagedId = staged.id;
      }

      const structured = {
        staged: true,
        id: stagedId,
        operationId: tool.name,
        command: tool.operation.command,
        message:
          `Action staged to commit list (${stagedId}): ${tool.operation.command}. ` +
          `Direct the user to ${resolvedAccountUrl} to review and commit staged actions or enable a 15-minute direct execution window (or run "tunnus mcp commit" on CLI).`,
      };
      return {
        content: [{ type: 'text', text: structured.message }],
        structuredContent: structured,
      };
    }

    // Read-only operation: execute immediately
    try {
      const res = await callApi(tool.operation, {
        params,
        body: tool.operation.bodySchema ? body : undefined,
      });
      const structured = identityMode === 'open' ? (res.body ?? {}) : await projectOperationOutput(tool.operation, res.body ?? {}, representIdentityUser);
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
