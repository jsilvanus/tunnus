import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLEANUP_LOCK_KEY, BATCH_SIZE, runCleanup } from '../src/jobs/cleanup.js';
import { REDIRECT, browser, startTunnus } from './helpers/harness.js';

const DAY = 86_400_000;
/** The fixed clock for every run in this file. */
const NOW = new Date('2026-11-17T03:00:00Z');
/** @param {number} days @param {Date} [from] */
const ago = (days, from = NOW) => new Date(from.getTime() - days * DAY);
/** @param {number} days */
const later = (days) => new Date(NOW.getTime() + days * DAY);

/** @type {Awaited<ReturnType<typeof startTunnus>>} */
let t;
/** @type {{ to: string, deleteOn: Date, locale: string }[]} */
let warnings = [];
/** @type {Set<string>} */
let failing = new Set();

/** A mailer that records inactivity warnings and can refuse given addresses. */
const mailer = {
  async sendCode() {},
  async sendInactiveWarning(
    /** @type {string} */ to,
    /** @type {Date} */ deleteOn,
    /** @type {string} */ locale,
  ) {
    if (failing.has(to)) throw new Error(`refused ${to}`);
    warnings.push({ to, deleteOn, locale });
  },
};

/** @param {Partial<import('../src/config.js').Config['limits']>} [limits] */
const configWith = (limits = {}) => ({ ...t.config, limits: { ...t.config.limits, ...limits } });
/**
 * @param {Date} now
 * @param {Record<string, unknown>} [overrides]
 * @returns {Promise<any>} a run result, or `{ skipped: true }`
 */
const runAt = (now, overrides = {}) =>
  runCleanup({ pool: t.pool, config: configWith(), mailer, logger: silent, now, ...overrides });

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * @param {{ email: string, createdAt?: Date, lastLoginAt?: Date | null, status?: string, isAdmin?: boolean, warnedAt?: Date | null }} u
 */
async function addUser({
  email,
  createdAt = ago(800),
  lastLoginAt = null,
  status = 'active',
  isAdmin = false,
  warnedAt = null,
}) {
  const { rows } = await t.pool.query(
    `INSERT INTO users (email, display_name, status, is_admin, created_at, last_login_at, inactive_warned_at)
     VALUES ($1, 'Test', $2, $3, $4, $5, $6) RETURNING id`,
    [email, status, isAdmin, createdAt, lastLoginAt, warnedAt],
  );
  return /** @type {string} */ (rows[0].id);
}

/** @param {string} id */
async function userRow(id) {
  const { rows } = await t.pool.query(
    'SELECT status, inactive_warned_at, last_login_at FROM users WHERE id = $1',
    [id],
  );
  return rows[0];
}

/** Account ids that still exist, from a list of ids. @param {string[]} ids */
async function exists(ids) {
  const { rows } = await t.pool.query('SELECT id FROM users WHERE id = ANY($1::uuid[])', [ids]);
  return rows.map((r) => r.id).sort();
}

/**
 * @param {string} accountId
 * @param {Date} expiresAt
 */
async function addPayload(accountId, expiresAt) {
  await t.pool.query(
    `INSERT INTO oidc_payloads (type, id, payload, expires_at)
     VALUES ('Session', $1, $2, $3)`,
    [`s-${Math.random()}`, JSON.stringify({ accountId }), expiresAt],
  );
}

beforeAll(async () => {
  t = await startTunnus({ schema: 'tunnus_cleanup_it' });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  warnings = [];
  failing = new Set();
  await t.pool.query('TRUNCATE users, oidc_payloads, email_codes, audit_events CASCADE');
});

