import { deleteUserAccount } from '../accounts.js';
import { audit } from '../audit.js';

/**
 * Cleanup tasks and the runner that executes them in order. Every time comparison uses the
 * `now` passed in, so tests can fix the clock.
 */

/** Rows per DELETE or UPDATE statement. Each statement is its own short transaction. */
export const BATCH_SIZE = 1000;

/** Advisory lock key shared by every cleanup run against one database. */
export const CLEANUP_LOCK_KEY = 7274831;

const DAY_MS = 86_400_000;

/**
 * @typedef {{
 *   debug: (o: object, m: string) => void,
 *   info: (o: object, m: string) => void,
 *   warn: (o: object, m: string) => void,
 *   error: (o: object, m: string) => void,
 * }} Logger
 */

/**
 * @typedef {{
 *   payloads: number,
 *   codes: number,
 *   auditIpsCleared: number,
 *   auditDeleted: number,
 *   warned: number,
 *   warnFailed: number,
 *   deleted: number,
 *   errors: string[],
 * }} CleanupResult
 */

/**
 * @param {Date} now
 * @param {number} days
 * @returns {Date}
 */
const daysBefore = (now, days) => new Date(now.getTime() - days * DAY_MS);

/** @param {unknown} err */
const errorMessage = (err) => (err instanceof Error ? err.message : String(err));

/**
 * Run a statement that affects at most BATCH_SIZE rows per execution, until one execution
 * affects fewer rows than that.
 * @param {import('pg').Pool} pool
 * @param {string} sql must take the batch size as its last parameter
 * @param {unknown[]} params
 * @returns {Promise<number>} rows affected in total
 */
async function inBatches(pool, sql, params) {
  let total = 0;
  for (;;) {
    const { rowCount } = await pool.query(sql, [...params, BATCH_SIZE]);
    const affected = rowCount ?? 0;
    total += affected;
    if (affected < BATCH_SIZE) return total;
  }
}

/**
 * Delete sign-in payloads (authorization codes, sessions, grants, tokens) past their expiry.
 * @param {import('pg').Pool} pool
 * @param {Date} now
 * @returns {Promise<number>}
 */
export function deleteExpiredPayloads(pool, now) {
  return inBatches(
    pool,
    `DELETE FROM oidc_payloads WHERE ctid IN (
       SELECT ctid FROM oidc_payloads WHERE expires_at < $1 LIMIT $2)`,
    [now],
  );
}

/**
 * Delete sign-in codes that expired more than a day ago. The day keeps recent rows for the
 * per-day mail count and for audit questions.
 * @param {import('pg').Pool} pool
 * @param {Date} now
 * @returns {Promise<number>}
 */
export function deleteExpiredCodes(pool, now) {
  return inBatches(
    pool,
    `DELETE FROM email_codes WHERE ctid IN (
       SELECT ctid FROM email_codes WHERE expires_at < $1 LIMIT $2)`,
    [daysBefore(now, 1)],
  );
}

/**
 * Remove IP addresses from audit rows older than `days`. Zero disables the task.
 * @param {import('pg').Pool} pool
 * @param {Date} now
 * @param {number} days
 * @returns {Promise<number>}
 */
export function clearAuditIps(pool, now, days) {
  if (days === 0) return Promise.resolve(0);
  return inBatches(
    pool,
    `UPDATE audit_events SET ip = NULL WHERE ctid IN (
       SELECT ctid FROM audit_events WHERE at < $1 AND ip IS NOT NULL LIMIT $2)`,
    [daysBefore(now, days)],
  );
}

/**
 * Delete audit rows older than `days`. Zero disables the task.
 * @param {import('pg').Pool} pool
 * @param {Date} now
 * @param {number} days
 * @returns {Promise<number>}
 */
export function deleteOldAudit(pool, now, days) {
  if (days === 0) return Promise.resolve(0);
  return inBatches(
    pool,
    `DELETE FROM audit_events WHERE ctid IN (
       SELECT ctid FROM audit_events WHERE at < $1 LIMIT $2)`,
    [daysBefore(now, days)],
  );
}

