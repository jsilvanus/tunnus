import { randomBytes } from 'node:crypto';
import Provider, { errors as oidcErrors } from 'oidc-provider';
import { generateKey } from '../oidc/keys.js';

export const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export const ALLOWED_METADATA_KEYS = new Set([
  'redirect_uris',
  'post_logout_redirect_uris',
  'token_endpoint_auth_method',
  'grant_types',
  'response_types',
  'first_party',
  'always_include_groups',
  'allowed_resources',
  'backchannel_logout_uri',
  'backchannel_logout_session_required',
  'id_token_signed_response_alg',
  'client_name',
]);

export const EXTRA_CLIENT_METADATA_PROPERTIES = [
  'first_party',
  'always_include_groups',
  'disabled',
  'allowed_resources',
  'backchannel_logout_uri',
  'backchannel_logout_session_required',
];

export const ALLOWED_AUTH_METHODS = new Set(['client_secret_basic', 'client_secret_post', 'none']);

const URL_ARRAY_KEYS = new Set(['redirect_uris', 'post_logout_redirect_uris']);
const STRING_ARRAY_KEYS = new Set(['grant_types', 'response_types']);
const BOOLEAN_KEYS = new Set([
  'first_party',
  'always_include_groups',
  'backchannel_logout_session_required',
]);

/**
 * Error for client validation, conflict, or lookup failures.
 */
export class ClientError extends Error {
  /**
   * @param {'invalid_request' | 'not_found' | 'client_managed_by_file'} code
   * @param {string} message
   * @param {{ path: string, message: string }[]} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'ClientError';
    this.code = code;
    this.details = details;
  }
}

/**
 * True for a non-null, non-array object.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Absolute URL without whitespace; https required except http://localhost and http://127.0.0.1.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isAllowedUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || /\s/.test(value)) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return Boolean(parsed.hostname);
  if (parsed.protocol === 'http:') {
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  }
  return false;
}

/**
 * Validate a client_id against CLIENT_ID_PATTERN.
 * @param {unknown} clientId
 * @returns {string}
 */
export function validateClientId(clientId) {
  if (typeof clientId !== 'string' || !CLIENT_ID_PATTERN.test(clientId)) {
    throw new ClientError('invalid_request', 'Invalid client_id', [
      { path: '/client_id', message: 'must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' },
    ]);
  }
  return clientId;
}

/**
 * Generate a 32-byte random secret encoded as base64url.
 * @returns {string}
 */
export function generateClientSecret() {
  return randomBytes(32).toString('base64url');
}

/**
 * Validate a caller-supplied client secret: single-line string of at least 32 characters.
 * @param {unknown} secret
 * @returns {string}
 */
export function validateSuppliedSecret(secret) {
  if (typeof secret !== 'string' || /[\r\n]/.test(secret) || secret.length < 32) {
    throw new ClientError(
      'invalid_request',
      'client_secret must be a single line of at least 32 characters',
      [{ path: '/client_secret', message: 'must be a single line of at least 32 characters' }],
    );
  }
  return secret;
}

/**
 * Validate client metadata against the 12 allowlisted keys and Tunnus rules.
 * Rejects any unknown key (including `client_secret` inside metadata).
 * @param {unknown} metadata
 * @param {{ allowNullClear?: boolean }} [options]
 * @returns {Record<string, any>}
 */
export function validateMetadata(metadata, { allowNullClear = false } = {}) {
  if (!isPlainObject(metadata)) {
    throw new ClientError('invalid_request', 'Metadata must be a JSON object', [
      { path: '/', message: 'must be an object' },
    ]);
  }

  /** @type {{ path: string, message: string }[]} */
  const unknownDetails = [];
  for (const key of Object.keys(metadata)) {
    if (!ALLOWED_METADATA_KEYS.has(key)) {
      unknownDetails.push({ path: `/${key}`, message: 'unknown property' });
    }
  }
  if (unknownDetails.length > 0) {
    throw new ClientError(
      'invalid_request',
      `Unknown property: ${unknownDetails.map((d) => d.path.slice(1)).join(', ')}`,
      unknownDetails,
    );
  }

  /** @type {{ path: string, message: string }[]} */
  const details = [];
  /** @type {Record<string, any>} */
  const cleaned = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue;

    if (URL_ARRAY_KEYS.has(key)) {
      if (!Array.isArray(value)) {
        details.push({ path: `/${key}`, message: 'must be an array of URLs' });
        continue;
      }
      if (key === 'redirect_uris' && value.length === 0) {
        details.push({ path: '/redirect_uris', message: 'must contain at least one URI' });
        continue;
      }
      const bad = [];
      for (let i = 0; i < value.length; i++) {
        if (!isAllowedUrl(value[i])) {
          bad.push({
            path: `/${key}/${i}`,
            message: 'must be an https URL (http allowed only for localhost or 127.0.0.1)',
          });
        }
      }
      if (bad.length > 0) {
        details.push(...bad);
      } else {
        cleaned[key] = [...value];
      }
      continue;
    }

    if (key === 'allowed_resources') {
      if (!Array.isArray(value)) {
        details.push({
          path: '/allowed_resources',
          message: 'must be an array of URLs or resource identifiers',
        });
        continue;
      }
      const bad = [];
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        const ok = isAllowedUrl(item) || (typeof item === 'string' && CLIENT_ID_PATTERN.test(item));
        if (!ok) {
          bad.push({
            path: `/allowed_resources/${i}`,
            message:
              'must be an https URL (http allowed only for localhost or 127.0.0.1) or a resource identifier',
          });
        }
      }
      if (bad.length > 0) {
        details.push(...bad);
      } else {
        cleaned[key] = [...value];
      }
      continue;
    }

