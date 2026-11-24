import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTunnus } from './helpers/harness.js';

const SCHEMA = 'tunnus_admin_cli_clients_test';
const BIN = fileURLToPath(new URL('../bin/tunnus-admin.js', import.meta.url));
const KEY_SECRET = 'test-key-encryption-secret-0123456789';

/** @type {Awaited<ReturnType<typeof startTunnus>>} */
let t;
let tempDir = '';
let dbUrl = '';

/**
 * Spawn `node bin/tunnus-admin.js ...` asynchronously so the event loop stays responsive
 * for the running Tunnus instance and its LISTEN/NOTIFY pg.Client.
 * @param {string[]} args
 * @param {{ env?: Record<string, string | undefined>, stdin?: string }} [opts]
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string }>}
 */
function runBin(args, { env = {}, stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        DATABASE_URL: dbUrl,
        KEY_ENCRYPTION_SECRET: KEY_SECRET,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({
        status,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

beforeAll(async () => {
  t = await startTunnus({
    schema: SCHEMA,
    env: { KEY_RELOAD_INTERVAL_SECONDS: '0' },
  });
  await t.holder.start();
  const u = new URL(/** @type {string} */ (process.env.DATABASE_URL));
  u.searchParams.set('options', `-c search_path=${SCHEMA}`);
  dbUrl = u.toString();
  tempDir = mkdtempSync(join(tmpdir(), 'tunnus-admin-clients-'));
});

afterAll(async () => {
  await t.close();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('tunnus-admin clients', () => {
  it('exits 2 on usage errors and never echoes literal secret flags', async () => {
    const cases = [
      ['clients'],
      ['clients', 'unknown'],
      ['clients', 'list', 'extra'],
      ['clients', 'put'],
      ['clients', 'put', 'my-app'],
      ['clients', 'put', 'my-app', '--metadata-file', '-', '--secret-env', 'MISSING_ENV_VAR'],
      ['clients', 'put', 'my-app', '--metadata-file', '-', '--secret-env', 'EMPTY_VAR'],
      [
        'clients',
        'put',
        'my-app',
        '--metadata-file',
        '-',
        '--secret-env',
        'CLIENT_SECRET',
        '--generate-secret',
      ],
      ['clients', 'rotate-secret', 'my-app', '--secret-env', 'CLIENT_SECRET', '--generate-secret'],
      ['clients', 'rotate-secret', 'my-app', '--secret', 'literal-in-argv'],
      ['clients', 'adopt'],
      ['clients', 'delete'],
    ];
    const results = await Promise.all(
      cases.map((args) =>
        runBin(args, {
          env: {
            CLIENT_SECRET: 'valid-secret-value-0123456789abcdef',
            EMPTY_VAR: '',
          },
          stdin: '{"redirect_uris":["https://app.example.org/cb"]}',
        }),
      ),
    );
    results.forEach((res, i) => {
      expect(res.status, cases[i].join(' ')).toBe(2);
    });

    const badJson = await runBin(
      ['clients', 'put', 'my-app', '--metadata-file', '-', '--generate-secret'],
      { stdin: 'not-json' },
    );
    expect(badJson.status).toBe(2);
  }, 20_000);

  it('puts via stdin + --secret-env and reloads running provider via LISTEN/NOTIFY with interval 0', async () => {
    const secret = 'cli-provisioned-secret-0123456789abcdef';
    const meta = JSON.stringify({
      redirect_uris: ['https://cli-app.example.org/api/auth/callback'],
      post_logout_redirect_uris: ['https://cli-app.example.org'],
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code', 'refresh_token'],
      first_party: true,
      always_include_groups: true,
      allowed_resources: ['https://cli-app.example.org/mcp'],
      backchannel_logout_uri: 'https://cli-app.example.org/api/auth/backchannel',
      backchannel_logout_session_required: false,
    });

    const putRes = await runBin(
      ['clients', 'put', 'cli-app', '--metadata-file', '-', '--secret-env', 'CLIENT_SECRET'],
      { env: { CLIENT_SECRET: secret }, stdin: meta },
    );
    expect(putRes.status, putRes.stderr).toBe(0);
    // Secret passed via --secret-env must NEVER be printed to stdout or stderr
    expect(putRes.stdout).not.toContain(secret);
    expect(putRes.stderr).not.toContain(secret);

    // Provider holder had KEY_RELOAD_INTERVAL_SECONDS=0; LISTEN/NOTIFY must reload automatically
    await vi.waitFor(
      async () => {
        const found = await t.holder.current.Client.find('cli-app');
        expect(found).toBeDefined();
        expect(found?.clientSecret).toBe(secret);
      },
      { timeout: 5000 },
    );

    // Generated secret path via file
    const metaFile = join(tempDir, 'gen-meta.json');
    writeFileSync(
      metaFile,
      JSON.stringify({
        redirect_uris: ['https://gen-cli.example.org/cb'],
        token_endpoint_auth_method: 'client_secret_basic',
      }),
    );
    const genRes = await runBin([
      'clients',
      'put',
      'gen-cli',
      '--metadata-file',
      metaFile,
      '--generate-secret',
    ]);
    expect(genRes.status, genRes.stderr).toBe(0);
    const generated = genRes.stdout.trim();
    expect(generated.length).toBeGreaterThanOrEqual(32);
    expect(genRes.stderr).not.toContain(generated);

    // list and list --json
    const listText = await runBin(['clients', 'list']);
    expect(listText.status).toBe(0);
    expect(listText.stdout).toContain('cli-app');
    expect(listText.stdout).toContain('gen-cli');
    expect(listText.stdout).not.toContain(secret);
    expect(listText.stdout).not.toContain(generated);

    const listJson = await runBin(['clients', 'list', '--json']);
    expect(listJson.status).toBe(0);
    const parsedList = JSON.parse(listJson.stdout);
    expect(parsedList.items.map((/** @type {any} */ c) => c.client_id)).toEqual([
      'cli-app',
      'gen-cli',
      'rp',
    ]);
    expect(listJson.stdout).not.toContain(secret);
    expect(listJson.stdout).not.toContain(generated);

    // adopt file-seeded client `rp`
    const adoptRes = await runBin(['clients', 'adopt', 'rp']);
    expect(adoptRes.status, adoptRes.stderr).toBe(0);
    const afterAdopt = JSON.parse((await runBin(['clients', 'list', '--json'])).stdout);
    expect(afterAdopt.items.find((/** @type {any} */ c) => c.client_id === 'rp')?.source).toBe(
      'api',
    );

    // rotate-secret with --secret-env
    const newSecret = 'rotated-cli-secret-0123456789abcdefghij';
    const rotEnv = await runBin(
      ['clients', 'rotate-secret', 'cli-app', '--secret-env', 'CLIENT_SECRET'],
      { env: { CLIENT_SECRET: newSecret } },
    );
    expect(rotEnv.status, rotEnv.stderr).toBe(0);
    expect(rotEnv.stdout).not.toContain(newSecret);
    expect(rotEnv.stderr).not.toContain(newSecret);

    await vi.waitFor(
      async () => {
        const found = await t.holder.current.Client.find('cli-app');
        expect(found?.clientSecret).toBe(newSecret);
      },
      { timeout: 5000 },
    );

    // rotate-secret with --generate-secret --revoke-tokens
    const rotGen = await runBin([
      'clients',
      'rotate-secret',
      'cli-app',
      '--generate-secret',
      '--revoke-tokens',
    ]);
    expect(rotGen.status, rotGen.stderr).toBe(0);
    expect(rotGen.stdout.trim().length).toBeGreaterThanOrEqual(32);

    // delete client via tunnus-admin -> NOTIFY removes from provider
    const delRes = await runBin(['clients', 'delete', 'cli-app']);
    expect(delRes.status, delRes.stderr).toBe(0);
    await vi.waitFor(
      async () => {
        expect(await t.holder.current.Client.find('cli-app')).toBeUndefined();
      },
      { timeout: 5000 },
    );

    // Audit checks: actor_user_id is NULL and details.via === 'tunnus-admin'
    const { rows: auditRows } = await t.pool.query(
      "SELECT actor_user_id, action, target_id, details FROM audit_events WHERE details->>'via' = 'tunnus-admin' ORDER BY id",
    );
    expect(auditRows.length).toBeGreaterThanOrEqual(5);
    for (const row of auditRows) {
      expect(row.actor_user_id).toBeNull();
      expect(row.details.via).toBe('tunnus-admin');
    }
    const serialized = JSON.stringify(auditRows);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(generated);
    expect(serialized).not.toContain(newSecret);
  }, 20_000);
});