/**
 * Send the inactivity warning to active, non-admin users who have been inactive long enough
 * that deletion is due within WARN_DAYS, and who have not been warned yet. A user is inactive
 * since `coalesce(last_login_at, created_at)`. A failed send leaves `inactive_warned_at` NULL,
 * so the next run retries it. At most `cap` warnings are sent per run.
 * @param {{ pool: import('pg').Pool, config: import('../config.js').Config, mailer: import('../mail.js').Mailer, logger: Logger, now: Date, cap: number }} deps
 * @returns {Promise<{ warned: number, warnFailed: number }>}
 */
export async function warnInactiveUsers({ pool, config, mailer, logger, now, cap }) {
  const { inactiveUserDeleteDays, inactiveUserWarnDays } = config.retention;
  if (inactiveUserDeleteDays === 0 || cap <= 0) return { warned: 0, warnFailed: 0 };

  const inactiveBefore = daysBefore(now, inactiveUserDeleteDays - inactiveUserWarnDays);
  const deleteOn = new Date(now.getTime() + inactiveUserWarnDays * DAY_MS);
  const { rows } = await pool.query(
    `SELECT id, email FROM users
      WHERE status = 'active' AND NOT is_admin AND inactive_warned_at IS NULL
        AND coalesce(last_login_at, created_at) < $1
      ORDER BY coalesce(last_login_at, created_at), id
      LIMIT $2`,
    [inactiveBefore, cap],
  );

  let warned = 0;
  let warnFailed = 0;
  for (const row of rows) {
    try {
      await mailer.sendInactiveWarning(row.email, deleteOn, config.defaultLocale);
    } catch (err) {
      warnFailed++;
      logger.warn({ task: 'inactive_warning', userId: row.id }, 'inactivity warning not sent');
      await audit(pool, {
        action: 'mail_error',
        targetType: 'user',
        targetId: row.id,
        details: { kind: 'inactive_warning', error: err instanceof Error ? err.name : 'error' },
      });
      continue;
    }
    await pool.query('UPDATE users SET inactive_warned_at = $2 WHERE id = $1', [row.id, now]);
    await audit(pool, { action: 'user.inactive_warned', targetType: 'user', targetId: row.id });
    warned++;
  }
  return { warned, warnFailed };
}

/**
 * Delete inactive, non-admin users: those disabled, and those warned at least WARN_DAYS ago.
 * Each deletion re-checks the condition under a row lock, so a sign-in that happens in
 * the meantime keeps the account. Uses the same delete path as the admin API.
 * @param {{ pool: import('pg').Pool, config: import('../config.js').Config, now: Date }} deps
 * @returns {Promise<number>}
 */
