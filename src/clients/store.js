import { timingSafeEqual } from 'node:crypto';
import { audit } from '../audit.js';
import { errorFields, logger as defaultLogger } from '../logger.js';
import { decryptWithKey, deriveSubkey, encryptWithKey } from '../oidc/keys.js';
import {
  ALLOWED_METADATA_KEYS,
  CLIENT_ID_PATTERN,
  ClientError,
  generateClientSecret,
  validateClientId,
  validateMetadata,
  validateSuppliedSecret,
  validateWithOidcProvider,
} from './validate.js';

export { ClientError };

/** Advisory lock key for serializing all writes to oidc_clients and oidc_client_state. */
export const CLIENT_LOCK = 7300301;

const CLIENT_COLUMNS =
  'client_id, metadata, secret_set_at, source, disabled, created_at, updated_at';

/**
 * Derive the 32-byte encryption key for OIDC client secrets from KEY_ENCRYPTION_SECRET.
 * @param {string} secret
 * @returns {Buffer}
 */
function clientSecretKey(secret) {
  return deriveSubkey(secret, 'client-secret');
}

/**
 * Constant-time UTF-8 string comparison for secrets.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function secretEquals(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Deep equality for JSON-serializable values (key-order independent for plain objects).
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function jsonEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    if (Array.isArray(b)) return false;
    const objA = /** @type {Record<string, unknown>} */ (a);
    const objB = /** @type {Record<string, unknown>} */ (b);
    const keysA = Object.keys(objA).filter((k) => objA[k] !== undefined);
    const keysB = Object.keys(objB).filter((k) => objB[k] !== undefined);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k) => Object.hasOwn(objB, k) && jsonEqual(objA[k], objB[k]));
  }
  return false;
}

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function iso(v) {
  return v ? new Date(/** @type {string | Date} */ (v)).toISOString() : null;
}

/**
 * Format a row or store record into the public API Client JSON shape (never includes secrets).
 * @param {Record<string, any>} row
 */
