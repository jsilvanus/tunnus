import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser } from '../src/accounts.js';
import { bootstrapAdmin, BootstrapInputError } from '../src/bootstrap.js';
import { startTunnus } from './helpers/harness.js';

const TOKEN = /^tun_[A-Za-z0-9_-]{43}$/;
/** @type {Awaited<ReturnType<typeof startTunnus>>} */
let t;
beforeAll(async () => {
  t = await startTunnus({ schema: 'tunnus_bootstrap_test' });
});
afterAll(async () => {
  await t.close();
});

describe('bootstrapAdmin', () => {
  it('creates the first admin with default groups and a usable token', async () => {
    const result = await bootstrapAdmin(t.pool, {
      email: '  First.Admin@Example.ORG ',
      name: 'First Admin',
      defaultGroups: t.config.defaultGroups,
    });
    expect(result.created).toBe(true);
    expect(result.token).toMatch(TOKEN);

    const { rows } = await t.pool.query(
      `SELECT u.email, u.display_name, u.is_admin, u.status, array_agg(g.name) AS groups
         FROM users u JOIN user_groups ug ON ug.user_id = u.id JOIN groups g ON g.id = ug.group_id
        WHERE u.id = $1 GROUP BY u.id`,
      [result.userId],
    );
    expect(rows[0]).toMatchObject({
      email: 'first.admin@example.org',
      display_name: 'First Admin',
      is_admin: true,
      status: 'active',
      groups: ['all'],
    });

    const me = await fetch(`${t.issuer}/admin/api/v1/me`, {
      headers: { authorization: `Bearer ${result.token}` },
    });
    expect(me.status).toBe(200);
    expect((await me.json()).user.email).toBe('first.admin@example.org');
  });

  it('promotes and re-activates an existing disabled user', async () => {
    const userId = await createUser(t.pool, 'dormant@example.org', []);
    await t.pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [userId]);

    const result = await bootstrapAdmin(t.pool, {
      email: 'dormant@example.org',
      defaultGroups: [],
      expiresDays: 30,
    });
    expect(result.created).toBe(false);
    expect(result.userId).toBe(userId);

    const { rows } = await t.pool.query('SELECT status, is_admin FROM users WHERE id = $1', [
      userId,
    ]);
    expect(rows[0]).toEqual({ status: 'active', is_admin: true });

    const me = await fetch(`${t.issuer}/admin/api/v1/me`, {
      headers: { authorization: `Bearer ${result.token}` },
    });
    expect(me.status).toBe(200);
  });

  it('audits the bootstrap with no actor and the new token id', async () => {
    const result = await bootstrapAdmin(t.pool, {
      email: 'audited@example.org',
      defaultGroups: [],
    });
    const { rows } = await t.pool.query(
      "SELECT actor_user_id, target_type, target_id, details FROM audit_events WHERE action = 'admin.bootstrap' AND target_id = $1",
      [result.userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_user_id: null,
      target_type: 'user',
      target_id: result.userId,
      details: { created: true, token_id: result.tokenId },
    });
    expect(JSON.stringify(rows)).not.toContain('audited@example.org');
  });

  it('rejects bad inputs before touching the database', async () => {
    await expect(bootstrapAdmin(t.pool, { email: 'not-an-email' })).rejects.toBeInstanceOf(
      BootstrapInputError,
    );
    await expect(
      bootstrapAdmin(t.pool, { email: 'ok@example.org', expiresDays: 366 }),
    ).rejects.toBeInstanceOf(BootstrapInputError);
  });
});

describe('tunnus-admin command', () => {
  const bin = fileURLToPath(new URL('../bin/tunnus-admin.js', import.meta.url));

  it('exits 2 on usage errors and prints nothing to stdout', () => {
    const res = spawnSync(process.execPath, [bin, 'bootstrap'], {
      env: { ...process.env, DATABASE_URL: '' },
      encoding: 'utf8',
    });
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('--email is required');
  });

  it('prints help and exits 0', () => {
    const res = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('tunnus-admin bootstrap --email');
  });
});
