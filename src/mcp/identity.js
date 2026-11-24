import { randomBytes } from 'node:crypto';

export const MCP_IDENTITY_MODES = Object.freeze(['open', 'pseudo_ref', 'ref_only']);
export const DEFAULT_MCP_REF_TTL_MS = 24 * 60 * 60 * 1000;

/** @param {string} value */
function normalizeAlias(value) {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

/** @param {{ ownerUserId: string, authKind: 'oauth' | 'admin_token', authClientKey: string }} scope */
function assertScope(scope) {
  if (!scope?.ownerUserId || !['oauth', 'admin_token'].includes(scope.authKind) || !scope.authClientKey) {
    throw new Error('A verified MCP identity scope is required');
  }
}

/**
 * Read the mode on every request. Missing settings preserve the open-mode compatibility default.
 * @param {import('pg').Pool} pool
 * @param {{ ownerUserId: string, authKind: 'oauth' | 'admin_token', authClientKey: string }} scope
 */
export async function getMcpIdentitySettings(pool, scope) {
  assertScope(scope);
  const { rows } = await pool.query(
    `SELECT identity_mode FROM mcp_client_settings
      WHERE owner_user_id = $1 AND auth_kind = $2 AND auth_client_key = $3`,
    [scope.ownerUserId, scope.authKind, scope.authClientKey],
  );
  return rows[0]?.identity_mode ?? 'open';
}

/**
 * Set a mode for one authenticated credential. The owner is always part of the key.
 * @param {import('pg').Pool} pool
 * @param {ReturnType<typeof scopeOf>} scope
 * @param {'open' | 'pseudo_ref' | 'ref_only'} mode
 */
export async function setMcpIdentityMode(pool, scope, mode) {
  assertScope(scope);
  if (!MCP_IDENTITY_MODES.includes(mode)) throw new Error('Invalid MCP identity mode');
  await pool.query(
    `INSERT INTO mcp_client_settings (owner_user_id, auth_kind, auth_client_key, identity_mode)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner_user_id, auth_kind, auth_client_key)
     DO UPDATE SET identity_mode = EXCLUDED.identity_mode, updated_at = now()`,
    [scope.ownerUserId, scope.authKind, scope.authClientKey, mode],
  );
}

/** @param {{ ownerUserId: string, authKind: 'oauth' | 'admin_token', authClientKey: string }} scope */
function scopeOf(scope) {
  assertScope(scope);
  return scope;
}

/**
 * Find or create the owner's subject for a Tunnus user.
 * @param {import('pg').Pool} pool
 * @param {ReturnType<typeof scopeOf>} scope
 * @param {string} userId
 */
export async function ensureMcpIdentitySubject(pool, scope, userId) {
  assertScope(scope);
  const { rows } = await pool.query(
    `INSERT INTO mcp_identity_subjects (owner_user_id, tunnus_user_id)
     VALUES ($1, $2)
     ON CONFLICT (owner_user_id, tunnus_user_id) WHERE tunnus_user_id IS NOT NULL
     DO UPDATE SET updated_at = now()
     RETURNING id, owner_user_id, tunnus_user_id, label, notes`,
    [scope.ownerUserId, userId],
  );
  return rows[0];
}

/**
 * Resolve a typed alias/reference to a linked Tunnus user. External subjects intentionally cannot
 * be used for operations that require an account.
 * @param {import('pg').Pool} pool
 * @param {ReturnType<typeof scopeOf>} scope
 * @param {string} identifier
 * @param {'pseudo_ref' | 'ref_only'} mode
 */
export async function resolveMcpUserReference(pool, scope, identifier, mode) {
  assertScope(scope);
  if (typeof identifier !== 'string') throw new Error('Invalid user reference');
  let subject;
  if (identifier.startsWith('pseudo:') && mode === 'pseudo_ref') {
    const alias = identifier.slice(7).trim();
    if (!alias) throw new Error('Unknown user reference');
    const found = await pool.query(
      `SELECT s.id, s.tunnus_user_id, s.label, p.pseudonym
         FROM mcp_pseudonyms p
         JOIN mcp_identity_subjects s ON s.id = p.subject_id AND s.owner_user_id = p.owner_user_id
        WHERE p.owner_user_id = $1 AND p.normalized_pseudonym = $2`,
      [scope.ownerUserId, normalizeAlias(alias)],
    );
    subject = found.rows[0];
  } else if (identifier.startsWith('ref:')) {
    const handle = identifier.slice(4);
    const found = await pool.query(
      `SELECT s.id, s.tunnus_user_id, s.label
         FROM mcp_identity_refs r
         JOIN mcp_identity_subjects s ON s.id = r.subject_id AND s.owner_user_id = r.owner_user_id
        WHERE r.owner_user_id = $1 AND r.auth_kind = $2 AND r.auth_client_key = $3
          AND r.handle = $4 AND r.revoked_at IS NULL AND r.expires_at > now()`,
      [scope.ownerUserId, scope.authKind, scope.authClientKey, handle],
    );
    subject = found.rows[0];
  } else {
    throw new Error('User reference must use pseudo: or ref: syntax');
  }
  if (!subject) throw new Error('Unknown or expired user reference');
  if (!subject.tunnus_user_id) {
    const err = new Error('This identity is not linked to a Tunnus account');
    err.code = 'target_not_linked';
    throw err;
  }
  return subject.tunnus_user_id;
}

/**
 * Get the preferred alias for a linked user, creating a temporary ref when necessary.
 * @param {import('pg').Pool} pool
 * @param {ReturnType<typeof scopeOf>} scope
 * @param {string} userId
 * @param {'pseudo_ref' | 'ref_only'} mode
 * @param {{ now?: Date, ttlMs?: number }} [options]
 */
export async function representMcpUser(pool, scope, userId, mode, options = {}) {
  assertScope(scope);
  const subject = await ensureMcpIdentitySubject(pool, scope, userId);
  if (mode === 'pseudo_ref') {
    const aliases = await pool.query(
      `SELECT pseudonym FROM mcp_pseudonyms
        WHERE owner_user_id = $1 AND subject_id = $2 AND is_preferred = true LIMIT 1`,
      [scope.ownerUserId, subject.id],
    );
    if (aliases.rows[0]) return `pseudo:${aliases.rows[0].pseudonym}`;
  }
  const active = await pool.query(
    `SELECT handle FROM mcp_identity_refs
      WHERE owner_user_id = $1 AND auth_kind = $2 AND auth_client_key = $3
        AND subject_id = $4 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [scope.ownerUserId, scope.authKind, scope.authClientKey, subject.id],
  );
  if (active.rows[0]) return `ref:${active.rows[0].handle}`;
  const handle = randomBytes(32).toString('base64url');
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (options.ttlMs ?? DEFAULT_MCP_REF_TTL_MS));
  await pool.query(
    `INSERT INTO mcp_identity_refs
       (owner_user_id, auth_kind, auth_client_key, subject_id, handle, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [scope.ownerUserId, scope.authKind, scope.authClientKey, subject.id, handle, expiresAt],
  );
  return `ref:${handle}`;
}

/**
 * List owner-visible identity subjects, pseudonyms, and refs.
 * @param {import('pg').Pool} pool
 * @param {string} ownerUserId
 */
export async function listMcpIdentityDirectory(pool, ownerUserId) {
  const { rows } = await pool.query(
    `SELECT s.id AS subject_id, s.tunnus_user_id, s.label, s.notes, s.created_at,
            COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
              'id', p.id, 'pseudonym', p.pseudonym, 'is_preferred', p.is_preferred
            )) FILTER (WHERE p.id IS NOT NULL), '[]'::jsonb) AS pseudonyms,
            COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
              'id', r.id, 'handle', r.handle, 'auth_kind', r.auth_kind,
              'auth_client_key', r.auth_client_key, 'created_at', r.created_at,
              'expires_at', r.expires_at, 'revoked_at', r.revoked_at
            )) FILTER (WHERE r.id IS NOT NULL), '[]'::jsonb) AS refs
       FROM mcp_identity_subjects s
       LEFT JOIN mcp_pseudonyms p ON p.subject_id = s.id
       LEFT JOIN mcp_identity_refs r ON r.subject_id = s.id
      WHERE s.owner_user_id = $1
      GROUP BY s.id
      ORDER BY s.created_at DESC`,
    [ownerUserId],
  );
  return rows;
}

/**
 * Create a temporary reference manually for a linked Tunnus user.
 * @param {import('pg').Pool} pool
 * @param {{ ownerUserId: string, authKind: 'oauth' | 'admin_token', authClientKey: string }} scope
 * @param {string} userId
 * @param {{ ttlMs?: number }} [options]
 */
export async function createMcpIdentityRef(pool, scope, userId, options = {}) {
  const subject = await ensureMcpIdentitySubject(pool, scope, userId);
  const handle = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + (options.ttlMs ?? DEFAULT_MCP_REF_TTL_MS));
  const { rows } = await pool.query(
    `INSERT INTO mcp_identity_refs
       (owner_user_id, auth_kind, auth_client_key, subject_id, handle, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, handle, expires_at`,
    [scope.ownerUserId, scope.authKind, scope.authClientKey, subject.id, handle, expiresAt],
  );
  return rows[0];
}

/**
 * Extend an active reference by 24 hours from now. Expired references cannot be revived.
 * @param {import('pg').Pool} pool
 * @param {{ ownerUserId: string, refId: string }} input
 */
export async function extendMcpIdentityRef(pool, { ownerUserId, refId }) {
  const { rows } = await pool.query(
    `UPDATE mcp_identity_refs SET expires_at = now() + interval '24 hours', updated_at = now()
      WHERE id = $1 AND owner_user_id = $2 AND revoked_at IS NULL AND expires_at > now()
      RETURNING id, expires_at`,
    [refId, ownerUserId],
  );
  return rows[0] ?? null;
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ ownerUserId: string, refId: string }} input
 */
export async function revokeMcpIdentityRef(pool, { ownerUserId, refId }) {
  const { rowCount } = await pool.query(
    `UPDATE mcp_identity_refs SET revoked_at = now(), updated_at = now()
      WHERE id = $1 AND owner_user_id = $2 AND revoked_at IS NULL`,
    [refId, ownerUserId],
  );
  return Boolean(rowCount);
}