    if (key === 'backchannel_logout_uri') {
      if (value === null && allowNullClear) {
        cleaned[key] = null;
      } else if (!isAllowedUrl(value)) {
        details.push({
          path: '/backchannel_logout_uri',
          message: 'must be an https URL (http allowed only for localhost or 127.0.0.1)',
        });
      } else {
        cleaned[key] = value;
      }
      continue;
    }

    if (key === 'token_endpoint_auth_method') {
      if (typeof value !== 'string' || !ALLOWED_AUTH_METHODS.has(value)) {
        details.push({
          path: '/token_endpoint_auth_method',
          message: 'must be one of client_secret_basic, client_secret_post, none',
        });
      } else {
        cleaned[key] = value;
      }
      continue;
    }

    if (STRING_ARRAY_KEYS.has(key)) {
      if (
        !Array.isArray(value) ||
        value.some((item) => typeof item !== 'string' || item.length === 0)
      ) {
        details.push({ path: `/${key}`, message: 'must be an array of non-empty strings' });
      } else {
        cleaned[key] = [...value];
      }
      continue;
    }

    if (BOOLEAN_KEYS.has(key)) {
      if (typeof value !== 'boolean') {
        details.push({ path: `/${key}`, message: 'must be a boolean' });
      } else {
        cleaned[key] = value;
      }
      continue;
    }

    if (key === 'id_token_signed_response_alg') {
      if (typeof value !== 'string' || value.trim().length === 0) {
        details.push({
          path: '/id_token_signed_response_alg',
          message: 'must be a non-empty string',
        });
      } else {
        cleaned[key] = value;
      }
      continue;
    }

    if (key === 'client_name') {
      if (value === null && allowNullClear) {
        cleaned[key] = null;
      } else if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
        details.push({
          path: '/client_name',
          message: 'must be a non-empty string up to 200 characters',
        });
      } else {
        cleaned[key] = value.trim();
      }
    }
  }

  if (details.length > 0) {
    throw new ClientError('invalid_request', details[0].message, details);
  }
  return cleaned;
}

/**
 * Normalize a client definition into the shape expected by oidc-provider.
 * Strips null/undefined fields so optional cleared properties do not fail oidc-provider's schema.
 * @param {Record<string, any>} client
 * @returns {import('oidc-provider').ClientMetadata}
 */
export function normalizeClientForProvider(client) {
  const { client_id, always_include_groups, first_party, disabled, ...rest } = client;
  /** @type {Record<string, any>} */
  const cleaned = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined && v !== null) cleaned[k] = v;
  }
  return {
    id_token_signed_response_alg: 'RS256',
    ...cleaned,
    client_id: String(client_id),
    always_include_groups: Boolean(always_include_groups),
    first_party: Boolean(first_party),
    disabled: Boolean(disabled),
  };
}

class DummyAdapter {
  constructor() {}
  async upsert() {}
  async find() {
    return undefined;
  }
  async findByUserCode() {
    return undefined;
  }
  async findByUid() {
    return undefined;
  }
  async destroy() {}
  async revokeByGrantId() {}
  async consume() {}
}

/** @type {Provider | undefined} */
let fallbackProvider;

/**
 * Cached fallback provider for validating client metadata when no live provider is passed.
 * @returns {Provider}
 */
function getFallbackProvider() {
  if (!fallbackProvider) {
    const { priv } = generateKey();
    fallbackProvider = new Provider('https://tunnus.invalid', {
      adapter: DummyAdapter,
      jwks: { keys: [priv] },
      cookies: { keys: ['tunnus-client-validation-cookie-key'] },
      extraClientMetadata: { properties: EXTRA_CLIENT_METADATA_PROPERTIES },
      features: {
        devInteractions: { enabled: false },
        backchannelLogout: { enabled: true },
        rpInitiatedLogout: { enabled: true },
      },
      pkce: { required: () => true },
    });
  }
  return fallbackProvider;
}

/**
 * Validate a candidate client object against oidc-provider's Client schema.
 * @param {Record<string, any>} clientObj
 * @param {Provider} [provider]
 */
export async function validateWithOidcProvider(clientObj, provider) {
  const targetProvider = provider ?? getFallbackProvider();
  try {
    await targetProvider.Client.validate(
      /** @type {import('oidc-provider').ClientMetadata} */ (normalizeClientForProvider(clientObj)),
    );
  } catch (err) {
    if (err instanceof oidcErrors.InvalidClientMetadata) {
      const message = err.error_description || err.message || 'Invalid client metadata';
      const firstWord = message.split(/[\s:]/)[0];
      const path = ALLOWED_METADATA_KEYS.has(firstWord) ? `/${firstWord}` : '/';
      throw new ClientError('invalid_request', message, [{ path, message }]);
    }
    throw err;
  }
}