export function clientJson(row) {
  const m = row.metadata ?? row;
  return {
    client_id: String(row.client_id),
    redirect_uris: [...(m.redirect_uris ?? [])],
    post_logout_redirect_uris: [...(m.post_logout_redirect_uris ?? [])],
    token_endpoint_auth_method: m.token_endpoint_auth_method ?? 'client_secret_basic',
    grant_types: [...(m.grant_types ?? ['authorization_code'])],
    response_types: [...(m.response_types ?? ['code'])],
    first_party: Boolean(m.first_party),
    always_include_groups: Boolean(m.always_include_groups),
    allowed_resources: [...(m.allowed_resources ?? [])],
    backchannel_logout_uri: m.backchannel_logout_uri ?? null,
    backchannel_logout_session_required:
      m.backchannel_logout_session_required === undefined
        ? null
        : Boolean(m.backchannel_logout_session_required),
    id_token_signed_response_alg: m.id_token_signed_response_alg ?? 'RS256',
    client_name: m.client_name ?? null,
    source: /** @type {'file' | 'api'} */ (row.source ?? 'api'),
    disabled: Boolean(row.disabled),
    secret_set_at: iso(row.secret_set_at),
    created_at: iso(row.created_at) ?? new Date(0).toISOString(),
    updated_at: iso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

/**
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
function toRecord(row) {
  return {
    client_id: row.client_id,
    metadata: row.metadata ?? {},
    source: row.source,
    disabled: Boolean(row.disabled),
    secret_set_at: row.secret_set_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Run `fn` inside a transaction holding the client write advisory lock.
 * @template T
 * @param {import('pg').Pool} pool
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withClientTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [CLIENT_LOCK]);
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
 * Increment oidc_client_state.version and emit NOTIFY tunnus_clients in the active transaction.
 * @param {import('pg').PoolClient} client
 * @returns {Promise<string>}
 */
async function bumpClientVersion(client) {
  const { rows } = await client.query(
    `INSERT INTO oidc_client_state (id, version) VALUES (1, 1)
     ON CONFLICT (id) DO UPDATE SET version = oidc_client_state.version + 1
     RETURNING version`,
  );
  const version = String(rows[0].version);
  await client.query("SELECT pg_notify('tunnus_clients', $1)", [version]);
  return version;
}

/**
 * Delete all oidc_payloads (grants, tokens, codes) belonging to `clientId`.
 * @param {import('pg').PoolClient} client
 * @param {string} clientId
 * @returns {Promise<number>}
 */
async function deleteClientPayloads(client, clientId) {
  const res = await client.query(
    `DELETE FROM oidc_payloads
      WHERE payload->>'clientId' = $1
         OR grant_id IN (
              SELECT id FROM oidc_payloads
               WHERE type = 'Grant' AND payload->>'clientId' = $1
            )`,
    [clientId],
  );
  return res.rowCount ?? 0;
}

/**
 * Compute changed metadata field names between two metadata objects.
 * @param {Record<string, any>} before
 * @param {Record<string, any>} after
 * @returns {string[]}
 */
function changedMetadataFields(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  /** @type {string[]} */
  const changed = [];
  for (const k of keys) {
    if (!jsonEqual(before[k], after[k])) changed.push(k);
  }
  return changed.sort();
}

/**
 * Read the current client state version counter.
 * @param {import('pg').Pool} pool
 * @returns {Promise<string>}
 */
export async function getClientVersion(pool) {
  const { rows } = await pool.query('SELECT version FROM oidc_client_state WHERE id = 1');
  return rows[0] ? String(rows[0].version) : '0';
}

/**
 * List all client records (without decrypting secrets) for the admin API and CLI list.
 * @param {import('pg').Pool} pool
 */
export async function listClientRecords(pool) {
  const { rows } = await pool.query(
    `SELECT ${CLIENT_COLUMNS} FROM oidc_clients ORDER BY client_id`,
  );
  return rows.map(toRecord);
}

/**
 * Fetch one client record (without decrypting its secret), or null if not found.
 * @param {import('pg').Pool} pool
 * @param {string} clientId
 */
export async function getClient(pool, clientId) {
  validateClientId(clientId);
  const { rows } = await pool.query(
    `SELECT ${CLIENT_COLUMNS} FROM oidc_clients WHERE client_id = $1`,
    [clientId],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/**
 * Load all enabled clients and decrypt their secrets for oidc-provider.
 * Rows that fail decryption are logged (`client.invalid`), reported via `onInvalid`, and skipped.
 * @param {import('pg').Pool} pool
 * @param {string} keyEncryptionSecret
 * @param {{
 *   logger?: { error: (obj: unknown, msg?: string) => void },
 *   onInvalid?: (clientId: string, err: unknown) => void,
 * }} [options]
 * @returns {Promise<Record<string, any>[]>}
 */
export async function listClients(
  pool,
  keyEncryptionSecret,
  { logger = defaultLogger, onInvalid } = {},
) {
  const key = clientSecretKey(keyEncryptionSecret);
  const { rows } = await pool.query(
    'SELECT client_id, metadata, secret_enc FROM oidc_clients WHERE NOT disabled ORDER BY client_id',
  );
  /** @type {Record<string, any>[]} */
  const out = [];
  for (const row of rows) {
    /** @type {string | undefined} */
    let clientSecret;
    if (row.secret_enc !== null && row.secret_enc !== undefined) {
      try {
        clientSecret = decryptWithKey(row.secret_enc, key);
      } catch (err) {
        logger.error({ clientId: row.client_id, err: errorFields(err) }, 'client.invalid');
        onInvalid?.(row.client_id, err);
        continue;
      }
    }
    out.push({
      ...(row.metadata ?? {}),
      client_id: row.client_id,
      ...(clientSecret !== undefined ? { client_secret: clientSecret } : {}),
      disabled: false,
    });
  }
  return out;
}

/**
 * Create or replace an API-managed client. Idempotent when inputs match the stored client.
 * @param {import('pg').Pool} pool
 * @param {string} keyEncryptionSecret
 * @param {{
 *   clientId: string,
 *   metadata: Record<string, any>,
 *   clientSecret?: string,
 *   generateSecret?: boolean,
 *   disabled?: boolean,
 *   actorUserId?: string | null,
 *   via?: string,
 *   ip?: string | null,
 *   provider?: import('oidc-provider').Provider,
 * }} opts
 * @returns {Promise<{ created: boolean, changed: boolean, record: Record<string, any>, generatedSecret?: string }>}
 */
export async function putClient(
  pool,
  keyEncryptionSecret,
  {
    clientId,
    metadata,
    clientSecret,
    generateSecret = false,
    disabled = false,
    actorUserId = null,
    via,
    ip = null,
    provider,
  },
) {
  validateClientId(clientId);
  if (clientSecret !== undefined && generateSecret) {
    throw new ClientError(
      'invalid_request',
      'Cannot provide both client_secret and generateSecret',
      [{ path: '/client_secret', message: 'mutually exclusive with generateSecret' }],
    );
  }
  const cleanMeta = validateMetadata(metadata, { allowNullClear: false });
  const authMethod = cleanMeta.token_endpoint_auth_method ?? 'client_secret_basic';
  const isPublic = authMethod === 'none';

  if (isPublic) {
    if (clientSecret !== undefined || generateSecret) {
      throw new ClientError('invalid_request', 'Public clients must not have a client_secret', [
        { path: '/client_secret', message: 'not allowed when token_endpoint_auth_method is none' },
      ]);
    }
  } else if (clientSecret !== undefined) {
    validateSuppliedSecret(clientSecret);
  }

  const key = clientSecretKey(keyEncryptionSecret);

  return withClientTx(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT ${CLIENT_COLUMNS}, secret_enc
         FROM oidc_clients
        WHERE client_id = $1
        FOR UPDATE`,
      [clientId],
    );
    const existing = rows[0];
    if (existing?.source === 'file') {
      throw new ClientError(
        'client_managed_by_file',
        `Client "${clientId}" is managed by CLIENTS_FILE; adopt it before modifying`,
      );
    }

    if (!existing) {
      /** @type {string | undefined} */
      let plainSecret;
      /** @type {string | undefined} */
      let generatedSecret;
      /** @type {string | null} */
      let secretEnc = null;
      /** @type {Date | null} */
      let secretSetAt = null;

      if (!isPublic) {
        if (clientSecret !== undefined) {
          plainSecret = clientSecret;
        } else {
          plainSecret = generateClientSecret();
          generatedSecret = plainSecret;
        }
        secretEnc = encryptWithKey(plainSecret, key);
        secretSetAt = new Date();
      }

      await validateWithOidcProvider(
        {
          client_id: clientId,
          ...cleanMeta,
          ...(plainSecret !== undefined ? { client_secret: plainSecret } : {}),
          disabled: Boolean(disabled),
        },
        provider,
      );

      const { rows: inserted } = await client.query(
        `INSERT INTO oidc_clients
           (client_id, metadata, secret_enc, secret_set_at, source, disabled, created_by, updated_by)
         VALUES ($1, $2, $3, $4, 'api', $5, $6, $6)
         RETURNING ${CLIENT_COLUMNS}`,
        [clientId, cleanMeta, secretEnc, secretSetAt, Boolean(disabled), actorUserId],
      );
      await bumpClientVersion(client);
      await audit(client, {
        actorUserId,
        action: 'client.created',
        targetType: 'client',
        targetId: clientId,
        ip,
        details: {
          source: 'api',
          disabled: Boolean(disabled),
          fields: Object.keys(cleanMeta).sort(),
          ...(via ? { via } : {}),
        },
      });
      return {
        created: true,
        changed: true,
        record: toRecord(inserted[0]),
        ...(generatedSecret !== undefined ? { generatedSecret } : {}),
      };
    }

    /** @type {string | undefined} */
    let plainSecret;
    /** @type {string | undefined} */
    let generatedSecret;
    /** @type {string | null} */
    let nextSecretEnc = existing.secret_enc;
    /** @type {Date | null} */
    let nextSecretSetAt = existing.secret_set_at;
    let secretChanged = false;

    if (isPublic) {
      plainSecret = undefined;
      nextSecretEnc = null;
      nextSecretSetAt = null;
      secretChanged = existing.secret_enc !== null;
    } else if (clientSecret !== undefined) {
      let currentSecret;
      if (existing.secret_enc) {
        try {
          currentSecret = decryptWithKey(existing.secret_enc, key);
        } catch {
          currentSecret = undefined;
        }
      }
      if (currentSecret !== undefined && secretEquals(currentSecret, clientSecret)) {
        plainSecret = currentSecret;
      } else {
        plainSecret = clientSecret;
        nextSecretEnc = encryptWithKey(clientSecret, key);
        nextSecretSetAt = new Date();
        secretChanged = true;
      }
    } else if (generateSecret) {
      plainSecret = generateClientSecret();
      generatedSecret = plainSecret;
      nextSecretEnc = encryptWithKey(plainSecret, key);
      nextSecretSetAt = new Date();
      secretChanged = true;
    } else {
      if (existing.secret_enc === null || existing.secret_enc === undefined) {
        throw new ClientError(
          'invalid_request',
          'client_secret is required when changing a public client to confidential',
          [{ path: '/client_secret', message: 'required for confidential client' }],
        );
      }
      plainSecret = decryptWithKey(existing.secret_enc, key);
    }

    await validateWithOidcProvider(
      {
        client_id: clientId,
        ...cleanMeta,
        ...(plainSecret !== undefined ? { client_secret: plainSecret } : {}),
        disabled: Boolean(disabled),
      },
      provider,
    );

    const existingMeta = existing.metadata ?? {};
    const metadataChanged = !jsonEqual(existingMeta, cleanMeta);
    const disabledChanged = Boolean(existing.disabled) !== Boolean(disabled);

    if (!metadataChanged && !secretChanged && !disabledChanged) {
      return { created: false, changed: false, record: toRecord(existing) };
    }

    const { rows: updated } = await client.query(
      `UPDATE oidc_clients
          SET metadata = $2,
              secret_enc = $3,
              secret_set_at = $4,
              disabled = $5,
              updated_at = now(),
              updated_by = $6
        WHERE client_id = $1
        RETURNING ${CLIENT_COLUMNS}`,
      [clientId, cleanMeta, nextSecretEnc, nextSecretSetAt, Boolean(disabled), actorUserId],
    );
    await bumpClientVersion(client);

    const fields = changedMetadataFields(existingMeta, cleanMeta);
    if (secretChanged) fields.push('client_secret');
    if (disabledChanged) fields.push('disabled');
    fields.sort();

    const redirectChanged = !jsonEqual(existingMeta.redirect_uris, cleanMeta.redirect_uris);
    const redirectDetails = redirectChanged
      ? {
          redirect_uris: {
            old: existingMeta.redirect_uris ?? [],
            new: cleanMeta.redirect_uris ?? [],
          },
        }
      : {};

    if (disabledChanged && Boolean(disabled)) {
      await audit(client, {
        actorUserId,
        action: 'client.disabled',
        targetType: 'client',
        targetId: clientId,
        ip,
        details: {
          fields,
          ...redirectDetails,
          disabled: true,
          ...(via ? { via } : {}),
        },
      });
    }
    if (metadataChanged || secretChanged || (disabledChanged && !disabled)) {
      await audit(client, {
        actorUserId,
        action: 'client.updated',
        targetType: 'client',
        targetId: clientId,
        ip,
        details: {
          fields,
          ...redirectDetails,
          ...(disabledChanged ? { disabled: Boolean(disabled) } : {}),
          ...(via ? { via } : {}),
        },
      });
    }

    return {
      created: false,
      changed: true,
      record: toRecord(updated[0]),
      ...(generatedSecret !== undefined ? { generatedSecret } : {}),
    };
  });
}

/**
 * Partially update an API-managed client's metadata and/or `disabled` flag.
 * Rejects `client_secret` and supports clearing `backchannel_logout_uri` / `client_name` with `null`.
 * @param {import('pg').Pool} pool
 * @param {string} keyEncryptionSecret
 * @param {{
 *   clientId: string,
 *   patch: Record<string, any>,
 *   actorUserId?: string | null,
 *   via?: string,
 *   ip?: string | null,
 *   provider?: import('oidc-provider').Provider,
 * }} opts
 * @returns {Promise<{ changed: boolean, record: Record<string, any> }>}
 */
export async function patchClient(
  pool,
  keyEncryptionSecret,
  { clientId, patch, actorUserId = null, via, ip = null, provider },
) {
  validateClientId(clientId);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ClientError('invalid_request', 'Patch body must be a JSON object', [
      { path: '/', message: 'must be an object' },
    ]);
  }
  if (Object.hasOwn(patch, 'client_secret')) {
    throw new ClientError('invalid_request', 'client_secret cannot be changed via PATCH', [
      { path: '/client_secret', message: 'unknown property' },
    ]);
  }
  if (Object.keys(patch).length === 0) {
    throw new ClientError('invalid_request', 'At least one property is required', [
      { path: '/', message: 'must not be empty' },
    ]);
  }

  const { disabled: rawDisabled, ...rawMetaPatch } = patch;
  if (rawDisabled !== undefined && typeof rawDisabled !== 'boolean') {
    throw new ClientError('invalid_request', 'disabled must be a boolean', [
      { path: '/disabled', message: 'must be a boolean' },
    ]);
  }
  const cleanPatch = validateMetadata(rawMetaPatch, { allowNullClear: true });
  const key = clientSecretKey(keyEncryptionSecret);

  return withClientTx(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT ${CLIENT_COLUMNS}, secret_enc
         FROM oidc_clients
        WHERE client_id = $1
        FOR UPDATE`,
      [clientId],
    );
    const existing = rows[0];
    if (!existing) {
      throw new ClientError('not_found', `Client "${clientId}" not found`);
    }
    if (existing.source === 'file') {
      throw new ClientError(
        'client_managed_by_file',
        `Client "${clientId}" is managed by CLIENTS_FILE; adopt it before modifying`,
      );
    }

    const existingMeta = existing.metadata ?? {};
    /** @type {Record<string, any>} */
    const mergedMeta = { ...existingMeta };
    for (const [k, v] of Object.entries(cleanPatch)) {
      if (v === null) {
        delete mergedMeta[k];
      } else if (v !== undefined) {
        mergedMeta[k] = v;
      }
    }

    const nextDisabled = rawDisabled !== undefined ? rawDisabled : Boolean(existing.disabled);
    const nextAuthMethod = mergedMeta.token_endpoint_auth_method ?? 'client_secret_basic';
    const isPublic = nextAuthMethod === 'none';

    /** @type {string | undefined} */
    let plainSecret;
    /** @type {string | null} */
    let nextSecretEnc = existing.secret_enc;
    /** @type {Date | null} */
    let nextSecretSetAt = existing.secret_set_at;

    if (isPublic) {
      plainSecret = undefined;
      nextSecretEnc = null;
      nextSecretSetAt = null;
    } else {
      if (existing.secret_enc === null || existing.secret_enc === undefined) {
        throw new ClientError(
          'invalid_request',
          'Cannot change a public client to confidential without setting client_secret via PUT',
          [
            {
              path: '/token_endpoint_auth_method',
              message: 'confidential client requires a secret',
            },
          ],
        );
      }
      plainSecret = decryptWithKey(existing.secret_enc, key);
    }

    await validateWithOidcProvider(
      {
        client_id: clientId,
        ...mergedMeta,
        ...(plainSecret !== undefined ? { client_secret: plainSecret } : {}),
        disabled: nextDisabled,
      },
      provider,
    );

    const metadataChanged = !jsonEqual(existingMeta, mergedMeta);
    const disabledChanged = Boolean(existing.disabled) !== nextDisabled;
    if (!metadataChanged && !disabledChanged) {
      return { changed: false, record: toRecord(existing) };
    }

    const { rows: updated } = await client.query(
      `UPDATE oidc_clients
          SET metadata = $2,
              secret_enc = $3,
              secret_set_at = $4,
              disabled = $5,
              updated_at = now(),
              updated_by = $6
        WHERE client_id = $1
        RETURNING ${CLIENT_COLUMNS}`,
      [clientId, mergedMeta, nextSecretEnc, nextSecretSetAt, nextDisabled, actorUserId],
    );
    await bumpClientVersion(client);

    const fields = changedMetadataFields(existingMeta, mergedMeta);
    if (disabledChanged) fields.push('disabled');
    fields.sort();

    const redirectChanged = !jsonEqual(existingMeta.redirect_uris, mergedMeta.redirect_uris);
    const redirectDetails = redirectChanged
      ? {
          redirect_uris: {
            old: existingMeta.redirect_uris ?? [],
            new: mergedMeta.redirect_uris ?? [],
          },
        }
      : {};

    if (disabledChanged && nextDisabled) {
      await audit(client, {
        actorUserId,
        action: 'client.disabled',
        targetType: 'client',
        targetId: clientId,
        ip,
        details: {
          fields,
          ...redirectDetails,
          disabled: true,
          ...(via ? { via } : {}),
        },
      });
    }
    if (metadataChanged || (disabledChanged && !nextDisabled)) {
      await audit(client, {
        actorUserId,
        action: 'client.updated',
        targetType: 'client',
        targetId: clientId,
        ip,
        details: {
          fields,
          ...redirectDetails,
          ...(disabledChanged ? { disabled: nextDisabled } : {}),
          ...(via ? { via } : {}),
        },
      });
    }

    return { changed: true, record: toRecord(updated[0]) };
  });
}

/**
 * Rotate a confidential client's secret (to the supplied value or a newly generated 32-byte secret).
 * Optionally revokes all existing tokens and grants for the client.
 * @param {import('pg').Pool} pool
 * @param {string} keyEncryptionSecret
 * @param {{
 *   clientId: string,
 *   clientSecret?: string,
 *   revokeTokens?: boolean,
 *   actorUserId?: string | null,
 *   via?: string,
 *   ip?: string | null,
 * }} opts
 * @returns {Promise<{ record: Record<string, any>, generatedSecret?: string, revoked: number }>}
 */
export async function rotateSecret(
  pool,
  keyEncryptionSecret,
  { clientId, clientSecret, revokeTokens = false, actorUserId = null, via, ip = null },
) {
  validateClientId(clientId);
  if (clientSecret !== undefined) {
    validateSuppliedSecret(clientSecret);
  }
  const key = clientSecretKey(keyEncryptionSecret);

  return withClientTx(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT ${CLIENT_COLUMNS}
         FROM oidc_clients
        WHERE client_id = $1
        FOR UPDATE`,
      [clientId],
    );
    const existing = rows[0];
    if (!existing) {
      throw new ClientError('not_found', `Client "${clientId}" not found`);
    }
    if (existing.source === 'file') {
      throw new ClientError(
        'client_managed_by_file',
        `Client "${clientId}" is managed by CLIENTS_FILE; adopt it before rotating secret`,
      );
    }
    const authMethod = existing.metadata?.token_endpoint_auth_method ?? 'client_secret_basic';
    if (authMethod === 'none') {
      throw new ClientError('invalid_request', 'Public clients do not have a client_secret', [
        { path: '/client_id', message: 'token_endpoint_auth_method is none' },
      ]);
    }

    const generated = clientSecret === undefined;
    const nextSecret = generated ? generateClientSecret() : clientSecret;
    const secretEnc = encryptWithKey(nextSecret, key);

    const { rows: updated } = await client.query(
      `UPDATE oidc_clients
          SET secret_enc = $2,
              secret_set_at = now(),
              updated_at = now(),
              updated_by = $3
        WHERE client_id = $1
        RETURNING ${CLIENT_COLUMNS}`,
      [clientId, secretEnc, actorUserId],
    );

    const revoked = revokeTokens ? await deleteClientPayloads(client, clientId) : 0;
    await bumpClientVersion(client);
    await audit(client, {
      actorUserId,
      action: 'client.secret_rotated',
      targetType: 'client',
      targetId: clientId,
      ip,
      details: {
        revoke_tokens: Boolean(revokeTokens),
        revoked_count: revoked,
        ...(via ? { via } : {}),
      },
    });

    return {
      record: toRecord(updated[0]),
      ...(generated ? { generatedSecret: nextSecret } : {}),
      revoked,
    };
  });
}

/**
 * Flip a file-seeded client (`source = 'file'`) to API-managed (`source = 'api'`).
 * Idempotent if the client is already `source = 'api'`.
 * @param {import('pg').Pool} pool
 * @param {{
 *   clientId: string,
 *   actorUserId?: string | null,
 *   via?: string,
 *   ip?: string | null,
 * }} opts
 * @returns {Promise<{ record: Record<string, any>, adopted: boolean }>}
 */
export async function adoptClient(pool, { clientId, actorUserId = null, via, ip = null }) {
  validateClientId(clientId);
  return withClientTx(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT ${CLIENT_COLUMNS}
         FROM oidc_clients
        WHERE client_id = $1
        FOR UPDATE`,
      [clientId],
    );
    const existing = rows[0];
    if (!existing) {
      throw new ClientError('not_found', `Client "${clientId}" not found`);
    }
    if (existing.source === 'api') {
      return { record: toRecord(existing), adopted: false };
    }

    const { rows: updated } = await client.query(
      `UPDATE oidc_clients
          SET source = 'api',
              updated_at = now(),
              updated_by = $2
        WHERE client_id = $1
        RETURNING ${CLIENT_COLUMNS}`,
      [clientId, actorUserId],
    );
    await bumpClientVersion(client);
    await audit(client, {
      actorUserId,
      action: 'client.adopted',
      targetType: 'client',
      targetId: clientId,
      ip,
      details: {
        previous_source: 'file',
        ...(via ? { via } : {}),
      },
    });
    return { record: toRecord(updated[0]), adopted: true };
  });
}

