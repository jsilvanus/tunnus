import { randomBytes } from 'node:crypto';

export const MCP_IDENTITY_MODES = Object.freeze(['open', 'pseudo_ref', 'ref_only']);
export const DEFAULT_MCP_REF_TTL_MS = 24 * 60 * 60 * 1000;

/** @param {string} value */
function normalizeAlias(value) {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

/** @param {{ ownerUserId: string, authKind: 'oauth' | 'admin_token', authClientKey: string }} scope */
function assertScope(scope) {
  if (
    !scope?.ownerUserId ||
    !['oauth', 'admin_token'].includes(scope.authKind) ||
    !scope.authClientKey
  ) {
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
  await pool.query(
    `DELETE FROM mcp_identity_refs
      WHERE owner_user_id = $1 AND auth_kind = $2 AND auth_client_key = $3
        AND (expires_at < now() - interval '30 days'
          OR revoked_at < now() - interval '30 days')`,
    [scope.ownerUserId, scope.authKind, scope.authClientKey],
  );
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
export function scopeOf(scope) {
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
 * Resolve a typed alias/reference to an owner-owned identity subject (linked or external).
 * @param {import('pg').Pool} pool
 * @param {ReturnType<typeof scopeOf>} scope
 * @param {string} identifier
 * @param {'pseudo_ref' | 'ref_only'} [mode]
 */
export async function resolveMcpSubjectReference(pool, scope, identifier, mode = 'pseudo_ref') {
  assertScope(scope);
  if (typeof identifier !== 'string') throw new Error('Invalid user reference');
  let subject;
  if (identifier.startsWith('pseudo:') && mode !== 'ref_only') {
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
    const params = [scope.ownerUserId, handle];
    let scopeClause = '';
    if (scope.authKind && scope.authClientKey && scope.authClientKey !== 'internal') {
      params.push(scope.authKind, scope.authClientKey);
      scopeClause = `AND r.auth_kind = $3 AND r.auth_client_key = $4`;
    }
    const found = await pool.query(
      `SELECT s.id, s.tunnus_user_id, s.label
         FROM mcp_identity_refs r
         JOIN mcp_identity_subjects s ON s.id = r.subject_id AND s.owner_user_id = r.owner_user_id
        WHERE r.owner_user_id = $1 AND r.handle = $2
          ${scopeClause}
          AND r.revoked_at IS NULL AND r.expires_at > now()`,
      params,
    );
    subject = found.rows[0];
  } else {
    throw new Error('User reference must use pseudo: or ref: syntax');
  }
  if (!subject) throw new Error('Unknown or expired user reference');
  return subject;
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
  const subject = await resolveMcpSubjectReference(pool, scope, identifier, mode);
  if (!subject.tunnus_user_id) {
    const err = new Error('This identity is not linked to a Tunnus account');
    /** @type {any} */ (err).code = 'target_not_linked';
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
    `SELECT s.id AS subject_id, s.tunnus_user_id, s.label, s.notes, s.created_at, u.email, u.display_name,
            COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
              'id', p.id, 'pseudonym', p.pseudonym, 'is_preferred', p.is_preferred
            )) FILTER (WHERE p.id IS NOT NULL), '[]'::jsonb) AS pseudonyms,
            COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
              'id', r.id, 'handle', r.handle, 'auth_kind', r.auth_kind,
              'auth_client_key', r.auth_client_key, 'created_at', r.created_at,
              'expires_at', r.expires_at, 'revoked_at', r.revoked_at
            )) FILTER (WHERE r.id IS NOT NULL), '[]'::jsonb) AS refs
       FROM mcp_identity_subjects s
       LEFT JOIN users u ON u.id = s.tunnus_user_id
       LEFT JOIN mcp_pseudonyms p ON p.subject_id = s.id
       LEFT JOIN mcp_identity_refs r ON r.subject_id = s.id
      WHERE s.owner_user_id = $1
      GROUP BY s.id, u.email, u.display_name
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
    `UPDATE mcp_identity_refs SET expires_at = GREATEST(expires_at, now()) + interval '24 hours', updated_at = now()
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

/**
 * Create an owner-only identity subject, linked to a Tunnus account or external.
 * @param {import('pg').Pool} pool
 * @param {{ ownerUserId: string, userId?: string | null, label?: string, notes?: string }} input
 */
export async function createMcpIdentitySubject(
  pool,
  { ownerUserId, userId = null, label = '', notes = '' },
) {
  const { rows } = await pool.query(
    `INSERT INTO mcp_identity_subjects (owner_user_id, tunnus_user_id, label, notes)
     VALUES ($1, $2, $3, $4)
     RETURNING id, owner_user_id, tunnus_user_id, label, notes`,
    [ownerUserId, userId, label.trim(), notes.trim()],
  );
  return rows[0];
}

/**
 * Add an alias to an owner-owned subject. Preferred aliases are unique per subject.
 * @param {import('pg').Pool} pool
 * @param {{ ownerUserId: string, subjectId: string, pseudonym: string, preferred?: boolean }} input
 */
export async function addMcpPseudonym(
  pool,
  { ownerUserId, subjectId, pseudonym, preferred = false },
) {
  const value = pseudonym.trim();
  if (!value || value.length > 100 || /[\r\n]/.test(value)) throw new Error('Invalid pseudonym');
  const normalized = normalizeAlias(value);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owned = await client.query(
      'SELECT id FROM mcp_identity_subjects WHERE id = $1 AND owner_user_id = $2 FOR UPDATE',
      [subjectId, ownerUserId],
    );
    if (!owned.rows[0]) throw new Error('Identity subject not found');
    if (preferred) {
      await client.query(
        'UPDATE mcp_pseudonyms SET is_preferred = false WHERE owner_user_id = $1 AND subject_id = $2',
        [ownerUserId, subjectId],
      );
    }
    const { rows } = await client.query(
      `INSERT INTO mcp_pseudonyms (owner_user_id, subject_id, pseudonym, normalized_pseudonym, is_preferred)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, pseudonym, is_preferred`,
      [ownerUserId, subjectId, value, normalized, Boolean(preferred)],
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Link an external subject to an existing Tunnus user. A subject or user cannot be linked twice
 * within the same owner directory.
 * @param {import('pg').Pool} pool
 * @param {{ ownerUserId: string, subjectId: string, userId: string }} input
 */
export async function linkMcpIdentitySubject(pool, { ownerUserId, subjectId, userId }) {
  const { rows } = await pool.query(
    `UPDATE mcp_identity_subjects s
        SET tunnus_user_id = $3, updated_at = now()
      WHERE s.id = $1 AND s.owner_user_id = $2 AND s.tunnus_user_id IS NULL
        AND EXISTS (SELECT 1 FROM users u WHERE u.id = $3)
        AND NOT EXISTS (
          SELECT 1 FROM mcp_identity_subjects other
           WHERE other.owner_user_id = $2 AND other.tunnus_user_id = $3
        )
      RETURNING s.id, s.tunnus_user_id`,
    [subjectId, ownerUserId, userId],
  );
  return rows[0] ?? null;
}

/**
 * Create a reference for an existing owner-owned subject and a specific credential.
 * @param {import('pg').Pool} pool
 * @param {{ ownerUserId: string, authKind: 'oauth' | 'admin_token', authClientKey: string, subjectId: string }} input
 * @param {{ ttlMs?: number }} [options]
 */
export async function createMcpIdentityRefForSubject(pool, input, options = {}) {
  const scope = {
    ownerUserId: input.ownerUserId,
    authKind: input.authKind,
    authClientKey: input.authClientKey,
  };
  assertScope(scope);
  const owned = await pool.query(
    'SELECT id FROM mcp_identity_subjects WHERE id = $1 AND owner_user_id = $2',
    [input.subjectId, input.ownerUserId],
  );
  if (!owned.rows[0]) throw new Error('Identity subject not found');
  const handle = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + (options.ttlMs ?? DEFAULT_MCP_REF_TTL_MS));
  const { rows } = await pool.query(
    `INSERT INTO mcp_identity_refs (owner_user_id, auth_kind, auth_client_key, subject_id, handle, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, handle, expires_at`,
    [scope.ownerUserId, scope.authKind, scope.authClientKey, input.subjectId, handle, expiresAt],
  );
  return rows[0];
}

/**
 * Ensure an owner-directory subject exists for a linked account, without requiring an MCP client.
 * @param {import('pg').Pool} pool
 * @param {{ ownerUserId: string, userId: string }} input
 */
export async function ensureMcpIdentitySubjectForOwner(pool, { ownerUserId, userId }) {
  const { rows } = await pool.query(
    `INSERT INTO mcp_identity_subjects (owner_user_id, tunnus_user_id)
     VALUES ($1, $2)
     ON CONFLICT (owner_user_id, tunnus_user_id) WHERE tunnus_user_id IS NOT NULL
     DO UPDATE SET updated_at = now()
     RETURNING id, owner_user_id, tunnus_user_id, label, notes`,
    [ownerUserId, userId],
  );
  return rows[0];
}

/**
 * Delete one pseudonym belonging to an owner.
 * @param {import('pg').Pool} pool
 * @param {{ ownerUserId: string, pseudonymId: string }} input
 */
export async function deleteMcpPseudonym(pool, { ownerUserId, pseudonymId }) {
  const { rowCount } = await pool.query(
    'DELETE FROM mcp_pseudonyms WHERE id = $1 AND owner_user_id = $2',
    [pseudonymId, ownerUserId],
  );
  return Boolean(rowCount);
}

export async function mapIdentitySchema(value, schema, convert, direction) {
  if (value === null || value === undefined || !schema) return value;
  if (direction === 'input' && Boolean(schema['x-tunnus-user-reference'])) {
    if (typeof value !== 'string') throw new Error('Invalid user reference');
    return convert(value, {
      allowUnlinked: schema['x-tunnus-user-reference'] === 'allow_unlinked',
    });
  }
  if (
    direction === 'output' &&
    (schema['x-tunnus-user-id'] === true || Boolean(schema['x-tunnus-user-reference']))
  ) {
    if (typeof value !== 'string' || !value) return value;
    return convert(value);
  }
  if (Array.isArray(value)) {
    return Promise.all(
      value.map((item) => mapIdentitySchema(item, schema.items, convert, direction)),
    );
  }
  if (typeof value !== 'object') return value;
  const out = { ...value };
  if (direction === 'output' && schema['x-tunnus-user-record'] === true) {
    if (typeof out.id === 'string') out.id = await convert(out.id);
    for (const key of ['email', 'display_name', 'title', 'phone_number']) delete out[key];
  }
  if (direction === 'output' && schema['x-tunnus-membership-record'] === true) {
    delete out.email;
    delete out.display_name;
  }
  for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
    if (!Object.hasOwn(out, key)) continue;
    if (direction === 'output' && childSchema?.['x-tunnus-omit-in-restricted'] === true) {
      delete out[key];
      continue;
    }
    const condition = childSchema?.['x-tunnus-user-id-when'];
    const effective = condition
      ? {
          ...childSchema,
          'x-tunnus-user-id': direction === 'output' && out[condition.field] === condition.equals,
        }
      : childSchema;
    out[key] = await mapIdentitySchema(out[key], effective, convert, direction);
  }
  return out;
}

export async function mapOperationInput(op, params, body, resolve) {
  const mapped = { ...params };
  const allParams = op.parameters ?? [...(op.pathParams ?? []), ...(op.queryParams ?? [])];
  for (const p of allParams) {
    if (Object.hasOwn(mapped, p.name)) {
      mapped[p.name] = await mapIdentitySchema(mapped[p.name], p.schema, resolve, 'input');
    }
  }
  const bodySchema = op.bodySchema ?? op.requestBodySchema;
  return {
    params: mapped,
    body: bodySchema ? await mapIdentitySchema(body, bodySchema, resolve, 'input') : body,
  };
}

export function assertIdentityAnnotations(schema, path = '') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  const record =
    schema['x-tunnus-user-record'] === true || schema['x-tunnus-membership-record'] === true;
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const childPath = path ? path + '.' + key : key;
    if (
      ['email', 'display_name', 'phone_number', 'title'].includes(key) &&
      !record &&
      child?.['x-tunnus-omit-in-restricted'] !== true
    ) {
      throw new Error('Unannotated identity-bearing response field: ' + childPath);
    }
    if (
      ['user_id', 'actor_user_id', 'created_by'].includes(key) &&
      child?.['x-tunnus-user-id'] !== true &&
      !child?.['x-tunnus-user-id-when']
    ) {
      throw new Error('Unannotated user identifier response field: ' + childPath);
    }
    assertIdentityAnnotations(child, childPath);
  }
  if (schema.items) assertIdentityAnnotations(schema.items, path + '[]');
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    for (const child of schema[key] ?? []) assertIdentityAnnotations(child, path);
  }
}

export async function projectOperationOutput(op, body, represent) {
  const schema =
    op?.responseSchema ??
    op?.responses?.['200']?.content?.['application/json']?.schema ??
    op?.responses?.['201']?.content?.['application/json']?.schema;
  if (!schema || op.operationId === 'getMe') return body;
  assertIdentityAnnotations(schema);
  return mapIdentitySchema(body, schema, represent, 'output');
}
