import { join, posix } from 'node:path';

/** Configuration problems: unreadable or invalid config file, bad URL, unreadable token file. */
export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * @typedef {{ url?: string, token?: string, config?: string, tokenFile?: string }} ConfigFlags
 * @typedef {{
 *   flags: ConfigFlags,
 *   env: Record<string, string | undefined>,
 *   home?: string,
 *   platform?: string,
 *   readFile: (path: string) => string,
 *   stat: (path: string) => { mode: number },
 * }} ResolveInput
 * @typedef {{
 *   url?: string,
 *   token?: string,
 *   source: { url?: string, token?: string },
 *   configPath?: string,
 *   warnings: string[],
 * }} ResolvedConfig
 */

/**
 * The config file path when none is given explicitly: `$XDG_CONFIG_HOME/tunnus/config.json`,
 * else `<home>/.config/tunnus/config.json`.
 * @param {Record<string, string | undefined>} env
 * @param {string | undefined} home
 * @param {string} [platform]
 * @returns {string | undefined}
 */
export function defaultConfigPath(env, home, platform = process.platform) {
  const p =
    platform === 'win32' && !(home?.startsWith('/') || env.XDG_CONFIG_HOME?.startsWith('/'))
      ? join
      : posix.join;
  if (env.XDG_CONFIG_HOME) return p(env.XDG_CONFIG_HOME, 'tunnus', 'config.json');
  if (home) return p(home, '.config', 'tunnus', 'config.json');
  return undefined;
}

/**
 * Parse the config file: a JSON object with optional string `url` and `token`.
 * @param {string} text
 * @param {string} path
 * @returns {{ url?: string, token?: string }}
 */
function parseConfigFile(text, path) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError(`${path} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${path} must contain a JSON object`);
  }
  const { url, token } = /** @type {Record<string, unknown>} */ (parsed);
  for (const [name, value] of [
    ['url', url],
    ['token', token],
  ]) {
    if (value !== undefined && typeof value !== 'string') {
      throw new ConfigError(`${path}: "${name}" must be a string`);
    }
  }
  return {
    url: /** @type {string | undefined} */ (url),
    token: /** @type {string | undefined} */ (token),
  };
}

/**
 * Normalise the issuer URL: absolute http(s), no trailing slash.
 * @param {string} value
 * @param {string} from where the value came from, for the error message
 */
function normaliseUrl(value, from) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`The Tunnus URL from ${from} is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`The Tunnus URL from ${from} must use http or https`);
  }
  return value.replace(/\/+$/, '');
}

/**
 * Resolve the issuer URL and admin token. Precedence:
 * URL: `--url`, `TUNNUS_URL`, config file. Token: `--token-file`, `TUNNUS_ADMIN_TOKEN`, config file.
 * The config file is `--config`, else `TUNNUS_CONFIG`, else the default path (a missing default file is ignored).
 * @param {ResolveInput} input
 * @returns {ResolvedConfig}
 */
export function resolveConfig({ flags, env, home, platform = process.platform, readFile, stat }) {
  /** @type {string[]} */
  const warnings = [];
  const explicit = flags.config ?? env.TUNNUS_CONFIG;
  const configPath = explicit || defaultConfigPath(env, home, platform);

  /** @type {{ url?: string, token?: string }} */
  let file = {};
  if (configPath) {
    /** @type {string | undefined} */
    let text;
    try {
      text = readFile(configPath);
    } catch (/** @type {any} */ err) {
      if (err?.code !== 'ENOENT' || explicit) {
        throw new ConfigError(
          err?.code === 'ENOENT'
            ? `Config file not found: ${configPath}`
            : `Cannot read config file ${configPath}: ${err?.message}`,
        );
      }
    }
    if (text !== undefined) {
      file = parseConfigFile(text, configPath);
      if (file.token && platform !== 'win32' && (stat(configPath).mode & 0o077) !== 0) {
        warnings.push(
          `${configPath} holds an admin token and is readable by other users; run chmod 600 on it`,
        );
      }
    }
  }

  /** @type {{ url?: string, token?: string }} */
  const source = {};
  let url;
  if (flags.url) {
    url = flags.url;
    source.url = '--url';
  } else if (env.TUNNUS_URL) {
    url = env.TUNNUS_URL;
    source.url = 'TUNNUS_URL';
  } else if (file.url) {
    url = file.url;
    source.url = `config file ${configPath}`;
  }

  let token;
  if (flags.tokenFile) {
    try {
      token = readFile(flags.tokenFile).trim();
    } catch (/** @type {any} */ err) {
      throw new ConfigError(`Cannot read token file ${flags.tokenFile}: ${err?.message}`);
    }
    source.token = '--token-file';
  } else if (env.TUNNUS_ADMIN_TOKEN) {
    token = env.TUNNUS_ADMIN_TOKEN;
    source.token = 'TUNNUS_ADMIN_TOKEN';
  } else if (file.token) {
    token = file.token;
    source.token = `config file ${configPath}`;
  }

  return {
    url: url === undefined ? undefined : normaliseUrl(url, source.url ?? 'configuration'),
    token: token || undefined,
    source,
    configPath,
    warnings,
  };
}