/**
 * Delete an API-managed client and revoke all of its grants, tokens, and codes.
 * @param {import('pg').Pool} pool
 * @param {{
 *   clientId: string,
 *   actorUserId?: string | null,
 *   via?: string,
 *   ip?: string | null,
 * }} opts
 * @returns {Promise<{ deleted: true, revoked: number }>}
 */
export async function deleteClient(pool, { clientId, actorUserId = null, via, ip = null }) {
  validateClientId(clientId);
  return withClientTx(pool, async (client) => {
    const { rows } = await client.query(
      'SELECT source FROM oidc_clients WHERE client_id = $1 FOR UPDATE',
      [clientId],
    );
    const existing = rows[0];
    if (!existing) {
      throw new ClientError('not_found', `Client "${clientId}" not found`);
    }
    if (existing.source === 'file') {
      throw new ClientError(
        'client_managed_by_file',
        `Client "${clientId}" is managed by CLIENTS_FILE; adopt it before deleting`,
      );
    }

    const revoked = await deleteClientPayloads(client, clientId);
    await client.query('DELETE FROM oidc_clients WHERE client_id = $1', [clientId]);
    await bumpClientVersion(client);
    await audit(client, {
      actorUserId,
      action: 'client.deleted',
      targetType: 'client',
      targetId: clientId,
      ip,
      details: {
        revoked_count: revoked,
        ...(via ? { via } : {}),
      },
    });
    return { deleted: true, revoked };
  });
}