describe('expiry and audit tasks', () => {
  it('deletes expired payloads and codes older than a day, and keeps live or recently expired rows', async () => {
    await t.pool.query(
      `INSERT INTO oidc_payloads (type, id, payload, expires_at) VALUES
         ('Grant', 'gone', '{}', $1), ('Grant', 'live', '{}', $2)`,
      [ago(0.1), later(1)],
    );
    await t.pool.query(
      `INSERT INTO email_codes (email, code_hash, code_enc, link_token_hash, purpose, interaction_uid, expires_at)
       VALUES ('a@example.org', 'h', 'e', 'l', 'login', 'u1', $1),
              ('a@example.org', 'h', 'e', 'l', 'login', 'u2', $2),
              ('a@example.org', 'h', 'e', 'l', 'login', 'u3', $3)`,
      [ago(2), ago(0.5), later(0.1)],
    );

    const result = await runAt(NOW);
    expect(result).toMatchObject({ payloads: 1, codes: 1, errors: [] });

    const payloads = await t.pool.query('SELECT id FROM oidc_payloads ORDER BY id');
    expect(payloads.rows.map((r) => r.id)).toEqual(['live']);
    const codes = await t.pool.query(
      'SELECT interaction_uid FROM email_codes ORDER BY interaction_uid',
    );
    expect(codes.rows.map((r) => r.interaction_uid)).toEqual(['u2', 'u3']);
  });

  it('clears audit IPs past AUDIT_IP_RETENTION_DAYS and deletes audit rows past AUDIT_RETENTION_DAYS', async () => {
    await t.pool.query(
      `INSERT INTO audit_events (at, action, ip) VALUES
         ($1, 'signin', '192.0.2.1'), ($2, 'signin', '192.0.2.2'), ($3, 'signin', '192.0.2.4'),
         ($4, 'signin', '192.0.2.3'), ($5, 'signin', NULL)`,
      [ago(40), ago(10), ago(200), ago(10), ago(400)],
    );
    // The 40- and 200-day rows keep their rows and lose their IPs; the 400-day row goes.
    const result = await runAt(NOW);
    expect(result).toMatchObject({ auditIpsCleared: 2, auditDeleted: 1, errors: [] });

    const { rows } = await t.pool.query("SELECT ip FROM audit_events WHERE action = 'signin'");
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.ip ?? 'none').sort()).toEqual([
      '192.0.2.2',
      '192.0.2.3',
      'none',
      'none',
    ]);
  });

  it('keeps everything when the audit retention settings are zero', async () => {
    await t.pool.query(
      "INSERT INTO audit_events (at, action, ip) VALUES ($1, 'signin', '192.0.2.9'), ($2, 'signin', NULL)",
      [ago(900), ago(900)],
    );
    const config = {
      ...configWith(),
      retention: { ...t.config.retention, auditRetentionDays: 0, auditIpRetentionDays: 0 },
    };
    const result = await runCleanup({ pool: t.pool, config, mailer, logger: silent, now: NOW });
    expect(result).toMatchObject({ auditIpsCleared: 0, auditDeleted: 0 });
    const { rows } = await t.pool.query("SELECT ip FROM audit_events WHERE action = 'signin'");
    expect(rows.map((r) => r.ip)).toEqual(['192.0.2.9', null]);
  });

  it('works through more than one batch of 1 000 rows', async () => {
    expect(BATCH_SIZE).toBe(1000);
    await t.pool.query(
      `INSERT INTO oidc_payloads (type, id, payload, expires_at)
       SELECT 'Grant', 'old-' || g, '{}', $1 FROM generate_series(1, 2500) g`,
      [ago(1)],
    );
    await t.pool.query(
      "INSERT INTO oidc_payloads (type, id, payload, expires_at) VALUES ('Grant', 'live', '{}', $1)",
      [later(1)],
    );
    const result = await runAt(NOW);
    expect(result.payloads).toBe(2500);
    const { rows } = await t.pool.query('SELECT count(*)::int AS n FROM oidc_payloads');
    expect(rows[0].n).toBe(1);
  });
});

