import pino from 'pino';
import { createApp } from './app.js';
import { loadClients, loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { ensureDefaultGroups } from './accounts.js';
import { ensureSigningKey } from './oidc/keys.js';
import { createMailerFromConfig } from './mail.js';

const SHUTDOWN_GRACE_MS = 10_000;

const logger = pino();
const config = loadConfig();
const pool = createPool(config.databaseUrl);
await migrate(pool);
await ensureDefaultGroups(pool, config.defaultGroups);
await ensureSigningKey(pool, config.keyEncryptionSecret);

const { app, holder } = await createApp({
  config,
  pool,
  clients: loadClients(config.clientsFile),
  mailer: createMailerFromConfig(config, logger),
});
holder.start();
const server = app.listen(config.port, () =>
  logger.info({ issuer: config.issuer, port: config.port }, 'tunnus listening'),
);

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
  // TODO(cleanup): stop the job scheduler here once it exists.
  holder.stop();

  const closed = new Promise((resolve) => server.close(resolve));
  const forced = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
  await closed;
  clearTimeout(forced);

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
