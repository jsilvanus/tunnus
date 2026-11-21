import { describe, expect, it } from 'vitest';
import { loadSpec } from '../src/admin/spec.js';
import { defaultConfigPath, ConfigError, resolveConfig } from '../src/client/config.js';
import { ApiError, createApiClient } from '../src/client/http.js';
import { clientOperations, inlineRefs } from '../src/client/operations.js';
import {
  convertValue,
  matchCommand,
  operationFlags,
  parseOperationArgs,
  splitGlobals,
  toFlagName,
  UsageError,
} from '../src/cli/args.js';
import { formatCommandHelp, formatObject, formatOverview, formatTable } from '../src/cli/format.js';
import { main } from '../src/cli/main.js';

const spec = loadSpec();
const operations = clientOperations(spec);
const byCommand = (/** @type {string} */ command) => {
  const op = operations.find((o) => o.command === command);
  if (!op) throw new Error(`no command ${command}`);
  return op;
};
const UUID = '6f1b1d0e-3c1e-4c7a-9a52-2f0f5a3c9b11';
const noFile = () => {
  throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
};

describe('command generation', () => {
  it('gives every operation a unique command', () => {
    const commands = operations.map((op) => op.command);
    expect(new Set(commands).size).toBe(commands.length);
    expect(commands.length).toBe(Object.keys(spec.paths).length ? operations.length : 0);
    expect(operations.length).toBeGreaterThan(20);
  });

  it('fails when an operation has no x-tunnus-cli', () => {
    const copy = structuredClone(spec);
    delete copy.paths['/me'].get['x-tunnus-cli'];
    expect(() => clientOperations(copy)).toThrow(/getMe has no x-tunnus-cli/);
  });

  it('fails when two operations share a command', () => {
    const copy = structuredClone(spec);
    copy.paths['/me'].get['x-tunnus-cli'] = 'users list';
    expect(() => clientOperations(copy)).toThrow(/used by/);
  });

  it('has no flag names that collide within an operation', () => {
    for (const op of operations) {
      const names = operationFlags(op).map((f) => f.flag);
      expect(new Set(names).size, op.command).toBe(names.length);
    }
  });

  it('matches command words, operation ids, and the longest command', () => {
    expect(matchCommand(['users', 'list'], operations)?.op.operationId).toBe('listUsers');
    expect(matchCommand(['listUsers'], operations)?.op.operationId).toBe('listUsers');
    expect(matchCommand(['users', 'get', UUID], operations)).toMatchObject({
      op: { operationId: 'getUser' },
      words: 2,
    });
    expect(matchCommand(['users', 'frob'], operations)).toBeUndefined();
  });

  it('derives the MCP and destructive flags from the spec', () => {
    expect(byCommand('users delete')).toMatchObject({
      destructive: true,
      mcp: true,
      mutative: true,
    });
    expect(byCommand('tokens create')).toMatchObject({ mcp: false, destructive: false });
    expect(byCommand('users update')).toMatchObject({
      destructive: false,
      mcp: true,
      mutative: true,
    });
    expect(byCommand('groups grant').paged).toBe(false);
    expect(byCommand('users list').paged).toBe(true);
  });

  it('inlines $ref and keeps sibling keywords', () => {
    const schema = inlineRefs(spec, { $ref: '#/components/schemas/UserStatus', description: 'x' });
    expect(schema).toEqual({ type: 'string', enum: ['active', 'disabled'], description: 'x' });
    expect(JSON.stringify(byCommand('users create').bodySchema)).not.toContain('$ref');
  });

  it('rejects a recursive $ref', () => {
    const loop = { components: { schemas: { A: { $ref: '#/components/schemas/A' } } } };
    expect(() => inlineRefs(loop, { $ref: '#/components/schemas/A' })).toThrow(/Recursive/);
  });
});