describe('inactive users', () => {
  it('warns once, then deletes after the warning period, with a fixed clock', async () => {
    const id = await addUser({ email: 'quiet@example.org', createdAt: ago(800) });
    await addPayload(id, later(1)); // a live session of the account

    const first = await runAt(NOW);
    expect(first).toMatchObject({ warned: 1, warnFailed: 0, deleted: 0, errors: [] });
    expect(warnings).toEqual([
      { to: 'quiet@example.org', deleteOn: later(30), locale: t.config.defaultLocale },
    ]);
    expect((await userRow(id)).inactive_warned_at.toISOString()).toBe(NOW.toISOString());
    const warned = await t.pool.query(
      "SELECT target_id FROM audit_events WHERE action = 'user.inactive_warned'",
    );
    expect(warned.rows).toEqual([{ target_id: id }]);

    // Still inside the warning period: not deleted, not warned again.
    const during = await runAt(later(29));
    expect(during).toMatchObject({ warned: 0, deleted: 0 });
    expect(await exists([id])).toEqual([id]);

    // Warning period over: deleted, with the sessions removed in the same step.
    const after = await runAt(later(30));
    expect(after).toMatchObject({ warned: 0, deleted: 1, errors: [] });
    expect(await exists([id])).toEqual([]);
    const sessions = await t.pool.query('SELECT count(*)::int AS n FROM oidc_payloads');
    expect(sessions.rows[0].n).toBe(0);
    const deleted = await t.pool.query(
      "SELECT target_id, actor_user_id FROM audit_events WHERE action = 'user.deleted_inactive'",
    );
    expect(deleted.rows).toEqual([{ target_id: id, actor_user_id: null }]);
  });

  it('a sign-in after the warning cancels it: the account is kept and not deleted', async () => {
    const email = 'returning@example.org';
    const id = await addUser({ email, createdAt: ago(800) });
    expect((await runAt(NOW)).warned).toBe(1);

    const b = browser();
    const { page } = await t.startAuth(b);
    const path = /** @type {string} */ (t.interactionPath(page.body));
    await b.post(`${t.origin}${path}/email`, { email });
    const mail = /** @type {any} */ (t.mails.at(-1));
    const done = await b.post(`${t.origin}${path}/code`, { code: mail.code });
    expect(done.finalUrl.startsWith(REDIRECT)).toBe(true);

    const row = await userRow(id);
    expect(row.inactive_warned_at).toBeNull();
    expect(row.last_login_at).not.toBeNull();

    // Far beyond the warning period, the account is active again: nothing happens.
    expect(await runAt(later(60))).toMatchObject({ warned: 0, deleted: 0 });
    expect(await exists([id])).toEqual([id]);
  });

  it('never warns or deletes administrators', async () => {
    const admin = await addUser({ email: 'admin@example.org', createdAt: ago(900), isAdmin: true });
    const disabledAdmin = await addUser({
      email: 'old-admin@example.org',
      createdAt: ago(900),
      isAdmin: true,
      status: 'disabled',
    });
    expect(await runAt(NOW)).toMatchObject({ warned: 0, deleted: 0 });
    expect(await runAt(later(1000))).toMatchObject({ warned: 0, deleted: 0 });
    expect(await exists([admin, disabledAdmin])).toEqual([admin, disabledAdmin].sort());
    expect((await userRow(admin)).inactive_warned_at).toBeNull();
  });

  it('leaves recently active users alone', async () => {
    const recent = await addUser({
      email: 'recent@example.org',
      createdAt: ago(900),
      lastLoginAt: ago(10),
    });
    const newcomer = await addUser({ email: 'new@example.org', createdAt: ago(5) });
    expect(await runAt(NOW)).toMatchObject({ warned: 0, deleted: 0 });
    expect(warnings).toEqual([]);
    expect(await exists([recent, newcomer])).toEqual([recent, newcomer].sort());
  });

  it('deletes disabled accounts past the deletion period without a warning', async () => {
    const disabled = await addUser({
      email: 'disabled@example.org',
      createdAt: ago(800),
      status: 'disabled',
    });
    const disabledRecent = await addUser({
      email: 'disabled-recent@example.org',
      createdAt: ago(800),
      lastLoginAt: ago(100),
      status: 'disabled',
    });
    const result = await runAt(NOW);
    expect(result).toMatchObject({ warned: 0, deleted: 1 });
    expect(await exists([disabled, disabledRecent])).toEqual([disabledRecent]);
  });

  it('retries a failed warning on the next run and audits the failure without the address', async () => {
    const id = await addUser({ email: 'flaky@example.org', createdAt: ago(800) });
    failing = new Set(['flaky@example.org']);

    const first = await runAt(NOW);
    expect(first).toMatchObject({ warned: 0, warnFailed: 1, errors: [] });
    expect((await userRow(id)).inactive_warned_at).toBeNull();
    const { rows } = await t.pool.query(
      "SELECT target_id, details FROM audit_events WHERE action = 'mail_error'",
    );
    expect(rows).toEqual([
      { target_id: id, details: { kind: 'inactive_warning', error: 'Error' } },
    ]);
    expect(JSON.stringify(rows)).not.toContain('flaky@example.org');

    failing = new Set();
    const retry = await runAt(later(1));
    expect(retry).toMatchObject({ warned: 1, warnFailed: 0 });
    expect(warnings.map((w) => w.to)).toEqual(['flaky@example.org']);
  });

  it('sends at most MAIL_DAILY_CAP warnings per run', async () => {
    for (const n of [1, 2, 3])
      await addUser({ email: `cap${n}@example.org`, createdAt: ago(800 + n) });
    const result = await runCleanup({
      pool: t.pool,
      config: configWith({ mailPerDay: 2 }),
      mailer,
      logger: silent,
      now: NOW,
    });
    expect(result).toMatchObject({ warned: 2, warnFailed: 0 });
    expect(warnings).toHaveLength(2);

    const next = await runAt(later(1), { config: configWith({ mailPerDay: 2 }) });
    expect(next.warned).toBe(1);
  });

  it('turns warnings and deletion off with INACTIVE_USER_DELETE_DAYS=0', async () => {
    const id = await addUser({ email: 'kept@example.org', createdAt: ago(5000) });
    const config = {
      ...configWith(),
      retention: { ...t.config.retention, inactiveUserDeleteDays: 0 },
    };
    const result = await runCleanup({ pool: t.pool, config, mailer, logger: silent, now: NOW });
    expect(result).toMatchObject({ warned: 0, deleted: 0 });
    expect(await exists([id])).toEqual([id]);
  });
});

