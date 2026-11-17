import pino from 'pino';
import { createApp } from './app.js';
import { loadClients, loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { ensureDefaultGroups } from './accounts.js';
import { ensureSigningKey } from './oidc/keys.js';
import { createMailerFromConfig } from './mail.js';

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
app.listen(config.port, () =>
  logger.info({ issuer: config.issuer, port: config.port }, 'tunnus listening'),
);
