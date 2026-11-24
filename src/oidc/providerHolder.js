import pg from 'pg';
import { createProvider } from './provider.js';
import { loadJwks, publishedKids } from './keys.js';
import { getClientVersion, listClients } from '../clients/store.js';
import { normalizeClientForProvider } from '../clients/validate.js';
import { errorFields, logger as defaultLogger } from '../logger.js';

/**
 * Holds the current oidc-provider instance. oidc-provider reads its keystore and static client
 * list at construction, so the holder rebuilds the provider whenever the published key set or
 * database client version changes.
 * @param {{
 *   config: import('../config.js').Config,
 *   pool: import('pg').Pool,
 *   metrics?: import('../metrics.js').Metrics,
 *   logger?: { error: (obj: unknown, msg?: string) => void },
 * }} deps
 */
export async function createProviderHolder({ config, pool, metrics, logger = defaultLogger }) {
  /** @type {import('oidc-provider').Provider | undefined} */
  let provider;
  /** @type {Record<string, any>[]} */
  let currentClients = [];
  /** @type {string[]} */
  let loadedKids = [];
  let loadedClientVersion = '';
  let initialized = false;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** @type {NodeJS.Timeout | null} */
  let reconnectTimer = null;
  /** @type {import('pg').Client | null} */
  let listenClient = null;
  /** @type {Promise<void> | null} */
  let connecting = null;
  let stopped = false;
  let checking = false;
  let dirty = false;
  /** @type {Promise<void>} */
  let reloadQueue = Promise.resolve();

  /**
   * Strip `client_secret` before exposing clients outside the provider.
   * @param {Record<string, any>} client
   */
  function sanitize(client) {
    const out = { ...client };
    delete out.client_secret;
    return out;
  }

  /**
   * Isolate valid clients by running `probe.Client.validate` on each row.
   * @param {import('oidc-provider').Provider} probe
   * @param {Record<string, any>[]} rows
   */
  async function filterValidClients(probe, rows) {
    /** @type {Record<string, any>[]} */
    const valid = [];
    for (const c of rows) {
      try {
        await probe.Client.validate(
          /** @type {import('oidc-provider').ClientMetadata} */ (normalizeClientForProvider(c)),
        );
        valid.push(c);
      } catch (rowErr) {
        logger.error({ clientId: c.client_id, err: errorFields(rowErr) }, 'client.invalid');
        metrics?.incClientInvalid();
      }
    }
    return valid;
  }

  /** Load the key set and enabled DB clients, validate, and build a new provider. */
  async function doReload() {
    const [jwks, clientVersion, rawClients] = await Promise.all([
      loadJwks(pool, config.keyEncryptionSecret),
      getClientVersion(pool),
      listClients(pool, config.keyEncryptionSecret, {
        logger,
        onInvalid: () => metrics?.incClientInvalid(),
      }),
    ]);

    let validClients = rawClients;
    let next;
    try {
      next = createProvider({ config, pool, clients: validClients, jwks });
      const checked = await filterValidClients(next, validClients);
      if (checked.length !== validClients.length) {
        validClients = checked;
        next = createProvider({ config, pool, clients: validClients, jwks });
      }
    } catch (err) {
      const probe = createProvider({ config, pool, clients: [], jwks });
      validClients = await filterValidClients(probe, rawClients);
      if (validClients.length === rawClients.length) {
        throw err;
      }
      next = createProvider({ config, pool, clients: validClients, jwks });
    }

    provider = next;
    currentClients = validClients.map(sanitize);
    loadedKids = jwks.keys.map((k) => k.kid);
    loadedClientVersion = clientVersion;
    if (initialized) {
      metrics?.incClientReload();
    }
    initialized = true;
  }

  /** Serialized reload so concurrent callers never swap an older snapshot over a newer one. */
  function reload() {
    const run = reloadQueue.then(
      () => doReload(),
      () => doReload(),
    );
    reloadQueue = run.catch(() => undefined);
    return run;
  }

  async function checkForChanges() {
    if (checking) {
      dirty = true;
      return;
    }
    checking = true;
    try {
      do {
        dirty = false;
        if (stopped) break;
        const [kids, clientVersion] = await Promise.all([
          publishedKids(pool),
          getClientVersion(pool),
        ]);
        const kidsChanged =
          kids.length !== loadedKids.length || kids.some((kid, i) => kid !== loadedKids[i]);
        const clientsChanged = clientVersion !== loadedClientVersion;
        if (kidsChanged || clientsChanged) {
          await reload();
        }
      } while (dirty && !stopped);
    } catch (err) {
      logger.error({ err: errorFields(err) }, 'provider reload check failed');
    } finally {
      checking = false;
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connecting = connectListener();
    }, 5000);
    reconnectTimer.unref();
  }

  async function connectListener() {
    if (stopped || listenClient || !config.databaseUrl) return;
    const client = new pg.Client({ connectionString: config.databaseUrl });
    listenClient = client;

    client.on('error', (err) => {
      if (!stopped) logger.error({ err: errorFields(err) }, 'client listener error');
      if (listenClient === client) listenClient = null;
      client.end().catch(() => undefined);
      scheduleReconnect();
    });
    client.on('end', () => {
      if (listenClient === client) listenClient = null;
      if (!stopped) scheduleReconnect();
    });
    client.on('notification', (msg) => {
      if (msg.channel === 'tunnus_clients') {
        void checkForChanges();
      }
    });

    try {
      await client.connect();
      if (stopped) {
        if (listenClient === client) listenClient = null;
        await client.end().catch(() => undefined);
        return;
      }
      await client.query('LISTEN tunnus_clients');
      await checkForChanges();
    } catch (err) {
      if (!stopped) logger.error({ err: errorFields(err) }, 'client listener connect failed');
      if (listenClient === client) listenClient = null;
      await client.end().catch(() => undefined);
      scheduleReconnect();
    }
  }

  await reload();

  return {
    /** @returns {import('oidc-provider').Provider} */
    get current() {
      if (!provider) throw new Error('provider not initialised');
      return provider;
    },
    /** @returns {Record<string, any>[]} */
    get clients() {
      return currentClients;
    },
    reload,
    checkForChanges,
    start() {
      stopped = false;
      const seconds = config.keyReloadIntervalSeconds;
      if (seconds > 0 && !timer) {
        timer = setInterval(() => void checkForChanges(), seconds * 1000);
        timer.unref();
      }
      if (!listenClient && !reconnectTimer && !connecting) {
        connecting = connectListener().finally(() => {
          connecting = null;
        });
      }
      return connecting ?? Promise.resolve();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const pendingConnect = connecting;
      const client = listenClient;
      listenClient = null;
      if (client) {
        await client.end().catch(() => undefined);
      }
      if (pendingConnect) {
        await pendingConnect.catch(() => undefined);
      }
      await reloadQueue.catch(() => undefined);
    },
  };
}