describe('run control', () => {
  it('skips the run and changes nothing while another run holds the lock', async () => {
    await addPayload('nobody', ago(1));
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1::bigint)', [CLEANUP_LOCK_KEY]);
      expect(await runAt(NOW)).toEqual({ skipped: true });
      const { rows } = await t.pool.query('SELECT count(*)::int AS n FROM oidc_payloads');
      expect(rows[0].n).toBe(1);
      const audits = await t.pool.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE action = 'cleanup.run'",
      );
      expect(audits.rows[0].n).toBe(0);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1::bigint)', [CLEANUP_LOCK_KEY]);
      await holder.end();
    }
  });

  it('releases the lock after a run, even when a task fails', async () => {
    const broken = {
      connect: () => t.pool.connect(),
      query: (/** @type {string} */ sql, /** @type {unknown[]} */ params) =>
        sql.includes('DELETE FROM email_codes')
          ? Promise.reject(new Error('codes task broken'))
          : t.pool.query(sql, params),
    };
    const result = /** @type {any} */ (
      await runCleanup({
        pool: /** @type {any} */ (broken),
        config: configWith(),
        mailer,
        logger: silent,
        now: NOW,
      })
    );
    expect(result.errors).toEqual(['codes: codes task broken']);

    const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      const { rows } = await other.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [
        CLEANUP_LOCK_KEY,
      ]);
      expect(rows[0].locked).toBe(true);
      await other.query('SELECT pg_advisory_unlock($1::bigint)', [CLEANUP_LOCK_KEY]);
    } finally {
      await other.end();
    }
  });

  it('isolates a failing task: the others still run, and the run is not marked successful', async () => {
    await addPayload('nobody', ago(1));
    /** @type {number[]} */ const successes = [];
    const broken = {
      connect: () => t.pool.connect(),
      query: (/** @type {string} */ sql, /** @type {unknown[]} */ params) =>
        sql.includes('DELETE FROM email_codes')
          ? Promise.reject(new Error('codes task broken'))
          : t.pool.query(sql, params),
    };
    const result = await runCleanup({
      pool: /** @type {any} */ (broken),
      config: configWith(),
      mailer,
      logger: silent,
      now: NOW,
      metrics: { setCleanupSuccess: (d) => successes.push(d.getTime()) },
    });
    expect(result).toMatchObject({ payloads: 1, codes: 0, errors: ['codes: codes task broken'] });
    expect(successes).toEqual([]);

    const audit = await t.pool.query(
      "SELECT details FROM audit_events WHERE action = 'cleanup.run'",
    );
    expect(audit.rows[0].details).toMatchObject({
      payloads: 1,
      errors: ['codes: codes task broken'],
    });
  });

  it('marks a complete run successful for the metrics gauge', async () => {
    /** @type {number[]} */ const successes = [];
    await runCleanup({
      pool: t.pool,
      config: configWith(),
      mailer,
      logger: silent,
      now: NOW,
      metrics: { setCleanupSuccess: (d) => successes.push(d.getTime()) },
    });
    expect(successes).toEqual([NOW.getTime()]);
  });
});