/**
 * Sync clients loaded from `CLIENTS_FILE` into `oidc_clients` at startup.
 * Preserves backward compatibility for shorter file secrets and fallback-disabled entries.
 * - New clients are inserted with `source = 'file'`.
 * - Existing `source = 'file'` rows are overwritten when changed.
 * - Existing `source = 'api'` rows are skipped with a warning (database wins).
 * - `source = 'file'` rows missing from `fileClients` are disabled with a warning, not deleted.
 * @param {import('pg').Pool} pool
 * @param {Record<string, any>[]} fileClients
 * @param {string} keyEncryptionSecret
 * @param {{ warn: (obj: unknown, msg?: string) => void }} [logger]
 * @returns {Promise<{ synced: number, disabled: number, skippedApi: number }>}
 */
export async function syncFromFile(pool, fileClients, keyEncryptionSecret, logger = defaultLogger) {
  const key = clientSecretKey(keyEncryptionSecret);
  /** @type {Set<string>} */
  const seenIds = new Set();
  /** @type {{ clientId: string, metadata: Record<string, any>, secret: string | undefined, disabled: boolean }[]} */
  const parsed = [];

  for (const raw of fileClients) {
    const clientId = String(raw?.client_id ?? '');
    if (!CLIENT_ID_PATTERN.test(clientId)) {
      throw new Error(`Invalid client_id in CLIENTS_FILE: ${clientId}`);
    }
    if (seenIds.has(clientId)) {
      throw new Error(`Duplicate client_id in CLIENTS_FILE: ${clientId}`);
    }
    seenIds.add(clientId);

    /** @type {Record<string, any>} */
    const metadata = {};
    for (const prop of ALLOWED_METADATA_KEYS) {
      if (raw[prop] !== undefined && raw[prop] !== null) {
        metadata[prop] = raw[prop];
      }
    }
    const secret =
      raw.client_secret !== undefined && raw.client_secret !== null
        ? String(raw.client_secret)
        : undefined;
    parsed.push({
      clientId,
      metadata,
      secret,
      disabled: Boolean(raw.disabled),
    });
  }

  return withClientTx(pool, async (client) => {
    const { rows: existingRows } = await client.query(
      'SELECT client_id, metadata, secret_enc, secret_set_at, source, disabled FROM oidc_clients FOR UPDATE',
    );
    const byId = new Map(existingRows.map((r) => [r.client_id, r]));
    let synced = 0;
    let disabledCount = 0;
    let skippedApi = 0;
    let changed = false;

    for (const entry of parsed) {
      const existing = byId.get(entry.clientId);
      if (!existing) {
        const secretEnc = entry.secret !== undefined ? encryptWithKey(entry.secret, key) : null;
        const secretSetAt =
          entry.secret !== undefined && entry.secret.length > 0 ? new Date() : null;
        await client.query(
          `INSERT INTO oidc_clients
             (client_id, metadata, secret_enc, secret_set_at, source, disabled)
           VALUES ($1, $2, $3, $4, 'file', $5)`,
          [entry.clientId, entry.metadata, secretEnc, secretSetAt, entry.disabled],
        );
        await audit(client, {
          actorUserId: null,
          action: 'client.synced_from_file',
          targetType: 'client',
          targetId: entry.clientId,
          details: { action: 'created', disabled: entry.disabled },
        });
        synced++;
        changed = true;
        continue;
      }

      if (existing.source === 'api') {
        logger.warn(
          { clientId: entry.clientId },
          'client in CLIENTS_FILE is managed in database (source=api); skipping file entry',
        );
        skippedApi++;
        continue;
      }

      let existingSecret;
      let decryptFailed = false;
      if (existing.secret_enc !== null && existing.secret_enc !== undefined) {
        try {
          existingSecret = decryptWithKey(existing.secret_enc, key);
        } catch {
          decryptFailed = true;
        }
      }

      const secretSame =
        !decryptFailed &&
        ((entry.secret === undefined && existingSecret === undefined) ||
          (entry.secret !== undefined &&
            existingSecret !== undefined &&
            secretEquals(existingSecret, entry.secret)));
      const metaSame = jsonEqual(existing.metadata ?? {}, entry.metadata);
      const disabledSame = Boolean(existing.disabled) === entry.disabled;

      if (metaSame && disabledSame && secretSame) {
        continue;
      }

      const nextSecretEnc =
        entry.secret === undefined
          ? null
          : secretSame
            ? existing.secret_enc
            : encryptWithKey(entry.secret, key);
      const nextSecretSetAt =
        entry.secret === undefined || entry.secret.length === 0
          ? null
          : secretSame
            ? existing.secret_set_at
            : new Date();

      await client.query(
        `UPDATE oidc_clients
            SET metadata = $2,
                secret_enc = $3,
                secret_set_at = $4,
                disabled = $5,
                updated_at = now(),
                updated_by = NULL
          WHERE client_id = $1`,
        [entry.clientId, entry.metadata, nextSecretEnc, nextSecretSetAt, entry.disabled],
      );
      await audit(client, {
        actorUserId: null,
        action: 'client.synced_from_file',
        targetType: 'client',
        targetId: entry.clientId,
        details: { action: 'updated', disabled: entry.disabled },
      });
      synced++;
      changed = true;
    }

    for (const existing of existingRows) {
      if (existing.source !== 'file' || seenIds.has(existing.client_id) || existing.disabled) {
        continue;
      }
      await client.query(
        'UPDATE oidc_clients SET disabled = true, updated_at = now(), updated_by = NULL WHERE client_id = $1',
        [existing.client_id],
      );
      logger.warn(
        { clientId: existing.client_id },
        'client removed from CLIENTS_FILE; disabled in database',
      );
      await audit(client, {
        actorUserId: null,
        action: 'client.disabled',
        targetType: 'client',
        targetId: existing.client_id,
        details: { reason: 'removed_from_file' },
      });
      disabledCount++;
      changed = true;
    }

    if (changed) {
      await bumpClientVersion(client);
    }

    return { synced, disabled: disabledCount, skippedApi };
  });
}
