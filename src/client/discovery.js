/**
 * @typedef {Object} ServiceAuthInput
 * @property {'none' | 'api_key' | 'bearer' | 'oidc'} [type]
 * @property {string} [client_id]
 * @property {string[]} [scopes]
 * @property {string} [audience]
 * @property {string} [header_name]
 */

/**
 * @typedef {Object} DiscoveryServiceInput
 * @property {string} id Unique service ID (e.g. 'sissi-signage')
 * @property {string} name Human-readable service name
 * @property {string} type Service type (e.g. 'signage', 'piprogram')
 * @property {string} venue Venue or location (e.g. 'parish-wide', 'keskuskirkko')
 * @property {string} [endpoint_url] Absolute base endpoint URL
 * @property {string} [endpointUrl] Alias for endpoint_url
 * @property {ServiceAuthInput} [auth] Authentication spec
 * @property {string[]} [capabilities] List of capabilities (e.g. ['screen_push', 'export_target'])
 * @property {Record<string, any>} [metadata] Additional metadata (e.g. export_targets)
 * @property {boolean} [disabled] Whether service is marked disabled
 */

/**
 * @typedef {Object} DiscoveryClientOptions
 * @property {string} [tunnusUrl] Base URL of Tunnus (default: 'https://tunnus.riihimaenseurakunta.fi')
 * @property {string} [url] Alias for tunnusUrl
 * @property {string} clientId OIDC client ID
 * @property {string} clientSecret OIDC client secret
 * @property {DiscoveryServiceInput} service Service declaration to register
 * @property {number} [heartbeatIntervalSec] Heartbeat frequency in seconds (default: 60)
 * @property {number} [retryIntervalSec] Initial retry delay on network failure in seconds (default: 10)
 * @property {number} [maxRetryIntervalSec] Maximum retry delay in seconds (default: 60)
 * @property {boolean} [autoDeregisterOnShutdown] Deregister service on SIGTERM/SIGINT (default: true)
 * @property {boolean} [backgroundInitialRegister] Start initial registration in background instead of blocking (default: false)
 * @property {{ error?: Function, warn?: Function, info?: Function, debug?: Function }} [logger]
 * @property {typeof globalThis.fetch} [fetch] Custom fetch implementation
 */

/**
 * Canonical parish service types across Tunnus discovery catalog.
 */
export const SERVICE_TYPES = Object.freeze({
  PI_SYSTEM: 'pi-system',
  MEDIA_RELAY: 'media-relay',
  PIGATEWAY: 'pigateway',
  PIECOSYSTEM: 'piecosystem',
  PIPROGRAM: 'piprogram',
  SIGNAGE: 'signage',
  CANVA: 'canva',
  PICONTROL: 'picontrol',
  MCP: 'mcp',
  ANNO_API: 'anno-api',
});

/**
 * Converts a port number or localhost/127.0.0.1 URL to http://host.docker.internal:<port>,
 * preserving other URLs.
 * @param {string|number} value
 * @returns {string}
 */
export function normalizeLocalPortUrl(value) {
  if (value === null || value === undefined || value === '') {
    return value;
  }
  const str = String(value).trim();
  if (/^\d+$/.test(str)) {
    return `http://host.docker.internal:${str}`;
  }
  if (/^:\d+$/.test(str)) {
    return `http://host.docker.internal${str}`;
  }
  try {
    const url = new URL(str);
    const host = url.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host === '::1'
    ) {
      url.hostname = 'host.docker.internal';
      url.protocol = 'http:';
      let formatted = url.toString();
      if (!str.endsWith('/') && formatted.endsWith('/') && url.pathname === '/') {
        formatted = formatted.slice(0, -1);
      }
      return formatted;
    }
    return str;
  } catch {
    return str;
  }
}

/**
 * Encodes basic authentication header in a cross-environment safe manner.
 * @param {string} user
 * @param {string} pass
 */
function toBasicAuth(user, pass) {
  if (typeof Buffer !== 'undefined') {
    return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  }
  return 'Basic ' + btoa(`${user}:${pass}`);
}

/**
 * Normalizes service payload from snake_case or camelCase.
 * @param {DiscoveryServiceInput} input
 * @param {string} defaultClientId
 */
function normalizeService(input, defaultClientId) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('service object is required');
  }
  if (!input.id) throw new TypeError('service.id is required');
  if (!input.name) throw new TypeError('service.name is required');
  if (!input.type) throw new TypeError('service.type is required');
  if (!input.venue) throw new TypeError('service.venue is required');

  const endpoint_url = input.endpoint_url || input.endpointUrl;
  if (!endpoint_url) {
    throw new TypeError('service.endpoint_url is required');
  }

  const auth = input.auth ? { ...input.auth } : { type: 'none' };
  if (auth.type === 'oidc' && !auth.client_id) {
    auth.client_id = defaultClientId;
  }

  return {
    id: input.id,
    name: input.name,
    type: input.type,
    venue: input.venue,
    endpoint_url,
    auth,
    capabilities: Array.isArray(input.capabilities) ? [...input.capabilities] : [],
    metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : {},
    disabled: Boolean(input.disabled),
  };
}