export async function deleteInactiveUsers({ pool, config, now }) {
  const { inactiveUserDeleteDays, inactiveUserWarnDays } = config.retention;
  if (inactiveUserDeleteDays === 0) return 0;

  const deleteBefore = daysBefore(now, inactiveUserDeleteDays);
  const warnBefore = daysBefore(now, inactiveUserWarnDays);
  const eligible = `NOT is_admin
        AND coalesce(last_login_at, created_at) < $2
        AND (status = 'disabled' OR (inactive_warned_at IS NOT NULL AND inactive_warned_at <= $3))`;

  let deleted = 0;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT id FROM users WHERE ${eligible} ORDER BY id LIMIT $1`,
      [BATCH_SIZE, deleteBefore, warnBefore],
    );
    let roundDeleted = 0;
    for (const row of rows) {
      const removed = await inTransaction(pool, async (client) => {
        const { rows: locked } = await client.query(
          `SELECT id FROM users WHERE id = $1 AND ${eligible} FOR UPDATE`,
          [row.id, deleteBefore, warnBefore],
        );
        if (!locked[0]) return false;
        return (await deleteUserAccount(client, row.id)) === 1;
      });
      if (removed) {
        roundDeleted++;
        await audit(pool, {
          action: 'user.deleted_inactive',
          targetType: 'user',
          targetId: row.id,
        });
      }
    }
    deleted += roundDeleted;
    // A short page is the last one. A page where nothing was deleted cannot make progress.
    if (rows.length < BATCH_SIZE || roundDeleted === 0) return deleted;
  }
}

/**
 * @template T
 * @param {import('pg').Pool} pool
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function inTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Take the cleanup lock on a dedicated connection. Returns null when another run holds it.
 * @param {import('pg').Pool} pool
 * @returns {Promise<import('pg').PoolClient | null>}
 */
async function acquireLock(pool) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [
      CLEANUP_LOCK_KEY,
    ]);
    if (rows[0].locked) return client;
    client.release();
    return null;
  } catch (err) {
    client.release(/** @type {Error} */ (err));
    throw err;
  }
}

/**
 * Release the lock and the connection. A connection that cannot unlock is destroyed, which
 * ends the session and drops the lock with it.
 * @param {import('pg').PoolClient} client
 */
async function releaseLock(client) {
  try {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [CLEANUP_LOCK_KEY]);
    client.release();
  } catch (err) {
    client.release(/** @type {Error} */ (err));
  }
}

/**
 * Run every cleanup task once, in order. A failing task is recorded in `errors` and the
 * others still run. Only one run proceeds at a time across processes: a run that cannot take
 * the advisory lock returns `{ skipped: true }`. A run with no task errors marks the metrics
 * gauge as successful.
 * @param {{
 *   pool: import('pg').Pool,
 *   config: import('../config.js').Config,
 *   mailer: import('../mail.js').Mailer,
 *   logger: Logger,
 *   metrics?: { setCleanupSuccess(date: Date): void },
 *   now?: Date,
 * }} deps
 * @returns {Promise<CleanupResult | { skipped: true }>}
 */
export async function runCleanup({ pool, config, mailer, logger, metrics, now = new Date() }) {
  const lock = await acquireLock(pool);
  if (!lock) {
    logger.debug({}, 'cleanup skipped: another run holds the lock');
    return { skipped: true };
  }

  /** @type {string[]} */
  const errors = [];
  /**
   * @template T
   * @param {string} name
   * @param {T} fallback
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const task = async (name, fallback, fn) => {
    try {
      return await fn();
    } catch (err) {
      errors.push(`${name}: ${errorMessage(err)}`);
      logger.error({ task: name, err: errorMessage(err) }, 'cleanup task failed');
      return fallback;
    }
  };

  try {
    const payloads = await task('payloads', 0, () => deleteExpiredPayloads(pool, now));
    const codes = await task('codes', 0, () => deleteExpiredCodes(pool, now));
    const auditIpsCleared = await task('audit_ips', 0, () =>
      clearAuditIps(pool, now, config.retention.auditIpRetentionDays),
    );
    const auditDeleted = await task('audit_rows', 0, () =>
      deleteOldAudit(pool, now, config.retention.auditRetentionDays),
    );
    const warnings = await task('inactive_warnings', { warned: 0, warnFailed: 0 }, () =>
      warnInactiveUsers({ pool, config, mailer, logger, now, cap: config.limits.mailPerDay }),
    );
    const deleted = await task('inactive_deletes', 0, () =>
      deleteInactiveUsers({ pool, config, now }),
    );

    /** @type {CleanupResult} */
    const result = {
      payloads,
      codes,
      auditIpsCleared,
      auditDeleted,
      warned: warnings.warned,
      warnFailed: warnings.warnFailed,
      deleted,
      errors,
    };
    await audit(pool, { action: 'cleanup.run', details: { ...result } });
    logger.info({ ...result }, 'cleanup run finished');
    if (errors.length === 0) metrics?.setCleanupSuccess(now);
    return result;
  } finally {
    await releaseLock(lock);
  }
}