describe('flags and value conversion', () => {
  it('converts keys to kebab-case flags', () => {
    expect(toFlagName('userId')).toBe('user-id');
    expect(toFlagName('display_name')).toBe('display-name');
    expect(toFlagName('expires_in_days')).toBe('expires-in-days');
    expect(toFlagName('q')).toBe('q');
  });

  it('converts integers, numbers, booleans, strings and JSON by schema type', () => {
    const def = (/** @type {string} */ type) => /** @type {any} */ ({ flag: 'x', type });
    expect(convertValue('5', def('integer'))).toBe(5);
    expect(convertValue('-2', def('integer'))).toBe(-2);
    expect(convertValue('1.5', def('number'))).toBe(1.5);
    expect(convertValue(true, def('boolean'))).toBe(true);
    expect(convertValue('false', def('boolean'))).toBe(false);
    expect(convertValue('abc', def('string'))).toBe('abc');
    expect(convertValue('["a"]', def('json'))).toEqual(['a']);
  });

  it('passes unconvertible values on so the server reports them', () => {
    const def = (/** @type {string} */ type) => /** @type {any} */ ({ flag: 'x', type });
    expect(convertValue('abc', def('integer'))).toBe('abc');
    expect(convertValue('maybe', def('boolean'))).toBe('maybe');
  });

  it('rejects JSON that does not parse', () => {
    expect(() => convertValue('{', /** @type {any} */ ({ flag: 'x', type: 'json' }))).toThrow(
      UsageError,
    );
  });
});

describe('argument parsing', () => {
  it('takes path parameters positionally, in path order, and converts them', () => {
    const { params } = parseOperationArgs(byCommand('groups grant'), ['7', UUID], noFile);
    expect(params).toEqual({ groupId: 7, userId: UUID });
  });

  it('lets a flag set a path parameter and gives the rest to positionals', () => {
    const op = byCommand('groups grant');
    expect(parseOperationArgs(op, ['--user-id', UUID, '3'], noFile).params).toEqual({
      groupId: 3,
      userId: UUID,
    });
  });

  it('rejects a missing path parameter and surplus positionals', () => {
    expect(() => parseOperationArgs(byCommand('users get'), [], noFile)).toThrow(
      /Missing <userId>/,
    );
    expect(() => parseOperationArgs(byCommand('users get'), [UUID, 'extra'], noFile)).toThrow(
      /Unexpected argument: extra/,
    );
  });

  it('converts query flags and accepts bare and explicit booleans', () => {
    const op = byCommand('users list');
    expect(parseOperationArgs(op, ['--is-admin', '--limit', '10'], noFile).params).toEqual({
      is_admin: true,
      limit: 10,
    });
    expect(parseOperationArgs(op, ['--is-admin', 'false'], noFile).params).toEqual({
      is_admin: false,
    });
    expect(parseOperationArgs(op, ['--is-admin=false'], noFile).params).toEqual({
      is_admin: false,
    });
    expect(parseOperationArgs(op, ['--status=disabled'], noFile).params).toEqual({
      status: 'disabled',
    });
  });

  it('builds the body from body flags', () => {
    const { body } = parseOperationArgs(
      byCommand('users create'),
      ['--email', 'ada@example.org', '--display-name', 'Ada', '--is-admin'],
      noFile,
    );
    expect(body).toEqual({ email: 'ada@example.org', display_name: 'Ada', is_admin: true });
  });

  it('merges --body with flags, and flags win', () => {
    const { body } = parseOperationArgs(
      byCommand('users create'),
      [
        '--body',
        '{"email":"a@example.org","display_name":"From JSON"}',
        '--display-name',
        'From flag',
      ],
      noFile,
    );
    expect(body).toEqual({ email: 'a@example.org', display_name: 'From flag' });
  });

  it('reads --body from a file', () => {
    const readFile = (/** @type {string} */ path) => {
      expect(path).toBe('/work/user.json');
      return '{"email":"file@example.org"}';
    };
    const { body } = parseOperationArgs(
      byCommand('users create'),
      ['--body', '@/work/user.json'],
      readFile,
    );
    expect(body).toEqual({ email: 'file@example.org' });
  });

  it('rejects a --body that is not a JSON object, or a file that cannot be read', () => {
    const op = byCommand('users create');
    expect(() => parseOperationArgs(op, ['--body', '[1]'], noFile)).toThrow(/JSON object/);
    expect(() => parseOperationArgs(op, ['--body', '@/nope.json'], noFile)).toThrow(/Cannot read/);
  });

  it('sends no body when none is given, and an empty object when the body is required', () => {
    expect(
      parseOperationArgs(byCommand('users create'), ['--email', 'a@example.org'], noFile).body,
    ).toBeDefined();
    expect(parseOperationArgs(byCommand('users get'), [UUID], noFile).body).toBeUndefined();
    expect(parseOperationArgs(byCommand('users update'), [UUID], noFile).body).toBeDefined();
  });

  it('turns --all on only for paged operations', () => {
    expect(parseOperationArgs(byCommand('users list'), ['--all'], noFile).all).toBe(true);
    expect(() => parseOperationArgs(byCommand('users get'), [UUID, '--all'], noFile)).toThrow(
      /Unknown flag --all/,
    );
  });

  it('rejects unknown flags and names the command flags', () => {
    expect(() => parseOperationArgs(byCommand('users list'), ['--bogus'], noFile)).toThrow(
      /Unknown flag --bogus for "users list"\. Flags for this command: --q/,
    );
  });

  it('rejects a string flag without a value, and a repeated flag', () => {
    expect(() => parseOperationArgs(byCommand('users list'), ['--cursor'], noFile)).toThrow(
      /needs a value/,
    );
    expect(() =>
      parseOperationArgs(byCommand('users list'), ['--cursor', '--limit', '1'], noFile),
    ).toThrow(/needs a value/);
    expect(() =>
      parseOperationArgs(byCommand('users list'), ['--limit', '1', '--limit=2'], noFile),
    ).toThrow(/more than once/);
  });

  it('splits global flags out of argv wherever they appear', () => {
    const { globals, rest } = splitGlobals([
      '--url=https://id.example.org',
      'users',
      '--json',
      'list',
      '-h',
    ]);
    expect(globals).toEqual({ url: 'https://id.example.org', json: true, help: true });
    expect(rest).toEqual(['users', 'list']);
    expect(() => splitGlobals(['--url'])).toThrow(/needs a value/);
  });
});

