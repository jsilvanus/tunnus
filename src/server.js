import { createApp } from './app.js';
import { loadClients, loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { ensureDefaultGroups } from './accounts.js';
import { ensureSigningKey } from './oidc/keys.js';
import { createMailerFromConfig } from './mail.js';
import { startCleanupScheduler } from './jobs/scheduler.js';
import { errorFields, logger } from './logger.js';

const SHUTDOWN_GRACE_MS = 10_000;

const config = loadConfig();
const pool = createPool(config.databaseUrl);
await migrate(pool);
await ensureDefaultGroups(pool, config.defaultGroups);
await ensureSigningKey(pool, config.keyEncryptionSecret);

const mailer = createMailerFromConfig(config, logger);
const { app, holder, metrics } = await createApp({
  config,
  pool,
  clients: loadClients(config.clientsFile),
  mailer,
});
holder.start();
const cleanup = startCleanupScheduler({ config, pool, mailer, logger, metrics });
const server = app.listen(config.port, () =>
  logger.info({ issuer: config.issuer, port: config.port }, 'tunnus listening'),
);

/**
 * A failure outside a request is logged, then the process exits non-zero: its state is unknown,
 * and a supervisor restarts it.
 * @param {string} event
 * @param {unknown} err
 */
function fatal(event, err) {
  logger.fatal({ event, err: errorFields(err) }, 'fatal error, exiting');
  process.exit(1);
}
process.on('uncaughtException', (err) => fatal('uncaughtException', err));
process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason));

let shuttingDown = false;

/**
 * Stop background work, let open requests finish (at most SHUTDOWN_GRACE_MS), then close the
 * pool. A second signal exits at once.
 * @param {string} signal
 */
async function shutdown(signal) {
  if (shuttingDown) {
    logger.warn({ signal }, 'second signal, exiting now');
    process.exit(1);
  }
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  holder.stop();
  const cleanupDone = cleanup.stop();

  const closed = new Promise((resolve) => server.close(resolve));
  const forced = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
  await closed;
  clearTimeout(forced);
  // A cleanup run in progress gets the same grace period before the pool closes.
  await Promise.race([
    cleanupDone,
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref()),
  ]);

  try {
    await pool.end();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'pool shutdown failed');
    process.exit(1);
  }
}

for (const signal of /** @type {const} */ (['SIGTERM', 'SIGINT'])) {
  process.on(signal, () => void shutdown(signal));
}
