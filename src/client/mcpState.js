import { dirname, join, posix } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

/**
 * @typedef {{
 *   id: string,
 *   operationId: string,
 *   command: string,
 *   summary: string,
 *   method: string,
 *   path: string,
 *   params: Record<string, unknown>,
 *   body: unknown,
 *   stagedAt: string,
 * }} StagedAction
 *
 * @typedef {{
 *   mode: 'disabled' | 'commit-list',
 *   fixedTimeUntil: string | null,
 *   commitList: StagedAction[],
 * }} McpState
 */

/**
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   configPath?: string,
 *   home?: string,
 *   platform?: NodeJS.Platform,
 * }} [options]
 * @returns {string}
 */
export function resolveMcpStatePath({
  env = process.env,
  configPath,
  home,
  platform = process.platform,
} = {}) {
  if (env.TUNNUS_MCP_STATE) return env.TUNNUS_MCP_STATE;
  const h = home ?? (platform === 'win32' ? process.env.USERPROFILE : homedir());
  const isPosix =
    platform !== 'win32' ||
    home?.startsWith('/') ||
    configPath?.startsWith('/') ||
    env.XDG_CONFIG_HOME?.startsWith('/');
  const p = isPosix ? posix : { dirname, join };

  if (configPath) {
    return p.join(p.dirname(configPath), 'mcp-state.json');
  }
  if (env.XDG_CONFIG_HOME) {
    return p.join(env.XDG_CONFIG_HOME, 'tunnus', 'mcp-state.json');
  }
  if (h) {
    return p.join(h, '.config', 'tunnus', 'mcp-state.json');
  }
  return 'mcp-state.json';
}

/**
 * @returns {McpState}
 */
export function createDefaultState() {
  return {
    mode: 'disabled',
    fixedTimeUntil: null,
    commitList: [],
  };
}

/**
 * @param {{
 *   statePath: string,
 *   readFile?: (path: string) => string,
 * }} options
 * @returns {McpState}
 */
export function loadMcpState({ statePath, readFile = (p) => readFileSync(p, 'utf8') }) {
  try {
    const text = readFile(statePath);
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return createDefaultState();
    }
    return {
      mode: parsed.mode === 'commit-list' ? 'commit-list' : 'disabled',
      fixedTimeUntil: typeof parsed.fixedTimeUntil === 'string' ? parsed.fixedTimeUntil : null,
      commitList: Array.isArray(parsed.commitList) ? parsed.commitList : [],
    };
  } catch {
    return createDefaultState();
  }
}

/**
 * @param {{
 *   statePath: string,
 *   state: McpState,
 *   writeFile?: (path: string, content: string) => void,
 *   mkdir?: (path: string, options: { recursive: boolean }) => void,
 * }} options
 */
export function saveMcpState({
  statePath,
  state,
  writeFile = (p, c) => writeFileSync(p, c, 'utf8'),
  mkdir = (p, o) => mkdirSync(p, o),
}) {
  const dir = dirname(statePath);
  try {
    mkdir(dir, { recursive: true });
  } catch {
    // ignore if already exists or virtual
  }
  writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
}

/**
 * @param {McpState} state
 * @param {number} [now]
 * @returns {boolean}
 */
export function isFixedTimeRunning(state, now = Date.now()) {
  if (!state.fixedTimeUntil) return false;
  const expiry = new Date(state.fixedTimeUntil).getTime();
  return !Number.isNaN(expiry) && expiry > now;
}

/**
 * @param {McpState} state
 * @param {number} [now]
 * @returns {number}
 */
export function getFixedTimeRemainingMs(state, now = Date.now()) {
  if (!state.fixedTimeUntil) return 0;
  const expiry = new Date(state.fixedTimeUntil).getTime();
  if (Number.isNaN(expiry) || expiry <= now) return 0;
  return expiry - now;
}

/**
 * @param {McpState} state
 * @param {number} [minutes]
 * @param {number} [now]
 */
export function allowFixedTime(state, minutes = 15, now = Date.now()) {
  state.fixedTimeUntil = new Date(now + minutes * 60 * 1000).toISOString();
}

/**
 * @param {McpState} state
 */
export function allowCommitList(state) {
  state.mode = 'commit-list';
}

/**
 * @param {McpState} state
 */
export function disallowMutative(state) {
  state.mode = 'disabled';
  state.fixedTimeUntil = null;
}

/**
 * @param {McpState} state
 * @param {Omit<StagedAction, 'id' | 'stagedAt'>} action
 * @param {number} [now]
 * @returns {StagedAction}
 */
export function stageAction(state, action, now = Date.now()) {
  const counter = state.commitList.length + 1;
  const id = `c-${counter}-${Math.random().toString(36).slice(2, 7)}`;
  /** @type {StagedAction} */
  const item = {
    id,
    ...action,
    stagedAt: new Date(now).toISOString(),
  };
  state.commitList.push(item);
  return item;
}

/**
 * @param {McpState} state
 */
export function clearCommitList(state) {
  state.commitList = [];
}
