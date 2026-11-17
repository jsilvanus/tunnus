import { createProvider } from './provider.js';
import { loadJwks, publishedKids } from './keys.js';

/**
 * Holds the current oidc-provider instance. oidc-provider reads its keystore once, at
 * construction, so the holder rebuilds the provider when the published key set changes.
 * @param {{
 *   config: import('../config.js').Config,
 *   pool: import('pg').Pool,
 *   clients: Record<string, any>[],
 *   logger?: { error: (obj: unknown, msg?: string) => void },
 * }} deps
 */
export async function createProviderHolder({ config, pool, clients, logger = console }) {
  /** @type {import('oidc-provider').Provider | undefined} */
  let provider;
  /** @type {string[]} */
  let loadedKids = [];
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let checking = false;

  /** Load the key set and build a new provider; the swap happens only when both succeed. */
  async function reload() {
    const jwks = await loadJwks(pool, config.keyEncryptionSecret);
    const next = createProvider({ config, pool, clients, jwks });
    provider = next;
    loadedKids = jwks.keys.map((k) => k.kid);
  }

  async function checkForChanges() {
    if (checking) return;
    checking = true;
    try {
      const kids = await publishedKids(pool);
      if (kids.length !== loadedKids.length || kids.some((kid, i) => kid !== loadedKids[i])) {
        await reload();
      }
    } catch (err) {
      logger.error({ err }, 'signing key reload check failed');
    } finally {
      checking = false;
    }
  }

  await reload();

  return {
    /** @returns {import('oidc-provider').Provider} */
    get current() {
      if (!provider) throw new Error('provider not initialised');
      return provider;
    },
    reload,
    start() {
      const seconds = config.keyReloadIntervalSeconds;
      if (seconds <= 0 || timer) return;
      timer = setInterval(() => void checkForChanges(), seconds * 1000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