describe('tunnus-admin cleanup', () => {
  const bin = fileURLToPath(new URL('../bin/tunnus-admin.js', import.meta.url));

  /**
   * Run the CLI against the given schema. Resolves with the exit status and output.
   * @param {string} schema
   * @param {Record<string, string>} [env]
   * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
   */
  function runCli(schema, env = {}) {
    const url = new URL(/** @type {string} */ (process.env.DATABASE_URL));
    url.searchParams.set('options', `-c search_path=${schema}`);
    const childEnv = {
      PATH: process.env.PATH ?? '',
      DATABASE_URL: url.href,
      ISSUER: 'https://id.example.org',
      KEY_ENCRYPTION_SECRET: 'cli-secret',
      COOKIE_SECRETS: 'cli-cookie',
      ...env,
    };
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [bin, 'cleanup'],
        { env: childEnv, encoding: 'utf8' },
        (error, stdout, stderr) =>
          resolve({ status: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
      );
    });
  }

  it('prints the counts as JSON on stdout and exits 0', async () => {
    await t.pool.query('TRUNCATE oidc_payloads CASCADE');
    await addPayload('nobody', ago(1, new Date()));
    const res = await runCli('tunnus_cleanup_it');
    expect(res.status).toBe(0);
    const result = JSON.parse(res.stdout);
    expect(result).toMatchObject({ payloads: 1, codes: 0, errors: [] });
    expect(Object.keys(result).sort()).toEqual([
      'auditDeleted',
      'auditIpsCleared',
      'codes',
      'deleted',
      'errors',
      'payloads',
      'warnFailed',
      'warned',
    ]);
  });

  it('prints { "skipped": true } and exits 0 while another run holds the lock', async () => {
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1::bigint)', [CLEANUP_LOCK_KEY]);
      const res = await runCli('tunnus_cleanup_it');
      expect(res.status).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual({ skipped: true });
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1::bigint)', [CLEANUP_LOCK_KEY]);
      await holder.end();
    }
  });

  it('exits 1 with the configuration error on stderr when the server settings are missing', async () => {
    const res = await runCli('tunnus_cleanup_it', { ISSUER: '' });
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('Missing required settings: ISSUER');
  });
});
