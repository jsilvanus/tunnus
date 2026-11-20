#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadSpec, readSpecText } from '../src/admin/spec.js';
import { ConfigError, resolveConfig } from '../src/client/config.js';
import { createApiClient } from '../src/client/http.js';
import { createMcpHttpApp } from '../src/mcp/http.js';
import { createMcpJwtVerifier } from '../src/mcp/oauth.js';
import { createMcpServer } from '../src/mcp/server.js';

const USAGE = `Usage:
  tunnus-mcp [--url <url>] [--config <file>] [--token-file <file>] [--spec <file>]
      MCP over stdio. The admin token comes from the same configuration as the tunnus CLI.
  tunnus-mcp --http [--url <url>] [--config <file>] [--spec <file>]
      MCP over Streamable HTTP at POST /mcp, listening on MCP_HOST (default 127.0.0.1)
      and MCP_PORT (default 8090). Each request carries its own "Authorization: Bearer tun_..."
      header; the server holds no token.

Destructive operations and admin token management are only available from the tunnus CLI.
Log output goes to stderr; stdout carries the protocol in stdio mode.
`;

/**
 * @param {string} message
 * @returns {number} exit code 2
 */
function usageError(message) {
  process.stderr.write(`${message}\n\n${USAGE}`);
  return 2;
}

/** @returns {Promise<number>} */
async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      http: { type: 'boolean' },
      url: { type: 'string' },
      config: { type: 'string' },
      'token-file': { type: 'string' },
      spec: { type: 'string' },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const env = process.env;
  const readFile = (/** @type {string} */ path) => readFileSync(path, 'utf8');
  const spec = loadSpec(values.spec ? readFile(values.spec) : readSpecText());
  let config;
  try {
    config = resolveConfig({
      flags: { url: values.url, config: values.config, tokenFile: values['token-file'] },
      env,
      home: homedir(),
      readFile,
      stat: (path) => statSync(path),
    });
  } catch (/** @type {any} */ err) {
    if (!(err instanceof ConfigError)) throw err;
    return usageError(err.message);
  }
  for (const warning of config.warnings) process.stderr.write(`warning: ${warning}\n`);
  if (!config.url) {
    return usageError(
      'No Tunnus URL. Set TUNNUS_URL, pass --url, or add "url" to the config file.',
    );
  }

  if (values.http) {
    const host = env.MCP_HOST ?? '127.0.0.1';
    const port = Number(env.MCP_PORT ?? 8090);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      return usageError('MCP_PORT must be a port number');
    }
    const publicUrl = (env.MCP_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
    const oauth =
      env.MCP_OAUTH_ENABLED === 'true' || publicUrl
        ? (() => {
            const base = publicUrl || `http://${host}:${port}`;
            const resourceUrl =
              (env.MCP_RESOURCE_URL ?? '').trim().replace(/\/+$/, '') || `${base}/mcp`;
            const resourceMetadataUrl = `${base}/.well-known/oauth-protected-resource/mcp`;
            const jwksUrl = `${config.url}/jwks`;
            return {
              resourceUrl,
              authorizationServerUrl: config.url,
              resourceMetadataUrl,
              verifyToken: createMcpJwtVerifier({
                issuer: config.url,
                audience: resourceUrl,
                fetchJwks: async () => {
                  const res = await fetch(jwksUrl);
                  if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
                  return /** @type {Promise<{ keys: any[] }>} */ (res.json());
                },
              }),
            };
          })()
        : undefined;
    const app = createMcpHttpApp({ spec, url: config.url, oauth });
    app.listen(port, host, () => {
      process.stderr.write(`tunnus-mcp listening on http://${host}:${port}/mcp\n`);
    });
    return 0;
  }

  if (!config.token) {
    return usageError(
      'No admin token. Set TUNNUS_ADMIN_TOKEN, pass --token-file, or add "token" to the config file.',
    );
  }
  const client = createApiClient({ url: config.url, token: config.token });
  const server = createMcpServer({ spec, callApi: (op, args) => client.call(op, args) });
  await server.connect(new StdioServerTransport());
  return 0;
}

try {
  process.exitCode = await main();
} catch (/** @type {any} */ err) {
  process.stderr.write(`${err?.message ?? err}\n`);
  process.exitCode = 2;
}