/**
 * Creates a discovery client controller for managing service registration, heartbeats and discovery.
 * @param {DiscoveryClientOptions} options
 */
export function createDiscoveryClient(options) {
  const tunnusUrl = (options.tunnusUrl || options.url || 'https://tunnus.riihimaenseurakunta.fi').replace(
    /\/+$/,
    '',
  );
  const clientId = options.clientId;
  const clientSecret = options.clientSecret;

  if (!clientId || !clientSecret) {
    throw new TypeError('clientId and clientSecret are required for service self-registration');
  }

  const service = normalizeService(options.service, clientId);
  const heartbeatIntervalMs = Math.max(5, options.heartbeatIntervalSec ?? 60) * 1000;
  const retryIntervalMs = Math.max(1, options.retryIntervalSec ?? 10) * 1000;
  const maxRetryIntervalMs = Math.max(retryIntervalMs, (options.maxRetryIntervalSec ?? 60) * 1000);
  const autoDeregister = options.autoDeregisterOnShutdown ?? true;
  const fetchFn = options.fetch || globalThis.fetch;
  const logger = options.logger || console;

  const authHeader = toBasicAuth(clientId, clientSecret);
  const serviceEndpoint = `${tunnusUrl}/api/v1/discovery/services/${encodeURIComponent(service.id)}`;
  const heartbeatEndpoint = `${serviceEndpoint}/heartbeat`;

  let heartbeatTimer = null;
  let retryTimer = null;
  let running = false;
  let registered = false;
  let lastHeartbeat = null;
  let signalHandlersInstalled = false;

  const state = {
    get isRegistered() {
      return registered;
    },
    get lastHeartbeatAt() {
      return lastHeartbeat;
    },
    get serviceId() {
      return service.id;
    },
  };

  /**
   * Registers or updates the service via PUT.
   */
  async function register() {
    const payload = {
      name: service.name,
      type: service.type,
      venue: service.venue,
      endpoint_url: service.endpoint_url,
      auth: service.auth,
      capabilities: service.capabilities,
      metadata: service.metadata,
      disabled: service.disabled,
    };

    const res = await fetchFn(serviceEndpoint, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let errorJson;
      try {
        errorJson = JSON.parse(errText);
      } catch {
        errorJson = { error: 'http_error', message: errText };
      }
      const err = new Error(
        `Failed to register service '${service.id}' (${res.status}): ${errorJson.message || errText}`,
      );
      err.status = res.status;
      err.code = errorJson.error;
      throw err;
    }

    registered = true;
    lastHeartbeat = new Date();
    return res.json();
  }

  /**
   * Sends heartbeat ping via POST.
   */
  async function heartbeat() {
    const res = await fetchFn(heartbeatEndpoint, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
      },
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const err = new Error(`Heartbeat failed for '${service.id}' (${res.status}): ${errText}`);
      err.status = res.status;
      throw err;
    }

    lastHeartbeat = new Date();
    return res.json();
  }

  /**
   * Deregisters / deletes service via DELETE.
   */
  async function deregister() {
    stopHeartbeat();
    try {
      const res = await fetchFn(serviceEndpoint, {
        method: 'DELETE',
        headers: {
          Authorization: authHeader,
        },
      });
      registered = false;
      return res.status === 204 || res.status === 200 || res.status === 404;
    } catch (err) {
      logger.warn?.(`[discovery] Failed to deregister service '${service.id}': ${err.message}`);
      return false;
    }
  }

  /**
   * Fetches this service's public record.
   */
  async function get() {
    const res = await fetchFn(serviceEndpoint, { method: 'GET' });
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`Failed to get service '${service.id}' (${res.status})`);
    }
    return res.json();
  }

  /**
   * Merges partialMetadata into service.metadata.
   * If andRegister is true (and running), calls register() and returns the response.
   * @param {Record<string, any>} partialMetadata
   * @param {boolean} [andRegister=true]
   */
  async function updateMetadata(partialMetadata, andRegister = true) {
    if (partialMetadata && typeof partialMetadata === 'object') {
      service.metadata = {
        ...(service.metadata || {}),
        ...partialMetadata,
      };
    }
    if (andRegister && running) {
      return await register();
    }
    return service.metadata;
  }

  /**
   * Sets relayed venues metadata for multi-venue routers (e.g. Media Relay).
   * Sets relayed_systems = Object.keys(venuesMap || {}), venues = venuesMap,
   * default_system = defaultVenue (if given), updated_at = new Date().toISOString(),
   * and calls updateMetadata(..., andRegister).
   * @param {Record<string, any>} venuesMap
   * @param {{ defaultVenue?: string, andRegister?: boolean }} [options]
   */
  async function setRelayedVenues(venuesMap, { defaultVenue, andRegister = true } = {}) {
    const meta = {
      relayed_systems: Object.keys(venuesMap || {}),
      venues: venuesMap,
      updated_at: new Date().toISOString(),
    };
    if (defaultVenue !== undefined) {
      meta.default_system = defaultVenue;
    }
    return updateMetadata(meta, andRegister);
  }

  /**
   * Returns a deep copy / snapshot of the internal service definition.
   * @returns {DiscoveryServiceInput}
   */
  function getService() {
    return JSON.parse(JSON.stringify(service));
  }

  function startHeartbeatLoop() {
    stopHeartbeat();
    heartbeatTimer = setInterval(async () => {
      if (!running) return;
      try {
        await heartbeat();
        logger.debug?.(`[discovery] Heartbeat sent for '${service.id}'`);
      } catch (err) {
        logger.warn?.(`[discovery] Heartbeat failed for '${service.id}': ${err.message}`);
        // If 404, the service may have been cleaned up or server restarted; re-register
        if (err.status === 404) {
          scheduleRetry(1000);
        }
      }
    }, heartbeatIntervalMs);
    if (typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref();
    }
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  let currentRetryDelay = retryIntervalMs;

  function scheduleRetry(delayMs = currentRetryDelay) {
    if (!running || retryTimer) return;
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      if (!running) return;
      try {
        await register();
        currentRetryDelay = retryIntervalMs;
        startHeartbeatLoop();
        logger.info?.(`[discovery] Service '${service.id}' successfully registered with Tunnus`);
      } catch (err) {
        // Fatal client authentication errors do not retry endlessly at high frequency
        if (err.status === 401 || err.status === 403) {
          logger.error?.(`[discovery] Fatal authentication error registering '${service.id}': ${err.message}`);
          return;
        }
        currentRetryDelay = Math.min(currentRetryDelay * 1.5, maxRetryIntervalMs);
        logger.warn?.(
          `[discovery] Retrying registration for '${service.id}' in ${Math.round(currentRetryDelay / 1000)}s: ${err.message}`,
        );
        scheduleRetry(currentRetryDelay);
      }
    }, delayMs);
    if (typeof retryTimer.unref === 'function') {
      retryTimer.unref();
    }
  }

  const onShutdownSignal = async () => {
    logger.info?.(`[discovery] Graceful shutdown: deregistering service '${service.id}'...`);
    stop();
    await deregister().catch(() => {});
  };

  function installSignalHandlers() {
    if (
      signalHandlersInstalled ||
      !autoDeregister ||
      typeof process === 'undefined' ||
      typeof process.on !== 'function'
    ) {
      return;
    }
    process.once('SIGTERM', onShutdownSignal);
    process.once('SIGINT', onShutdownSignal);
    signalHandlersInstalled = true;
  }

  function removeSignalHandlers() {
    if (
      !signalHandlersInstalled ||
      typeof process === 'undefined' ||
      typeof process.removeListener !== 'function'
    ) {
      return;
    }
    process.removeListener('SIGTERM', onShutdownSignal);
    process.removeListener('SIGINT', onShutdownSignal);
    signalHandlersInstalled = false;
  }

  /**
   * Starts discovery registration and heartbeat.
   * By default, performs initial registration immediately.
   */
  async function start() {
    running = true;
    installSignalHandlers();

    if (options.backgroundInitialRegister) {
      scheduleRetry(0);
      return state;
    }

    try {
      await register();
      startHeartbeatLoop();
      logger.info?.(`[discovery] Service '${service.id}' registered with Tunnus catalog (${tunnusUrl})`);
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        throw err;
      }
      logger.warn?.(
        `[discovery] Initial registration for '${service.id}' failed, will retry in background: ${err.message}`,
      );
      scheduleRetry(retryIntervalMs);
    }
    return state;
  }

  /**
   * Stops heartbeat and signal handlers without deleting the registration from catalog.
   */
  function stop() {
    running = false;
    stopHeartbeat();
    removeSignalHandlers();
  }

  return {
    state,
    start,
    stop,
    register,
    heartbeat,
    deregister,
    get,
    updateMetadata,
    setRelayedVenues,
    getService,
  };
}

/**
 * Convenience entrypoint: builds client, calls start(), and returns discovery controller.
 * @param {DiscoveryClientOptions} options
 */
export async function startServiceDiscovery(options) {
  const client = createDiscoveryClient(options);
  await client.start();
  return client;
}

/**
 * Helper to fetch the parish discovery catalog.
 * @param {{ tunnusUrl?: string, url?: string, type?: string, venue?: string, capability?: string, fetch?: typeof globalThis.fetch }} [query]
 */
export async function fetchDiscoveryCatalog({
  tunnusUrl = 'https://tunnus.riihimaenseurakunta.fi',
  url,
  type,
  venue,
  capability,
  fetch = globalThis.fetch,
} = {}) {
  const base = (url || tunnusUrl).replace(/\/+$/, '');
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (venue) params.set('venue', venue);
  if (capability) params.set('capability', capability);

  const qs = params.toString();
  const endpoint = `${base}/api/v1/discovery${qs ? `?${qs}` : ''}`;
  const res = await fetch(endpoint);
  if (!res.ok) {
    throw new Error(`Failed to fetch discovery catalog (${res.status})`);
  }
  return res.json();
}
