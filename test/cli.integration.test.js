import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/cli/main.js';
import { ADMIN_EMAIL, startAdmin } from './helpers/admin.js';

/** @type {Awaited<ReturnType<typeof startAdmin>>} */
let t;
/** Empty home directory, so no real config file is read. */
let home = '';

beforeAll(async () => {
  t = await startAdmin({ schema: 'cli_it' });
  home = mkdtempSync(join(tmpdir(), 'tunnus-cli-home-'));
});
afterAll(async () => {
  await t.close();
});

/**
 * Run the CLI in-process and capture its output.
 * @param {string[]} args
 * @param {{ env?: Record<string, string>, isTTY?: boolean, stdin?: string[] }} [opts]
 */
async function run(args, opts = {}) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const errOut = [];
  const code = await main(args, {
    env: opts.env ?? { TUNNUS_URL: t.issuer, TUNNUS_ADMIN_TOKEN: t.token },
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => errOut.push(s) },
    stdin: opts.stdin ? Readable.from(opts.stdin) : undefined,
    isTTY: opts.isTTY ?? false,
    home,
  });
  return { code, out: out.join(''), err: errOut.join('') };
}

/** @param {string[]} args */
async function runJson(args) {
  const res = await run([...args, '--json']);
  expect(res.code, res.err).toBe(0);
  return JSON.parse(res.out);
}

describe('CLI against a running Tunnus', () => {
  it('whoami shows the admin behind the token', async () => {
    const res = await run(['whoami']);
    expect(res.code).toBe(0);
    expect(res.out).toContain(`user.email: ${ADMIN_EMAIL}`);
    expect(res.out).toContain('token.label: test');
  });

  it('creates a user and reads it back as JSON and as a table', async () => {
    const created = await runJson([
      'users',
      'create',
      '--email',
      'ada@example.org',
      '--display-name',
      'Ada',
    ]);
    expect(created).toMatchObject({
      email: 'ada@example.org',
      display_name: 'Ada',
      status: 'active',
    });

    const list = await runJson(['users', 'list', '--email', 'ada@example.org']);
    expect(list.items).toEqual([expect.objectContaining({ id: created.id })]);

    const table = await run(['users', 'list', '--q', 'ada']);
    expect(table.code).toBe(0);
    expect(table.out.split('\n')[0]).toMatch(/^id\s+email\s+display_name/);
    expect(table.out).toContain('ada@example.org');

    const got = await run(['users', 'get', created.id]);
    expect(got.code).toBe(0);
    expect(got.out).toContain('email: ada@example.org');
  });

  it('creates a group, grants it with positional ids, and lists it', async () => {
    const group = await runJson(['groups', 'create', '--name', 'staff', '--description', 'Staff']);
    const user = await runJson(['users', 'create', '--email', 'grace@example.org']);
    const granted = await run(['groups', 'grant', String(group.id), user.id]);
    expect(granted.code).toBe(0);
    expect(granted.out).toContain('group_name: staff');

    const groups = await run(['users', 'groups', user.id]);
    expect(groups.out).toContain('staff');
  });

  it('pages through every user with --all', async () => {
    for (const n of [1, 2, 3]) {
      await runJson(['users', 'create', '--email', `bulk${n}@example.org`]);
    }
    const everything = await runJson(['users', 'list', '--limit', '200']);
    const all = await runJson(['users', 'list', '--limit', '1', '--all']);
    expect(all.items).toHaveLength(everything.items.length);
    expect(all.items.map((/** @type {any} */ u) => u.email)).toEqual(
      expect.arrayContaining(['bulk1@example.org', 'bulk2@example.org', 'bulk3@example.org']),
    );
  });

  it('refuses a destructive command without a terminal or --yes, and runs it with --yes', async () => {
    const user = await runJson(['users', 'create', '--email', 'doomed@example.org']);

    const refused = await run(['users', 'delete', user.id]);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('--yes');
    expect((await run(['users', 'get', user.id])).code).toBe(0);

    const deleted = await run(['users', 'delete', user.id, '--yes']);
    expect(deleted.code).toBe(0);
    const gone = await run(['users', 'get', user.id]);
    expect(gone.code).toBe(1);
    expect(gone.err).toContain('not_found');
  });

  it('asks on a terminal, and runs only on "yes"', async () => {
    const group = await runJson(['groups', 'create', '--name', 'temporary']);

    const no = await run(['groups', 'delete', String(group.id)], { isTTY: true, stdin: ['no\n'] });
    expect(no.code).toBe(1);
    expect(no.err).toContain('Aborted');
    expect((await run(['groups', 'get', String(group.id)])).code).toBe(0);

    const yes = await run(['groups', 'delete', String(group.id)], {
      isTTY: true,
      stdin: ['yes\n'],
    });
    expect(yes.code).toBe(0);
    expect(yes.err).toContain('Type yes to continue');
    expect((await run(['groups', 'get', String(group.id)])).code).toBe(1);
  });

  it('creates an admin token once, shows the value, and revokes it', async () => {
    const created = await runJson([
      'tokens',
      'create',
      '--label',
      'cli-it',
      '--expires-in-days',
      '1',
    ]);
    expect(created.token).toMatch(/^tun_[A-Za-z0-9_-]{43}$/);

    const plain = await run(['tokens', 'create', '--label', 'cli-it-table']);
    expect(plain.code).toBe(0);
    expect(plain.out).toMatch(/token: tun_/);
    expect(plain.err).toContain('shown only once');

    const listed = await runJson(['tokens', 'list']);
    expect(listed.items.map((/** @type {any} */ x) => x.label)).toContain('cli-it');

    const revoked = await run(['tokens', 'revoke', created.id]);
    expect(revoked.code).toBe(0);
    const withRevoked = await runJson(['tokens', 'list', '--include-inactive']);
    expect(
      withRevoked.items.find((/** @type {any} */ x) => x.id === created.id).revoked_at,
    ).not.toBeNull();
  });

  it('reads keys, clients and audit events', async () => {
    const keys = await run(['keys', 'list']);
    expect(keys.code).toBe(0);
    expect(keys.out.split('\n')[0]).toMatch(/kid/);
    expect((await run(['clients', 'list'])).code).toBe(0);
    const audit = await runJson(['audit', 'list', '--action', 'admin.*', '--limit', '5']);
    expect(audit.items.length).toBeGreaterThan(0);
    expect(audit.items[0].action).toMatch(/^admin\./);
  });

  it('exits 1 for an invalid token, with the API error on stderr', async () => {
    const res = await run(['users', 'list'], {
      env: { TUNNUS_URL: t.issuer, TUNNUS_ADMIN_TOKEN: `tun_${'a'.repeat(43)}` },
    });
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/^unauthorized: /);
  });

  it('exits 2 when no URL or token is configured', async () => {
    const noUrl = await run(['whoami'], { env: { TUNNUS_ADMIN_TOKEN: t.token } });
    expect(noUrl.code).toBe(2);
    expect(noUrl.err).toContain('No Tunnus URL');
    const noToken = await run(['whoami'], { env: { TUNNUS_URL: t.issuer } });
    expect(noToken.code).toBe(2);
    expect(noToken.err).toContain('No admin token');
  });

  it('exits 2 on a usage error and names the flag', async () => {
    const res = await run(['users', 'list', '--bogus']);
    expect(res.code).toBe(2);
    expect(res.err).toContain('Unknown flag --bogus');
  });

  it('prints help without contacting the server', async () => {
    const res = await run(['users', 'list', '--help'], { env: {} });
    expect(res.code).toBe(0);
    expect(res.out).toContain('--status <string>  one of active, disabled');
  });
});
