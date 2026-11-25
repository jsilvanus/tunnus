import { timingSafeEqual } from 'node:crypto';
import { decryptWithKey, deriveSubkey } from '../oidc/keys.js';
import { validateClientId } from '../clients/validate.js';

function clientSecretKey(secret) {
  return deriveSubkey(secret, 'client-secret');
}

function secretEquals(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Parses client credentials from Authorization (Basic) or X-Client-Id/Secret headers.
 * @param {import('express').Request} req
 * @returns {{ clientId: string, clientSecret: string } | null}
 */
export function parseClientCredentials(req) {
  const auth = req.headers.authorization;
  if (auth && typeof auth === 'string') {
    const [scheme, val] = auth.trim().split(/\s+/, 2);
    if (scheme.toLowerCase() === 'basic' && val) {
      try {
        const decoded = Buffer.from(val, 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        if (colon > 0) {
          return {
            clientId: decoded.slice(0, colon),
            clientSecret: decoded.slice(colon + 1),
          };
        }
      } catch {
        return null;
      }
    }
  }

  const xClientId = req.headers['x-client-id'];
  const xClientSecret = req.headers['x-client-secret'];
  if (typeof xClientId === 'string' && typeof xClientSecret === 'string') {
    return {
      clientId: xClientId.trim(),
      clientSecret: xClientSecret.trim(),
    };
  }

  return null;
}

/**
 * Authenticates an OIDC client by client_id and client_secret against PostgreSQL oidc_clients.
 * @param {import('pg').Pool} pool
 * @param {string} keyEncryptionSecret
 * @param {string} clientId
 * @param {string} clientSecret
 * @returns {Promise<{ ok: true, client: { clientId: string, metadata: Record<string, any> } } | { ok: false, status: number, error: string, message: string }>}
 */
export async function authenticateOidcClient(pool, keyEncryptionSecret, clientId, clientSecret) {
  if (!clientId || !clientSecret) {
    return { ok: false, status: 401, error: 'invalid_client', message: 'Client credentials required' };
  }

  let cleanClientId;
  try {
    cleanClientId = validateClientId(clientId);
  } catch {
    return { ok: false, status: 401, error: 'invalid_client', message: 'Invalid client_id' };
  }

  const { rows } = await pool.query(
    'SELECT client_id, metadata, secret_enc, disabled FROM oidc_clients WHERE client_id = $1',
    [cleanClientId],
  );

  if (rows.length === 0) {
    return { ok: false, status: 401, error: 'invalid_client', message: 'Client not found' };
  }

  const row = rows[0];
  if (row.disabled) {
    return { ok: false, status: 403, error: 'client_disabled', message: 'Client is disabled' };
  }

  if (!row.secret_enc) {
    return { ok: false, status: 401, error: 'invalid_client', message: 'Client has no secret configured' };
  }

  const key = clientSecretKey(keyEncryptionSecret);
  let decryptedSecret;
  try {
    decryptedSecret = decryptWithKey(row.secret_enc, key);
  } catch {
    return { ok: false, status: 500, error: 'internal_error', message: 'Failed to verify client secret' };
  }

  if (!secretEquals(decryptedSecret, clientSecret)) {
    return { ok: false, status: 401, error: 'invalid_client', message: 'Invalid client credentials' };
  }

  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  if (metadata.allow_discovery_registration === false) {
    return { ok: false, status: 403, error: 'forbidden', message: 'Client is not permitted to self-register services' };
  }

  return { ok: true, client: { clientId: row.client_id, metadata } };
}