describe('configuration', () => {
  /** @param {Record<string, { text: string, mode?: number }>} files */
  const fs = (files) => ({
    readFile: (/** @type {string} */ path) => {
      if (!(path in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files[path].text;
    },
    stat: (/** @type {string} */ path) => ({ mode: files[path].mode ?? 0o600 }),
  });
  const base = { home: '/home/alex', platform: 'linux' };
  const configPath = '/home/alex/.config/tunnus/config.json';

  it('uses the default config path under XDG_CONFIG_HOME, else under HOME', () => {
    expect(defaultConfigPath({ XDG_CONFIG_HOME: '/xdg' }, '/home/alex')).toBe(
      '/xdg/tunnus/config.json',
    );
    expect(defaultConfigPath({}, '/home/alex')).toBe(configPath);
    expect(defaultConfigPath({}, undefined)).toBeUndefined();
  });

  it('takes flags over environment over the config file, for the URL and the token', () => {
    const files = fs({
      [configPath]: { text: '{"url":"https://file.example.org/","token":"tun_file"}' },
      '/tok': { text: '  tun_flagfile\n' },
    });
    const env = { TUNNUS_URL: 'https://env.example.org', TUNNUS_ADMIN_TOKEN: 'tun_env' };
    const fromFlags = resolveConfig({
      ...base,
      ...files,
      flags: { url: 'https://flag.example.org/', tokenFile: '/tok' },
      env,
    });
    expect(fromFlags).toMatchObject({ url: 'https://flag.example.org', token: 'tun_flagfile' });
    expect(fromFlags.source).toEqual({ url: '--url', token: '--token-file' });

    const fromEnv = resolveConfig({ ...base, ...files, flags: {}, env });
    expect(fromEnv).toMatchObject({ url: 'https://env.example.org', token: 'tun_env' });
    expect(fromEnv.source.url).toBe('TUNNUS_URL');

    const fromFile = resolveConfig({ ...base, ...files, flags: {}, env: {} });
    expect(fromFile).toMatchObject({ url: 'https://file.example.org', token: 'tun_file' });
    expect(fromFile.source.token).toContain(configPath);
  });

  it('uses TUNNUS_CONFIG, and fails when that file is missing', () => {
    const files = fs({ '/elsewhere.json': { text: '{"url":"https://x.example.org"}' } });
    expect(
      resolveConfig({ ...base, ...files, flags: {}, env: { TUNNUS_CONFIG: '/elsewhere.json' } })
        .url,
    ).toBe('https://x.example.org');
    expect(() =>
      resolveConfig({ ...base, ...fs({}), flags: {}, env: { TUNNUS_CONFIG: '/gone.json' } }),
    ).toThrow(/not found/);
  });

  it('ignores a missing default config file', () => {
    const result = resolveConfig({ ...base, ...fs({}), flags: {}, env: {} });
    expect(result).toMatchObject({ url: undefined, token: undefined, warnings: [] });
  });

  it('warns when a config file holding a token is readable by others, not otherwise', () => {
    const text = '{"url":"https://id.example.org","token":"tun_x"}';
    const open = resolveConfig({
      ...base,
      ...fs({ [configPath]: { text, mode: 0o644 } }),
      flags: {},
      env: {},
    });
    expect(open.warnings).toHaveLength(1);
    expect(open.warnings[0]).toContain('chmod 600');
    const private_ = resolveConfig({
      ...base,
      ...fs({ [configPath]: { text, mode: 0o600 } }),
      flags: {},
      env: {},
    });
    expect(private_.warnings).toEqual([]);
    const noToken = resolveConfig({
      ...base,
      ...fs({ [configPath]: { text: '{"url":"https://id.example.org"}', mode: 0o644 } }),
      flags: {},
      env: {},
    });
    expect(noToken.warnings).toEqual([]);
    const windows = resolveConfig({
      ...base,
      platform: 'win32',
      ...fs({ [configPath]: { text, mode: 0o644 } }),
      flags: {},
      env: {},
    });
    expect(windows.warnings).toEqual([]);
  });

  it('rejects invalid JSON, a non-object, a non-string field, and a non-http URL', () => {
    const run = (/** @type {string} */ text, /** @type {Record<string, string>} */ env = {}) =>
      resolveConfig({ ...base, ...fs({ [configPath]: { text } }), flags: {}, env });
    expect(() => run('{')).toThrow(ConfigError);
    expect(() => run('[]')).toThrow(/JSON object/);
    expect(() => run('{"url":5}')).toThrow(/must be a string/);
    expect(() => run('{}', { TUNNUS_URL: 'ftp://id.example.org' })).toThrow(/http or https/);
    expect(() => run('{}', { TUNNUS_URL: 'not a url' })).toThrow(/not a valid URL/);
  });
});

describe('formatting', () => {
  it('prints a table of scalar columns in schema order, with arrays joined and long cells cut', () => {
    const itemSchema = byCommand('users list').responseSchema.properties.items.items;
    const text = formatTable(
      [
        {
          id: UUID,
          email: 'ada@example.org',
          display_name: 'Ada',
          status: 'active',
          is_admin: true,
          created_at: '2026-01-01T00:00:00.000Z',
          last_login_at: null,
          last_email_verified_at: null,
          totp_enabled: false,
          groups: ['all', 'staff'],
        },
      ],
      itemSchema,
    );
    const [header, row] = text.trimEnd().split('\n');
    expect(header.trim().split(/\s+/)).toEqual([
      'id',
      'email',
      'display_name',
      'status',
      'is_admin',
      'created_at',
      'last_login_at',
      'last_email_verified_at',
      'totp_enabled',
      'groups',
    ]);
    expect(row).toContain('all,staff');
    expect(row).not.toContain('{');
  });

  it('cuts cells at 40 characters, excludes object columns, and says when there are no items', () => {
    const schema = {
      properties: {
        long: { type: 'string' },
        nested: { type: 'object' },
        ids: { type: 'array', items: { type: 'integer' } },
      },
    };
    const text = formatTable([{ long: 'x'.repeat(60), nested: { a: 1 }, ids: [1, 2] }], schema);
    const lines = text.trimEnd().split('\n');
    expect(lines[0].trim().split(/\s+/)).toEqual(['long', 'ids']);
    expect(lines[1].split('  ')[0].length).toBe(40);
    expect(lines[1]).toContain('1,2');
    expect(formatTable([], schema)).toBe('No items.\n');
  });

  it('prints objects as key: value lines, flattening nested objects', () => {
    expect(
      formatObject({ id: 1, user: { email: 'a@example.org', groups: ['x', 'y'] }, last: null }),
    ).toBe('id: 1\nuser.email: a@example.org\nuser.groups: x,y\nlast: null\n');
    expect(formatObject({ items: [{ a: 1 }] })).toBe('items: [{"a":1}]\n');
  });

  it('shows command help with types, required, enum, default and ranges', () => {
    const help = formatCommandHelp(byCommand('users list'));
    expect(help).toContain('tunnus users list [flags]');
    expect(help).toContain('--status <string>  one of active, disabled');
    expect(help).toContain('--limit <integer>  default 50; 1..200');
    expect(formatCommandHelp(byCommand('users delete'))).toContain('Destructive');
    expect(formatCommandHelp(byCommand('groups get'))).toContain(
      '<groupId>  integer; required; at least 1',
    );
  });

  it('lists every command in the overview', () => {
    const overview = formatOverview(operations);
    for (const op of operations) expect(overview).toContain(op.command);
  });
});

describe('http client', () => {
  it('builds the URL from path and query, sends the bearer, and raises API errors', async () => {
    /** @type {{ url: string, init: any }[]} */
    const calls = [];
    const fetch = /** @type {any} */ (
      async (/** @type {string} */ url, /** @type {any} */ init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
    );
    const client = createApiClient({ url: 'https://id.example.org/', token: 'tun_t', fetch });
    const err = await client
      .call(byCommand('users list'), { params: { limit: 5, q: 'ada', email: undefined } })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: 'not_found', message: 'nope' });
    expect(calls[0].url).toBe('https://id.example.org/admin/api/v1/users?q=ada&limit=5');
    expect(calls[0].init.headers.authorization).toBe('Bearer tun_t');
  });

  it('reports network failures with code network', async () => {
    const fetch = /** @type {any} */ (
      async () => {
        throw new TypeError('fetch failed');
      }
    );
    const client = createApiClient({ url: 'https://id.example.org', fetch });
    await expect(client.call(byCommand('whoami'))).rejects.toMatchObject({
      code: 'network',
      status: 0,
    });
  });
});

describe('main', () => {
  /** @param {Record<string, string>} [env] */
  function io(env = {}, extra = {}) {
    /** @type {string[]} */
    const out = [];
    /** @type {string[]} */
    const errText = [];
    return {
      out,
      errText,
      io: {
        env: { TUNNUS_URL: 'https://id.example.org', TUNNUS_ADMIN_TOKEN: 'tun_test', ...env },
        stdout: { write: (/** @type {string} */ s) => out.push(s) },
        stderr: { write: (/** @type {string} */ s) => errText.push(s) },
        home: '/nonexistent-home',
        readFile: noFile,
        ...extra,
      },
    };
  }

  /** @param {unknown[]} pages */
  function pagedFetch(pages) {
    /** @type {string[]} */
    const urls = [];
    const fetch = /** @type {any} */ (
      async (/** @type {string} */ url) => {
        urls.push(url);
        const page = pages.shift() ?? { items: [], next_cursor: null };
        return new Response(JSON.stringify(page), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    );
    return { fetch, urls };
  }

  it('prints help and exits 0, and exits 2 with no command', async () => {
    const a = io();
    expect(await main(['--help'], a.io)).toBe(0);
    expect(a.out.join('')).toContain('users list');
    const b = io();
    expect(await main(['users', '--help'], b.io)).toBe(0);
    expect(b.out.join('')).toContain('Commands under "users"');
    const c = io();
    expect(await main([], c.io)).toBe(2);
  });

  it('exits 2 for an unknown command and for a missing URL or token', async () => {
    const unknown = io();
    expect(await main(['frob'], unknown.io)).toBe(2);
    expect(unknown.errText.join('')).toContain('Unknown command');
    const noUrl = io({ TUNNUS_URL: '' });
    expect(await main(['whoami'], noUrl.io)).toBe(2);
    expect(noUrl.errText.join('')).toContain('No Tunnus URL');
    const noToken = io({ TUNNUS_ADMIN_TOKEN: '' });
    expect(await main(['whoami'], noToken.io)).toBe(2);
    expect(noToken.errText.join('')).toContain('No admin token');
  });

  it('follows next_cursor for --all and prints one list as JSON', async () => {
    const { fetch, urls } = pagedFetch([
      { items: [{ id: 'a' }], next_cursor: 'c1' },
      { items: [{ id: 'b' }], next_cursor: 'c2' },
      { items: [{ id: 'c' }], next_cursor: null },
    ]);
    const t = io({}, { fetch });
    expect(await main(['users', 'list', '--all', '--json', '--limit', '1'], t.io)).toBe(0);
    expect(JSON.parse(t.out.join(''))).toEqual({
      items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      next_cursor: null,
    });
    expect(urls[1]).toContain('cursor=c1');
    expect(urls[2]).toContain('cursor=c2');
  });

  it('prints a table by default and points at the next page on stderr', async () => {
    const { fetch } = pagedFetch([
      {
        items: [
          {
            id: UUID,
            email: 'ada@example.org',
            display_name: 'Ada',
            status: 'active',
            is_admin: false,
            created_at: 'x',
            last_login_at: null,
            groups: [],
          },
        ],
        next_cursor: 'NEXT',
      },
    ]);
    const t = io({}, { fetch });
    expect(await main(['users', 'list'], t.io)).toBe(0);
    expect(t.out.join('')).toContain('ada@example.org');
    expect(t.errText.join('')).toContain('--cursor NEXT');
  });

  it('sends the bearer token and prints API errors on stderr with exit 1', async () => {
    /** @type {any[]} */
    const seen = [];
    const fetch = /** @type {any} */ (
      async (/** @type {string} */ _url, /** @type {any} */ init) => {
        seen.push(init);
        return new Response(
          JSON.stringify({
            error: {
              code: 'invalid_request',
              message: 'Invalid',
              details: [{ path: '/email', message: 'bad' }],
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
    );
    const t = io({}, { fetch });
    expect(await main(['users', 'create', '--email', 'nope'], t.io)).toBe(1);
    expect(seen[0].headers.authorization).toBe('Bearer tun_test');
    expect(t.errText.join('')).toBe('invalid_request: Invalid\n  /email: bad\n');
  });

  it('exits 1 on a network failure', async () => {
    const fetch = /** @type {any} */ (
      async () => {
        throw new TypeError('fetch failed');
      }
    );
    const t = io({}, { fetch });
    expect(await main(['whoami'], t.io)).toBe(1);
    expect(t.errText.join('')).toMatch(/^network: Cannot reach/);
  });

  it('refuses a destructive command without a terminal unless --yes is given', async () => {
    /** @type {number[]} */
    const calls = [];
    const fetch = /** @type {any} */ (
      async () => {
        calls.push(1);
        return new Response(null, { status: 204 });
      }
    );
    const refused = io({}, { fetch, isTTY: false });
    expect(await main(['users', 'delete', UUID], refused.io)).toBe(2);
    expect(refused.errText.join('')).toContain('--yes');
    expect(calls).toHaveLength(0);

    const confirmed = io({}, { fetch, isTTY: false });
    expect(await main(['users', 'delete', UUID, '--yes'], confirmed.io)).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('asks on a terminal and runs only on "yes"', async () => {
    const { Readable } = await import('node:stream');
    /** @type {number[]} */
    const calls = [];
    const fetch = /** @type {any} */ (
      async () => {
        calls.push(1);
        return new Response(null, { status: 204 });
      }
    );
    const yes = io({}, { fetch, isTTY: true, stdin: Readable.from(['yes\n']) });
    expect(await main(['groups', 'delete', '5'], yes.io)).toBe(0);
    expect(yes.errText.join('')).toContain('Type yes to continue');
    const no = io({}, { fetch, isTTY: true, stdin: Readable.from(['no\n']) });
    expect(await main(['groups', 'delete', '5'], no.io)).toBe(1);
    expect(no.errText.join('')).toContain('Aborted');
    expect(calls).toHaveLength(1);
  });

  it('warns about an unsafe config file on stderr and still runs', async () => {
    const configPath = '/cfg/tunnus.json';
    const fetch = /** @type {any} */ (
      async () =>
        new Response(JSON.stringify({ user: {}, token: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const t = io(
      { TUNNUS_URL: '', TUNNUS_ADMIN_TOKEN: '', TUNNUS_CONFIG: configPath },
      {
        fetch,
        readFile: (/** @type {string} */ p) => {
          if (p === configPath) return '{"url":"https://id.example.org","token":"tun_from_file"}';
          throw noFile();
        },
        stat: () => ({ mode: 0o644 }),
      },
    );
    expect(await main(['whoami'], t.io)).toBe(0);
    expect(t.errText.join('')).toContain('warning: ');
  });
});
