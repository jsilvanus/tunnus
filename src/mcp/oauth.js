import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

/**
 * RFC 9728 Protected Resource Metadata for the MCP endpoint.
 * @param {string} resourceUrl
 * @param {string} authorizationServerUrl
 */
export function protectedResourceMetadata(resourceUrl, authorizationServerUrl) {
  return {
    resource: resourceUrl,
    authorization_servers: [authorizationServerUrl],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
  };
}

/**
 * Build a `WWW-Authenticate` header for an MCP 401 challenge.
 * @param {string} resourceMetadataUrl
 * @param {string} [error]
 */
export function wwwAuthenticate(resourceMetadataUrl, error) {
  const parts = [`Bearer resource_metadata="${resourceMetadataUrl}"`, 'scope="mcp"'];
  if (error) parts.push(`error="${error}"`);
  return parts.join(', ');
}

/**
 * @param {string} segment
 * @returns {any}
 */
function decodeJsonSegment(segment) {
  const text = Buffer.from(segment, 'base64url').toString('utf8');
  return JSON.parse(text);
}

/**
 * Check whether a space-delimited scope claim contains `requiredScope`.
 * @param {unknown} scope
 * @param {string} requiredScope
 */
function hasScope(scope, requiredScope) {
  if (typeof scope !== 'string') return false;
  return scope.split(/\s+/).includes(requiredScope);
}

/**
 * Check whether `aud` matches `expected` (string or string[]).
 * @param {unknown} aud
 * @param {string} expected
 */
function matchesAudience(aud, expected) {
  if (typeof aud === 'string') return aud === expected;
  if (Array.isArray(aud)) return aud.includes(expected);
  return false;
}

/**
 * Verify an RS256 OAuth JWT access token issued by Tunnus for the MCP resource.
 * @param {{
 *   token: string,
 *   issuer: string,
 *   audience: string,
 *   getJwks: (forceRefresh?: boolean) => Promise<{ keys: any[] }>,
 *   now?: () => number,
 * }} opts
 * @returns {Promise<{ ok: true, sub: string, claims: Record<string, any> } | { ok: false, reason: string }>}
 */
export async function verifyMcpJwt({
  token,
  issuer,
  audience,
  getJwks,
  now = () => Math.floor(Date.now() / 1000),
}) {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) return { ok: false, reason: 'malformed' };

  let header;
  let claims;
  try {
    header = decodeJsonSegment(parts[0]);
    claims = decodeJsonSegment(parts[1]);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (!header || typeof header !== 'object' || header.alg !== 'RS256') {
    return { ok: false, reason: 'unsupported_alg' };
  }
  if (!claims || typeof claims !== 'object') return { ok: false, reason: 'malformed' };

  let jwks = await getJwks(false);
  let jwk = findJwk(jwks?.keys, header.kid);
  if (!jwk) {
    jwks = await getJwks(true);
    jwk = findJwk(jwks?.keys, header.kid);
  }
  if (!jwk) return { ok: false, reason: 'unknown_key' };

  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const sig = Buffer.from(parts[2], 'base64url');
    const valid = cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, sig);
    if (!valid) return { ok: false, reason: 'bad_signature' };
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }

  const ts = now();
  if (typeof claims.exp !== 'number' || claims.exp <= ts) {
    return { ok: false, reason: 'expired' };
  }
  if (typeof claims.nbf === 'number' && claims.nbf > ts) {
    return { ok: false, reason: 'not_active' };
  }
  if (claims.iss !== issuer) return { ok: false, reason: 'bad_issuer' };
  if (!matchesAudience(claims.aud, audience)) return { ok: false, reason: 'bad_audience' };
  if (!hasScope(claims.scope, 'mcp')) return { ok: false, reason: 'missing_scope' };
  if (typeof claims.sub !== 'string' || !claims.sub) return { ok: false, reason: 'missing_sub' };

  return { ok: true, sub: claims.sub, claims };
}

/**
 * @param {any[]} keys
 * @param {unknown} kid
 */
function findJwk(keys, kid) {
  if (!Array.isArray(keys)) return undefined;
  if (typeof kid === 'string' && kid) {
    return keys.find((k) => k && k.kid === kid && k.kty === 'RSA');
  }
  return keys.find((k) => k && k.kty === 'RSA');
}

/**
 * Create a caching JWKS-backed JWT verifier for the MCP resource.
 * @param {{
 *   issuer: string,
 *   audience: string,
 *   fetchJwks: () => Promise<{ keys: any[] }>,
 *   cacheMs?: number,
 * }} opts
 */
export function createMcpJwtVerifier({ issuer, audience, fetchJwks, cacheMs = 60_000 }) {
  /** @type {{ keys: any[] } | undefined} */
  let cached;
  let fetchedAt = 0;

  /** @param {boolean} [forceRefresh] */
  async function getJwks(forceRefresh = false) {
    if (!forceRefresh && cached && Date.now() - fetchedAt < cacheMs) return cached;
    cached = await fetchJwks();
    fetchedAt = Date.now();
    return cached;
  }

  return (/** @type {string} */ token) => verifyMcpJwt({ token, issuer, audience, getJwks });
}
