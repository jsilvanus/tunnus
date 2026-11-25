import { audit } from '../audit.js';
import {
  ServiceError,
  validateServiceId,
  validateServiceInput,
} from './validate.js';

export { ServiceError };

const SERVICE_COLUMNS =
  'id, name, type, venue, endpoint_url, auth, capabilities, metadata, disabled, owner_client_id, created_at, updated_at';

/**
 * Format a database row as a service response object.
 * @param {Record<string, any>} row
 */
export function serviceJson(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    venue: row.venue,
    endpoint_url: row.endpoint_url,
    url: row.endpoint_url,
    auth: row.auth && typeof row.auth === 'object' ? row.auth : { type: 'none' },
    capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    disabled: Boolean(row.disabled),
    owner_client_id: row.owner_client_id ?? null,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

/**
 * Format a database row as a discovered service for client apps.
 * @param {Record<string, any>} row
 */
export function discoveredServiceJson(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    venue: row.venue,
    endpoint_url: row.endpoint_url,
    url: row.endpoint_url,
    auth: row.auth && typeof row.auth === 'object' ? row.auth : { type: 'none' },
    capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    owner_client_id: row.owner_client_id ?? null,
  };
}

/**
 * List all services (admin view).
 * @param {import('pg').Pool} pool
 * @param {{ includeDisabled?: boolean, type?: string, venue?: string, capability?: string }} [filters]
 */
export async function listServices(pool, { includeDisabled = false, type, venue, capability } = {}) {
  const conditions = [];
  const params = [];

  if (!includeDisabled) {
    conditions.push('disabled = false');
  }
  if (type) {
    params.push(type.trim());
    conditions.push(`type = $${params.length}`);
  }
  if (venue) {
    params.push(venue.trim());
    conditions.push(`venue = $${params.length}`);
  }
  if (capability) {
    params.push(capability.trim());
    conditions.push(`$${params.length} = ANY(capabilities)`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const query = `SELECT ${SERVICE_COLUMNS} FROM discovery_services ${whereClause} ORDER BY venue ASC, type ASC, id ASC`;
  const result = await pool.query(query, params);
  return result.rows.map(serviceJson);
}

/**
 * Get a single service by ID.
 * @param {import('pg').Pool} pool
 * @param {string} id
 */
export async function getService(pool, id) {
  validateServiceId(id);
  const result = await pool.query(
    `SELECT ${SERVICE_COLUMNS} FROM discovery_services WHERE id = $1`,
    [id],
  );
  if (result.rows.length === 0) return null;
  return serviceJson(result.rows[0]);
}

/**
 * Create a new service. Throws conflict if ID already exists.
 * @param {import('pg').Pool} pool
 * @param {Record<string, any>} body
 * @param {{ userId?: string }} [options]
 */
export async function createService(pool, body, { userId } = {}) {
  const validated = validateServiceInput(body, { isUpdate: false });
  const existing = await getService(pool, validated.id);
  if (existing) {
    throw new ServiceError('conflict', `Service with id '${validated.id}' already exists`);
  }

  const query = `
    INSERT INTO discovery_services (
      id, name, type, venue, endpoint_url, auth, capabilities, metadata, disabled, created_by, updated_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
    RETURNING ${SERVICE_COLUMNS}
  `;
  const values = [
    validated.id,
    validated.name,
    validated.type,
    validated.venue,
    validated.endpoint_url,
    JSON.stringify(validated.auth),
    validated.capabilities,
    JSON.stringify(validated.metadata),
    validated.disabled,
    userId || null,
  ];

  const result = await pool.query(query, values);
  const service = serviceJson(result.rows[0]);
  await audit(pool, {
    action: 'service_created',
    actorUserId: userId,
    targetType: 'service',
    targetId: service.id,
    details: { type: service.type, venue: service.venue },
  }).catch(() => {});
  return service;
}

/**
 * Put service (idempotent create or replace).
 * @param {import('pg').Pool} pool
 * @param {string} id
 * @param {Record<string, any>} body
 * @param {{ userId?: string }} [options]
 */
export async function putService(pool, id, body, { userId } = {}) {
  const cleanId = validateServiceId(id);
  const validated = validateServiceInput({ ...body, id: cleanId }, { isUpdate: false });

  const query = `
    INSERT INTO discovery_services (
      id, name, type, venue, endpoint_url, auth, capabilities, metadata, disabled, created_by, updated_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      type = EXCLUDED.type,
      venue = EXCLUDED.venue,
      endpoint_url = EXCLUDED.endpoint_url,
      auth = EXCLUDED.auth,
      capabilities = EXCLUDED.capabilities,
      metadata = EXCLUDED.metadata,
      disabled = EXCLUDED.disabled,
      updated_at = now(),
      updated_by = EXCLUDED.updated_by
    RETURNING ${SERVICE_COLUMNS}, (xmax = 0) AS created
  `;

  const values = [
    validated.id,
    validated.name,
    validated.type,
    validated.venue,
    validated.endpoint_url,
    JSON.stringify(validated.auth),
    validated.capabilities,
    JSON.stringify(validated.metadata),
    validated.disabled,
    userId || null,
  ];

  const result = await pool.query(query, values);
  const row = result.rows[0];
  const service = serviceJson(row);
  const created = Boolean(row.created);

  await audit(pool, {
    action: created ? 'service_created' : 'service_replaced',
    actorUserId: userId,
    targetType: 'service',
    targetId: service.id,
    details: { type: service.type, venue: service.venue },
  }).catch(() => {});

  return { service, created };
}

/**
 * Put service by an authenticated OIDC client (self-registration).
 * Enforces that if the service already exists, it must either have no owner or be owned by the same clientId.
 * @param {import('pg').Pool} pool
 * @param {string} id
 * @param {Record<string, any>} body
 * @param {{ clientId: string }} options
 */
export async function putClientService(pool, id, body, { clientId }) {
  const cleanId = validateServiceId(id);

  // Check ownership if existing
  const existingRes = await pool.query(
    'SELECT id, owner_client_id FROM discovery_services WHERE id = $1',
    [cleanId],
  );
  if (existingRes.rows.length > 0) {
    const existing = existingRes.rows[0];
    if (existing.owner_client_id && existing.owner_client_id !== clientId) {
      throw new ServiceError(
        'forbidden',
        `Service '${cleanId}' is owned by client '${existing.owner_client_id}'`,
      );
    }
  }

  const validated = validateServiceInput({ ...body, id: cleanId }, { isUpdate: false });

  const query = `
    INSERT INTO discovery_services (
      id, name, type, venue, endpoint_url, auth, capabilities, metadata, disabled, owner_client_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      type = EXCLUDED.type,
      venue = EXCLUDED.venue,
      endpoint_url = EXCLUDED.endpoint_url,
      auth = EXCLUDED.auth,
      capabilities = EXCLUDED.capabilities,
      metadata = EXCLUDED.metadata,
      disabled = EXCLUDED.disabled,
      owner_client_id = EXCLUDED.owner_client_id,
      updated_at = now()
    RETURNING ${SERVICE_COLUMNS}, (xmax = 0) AS created
  `;

  const values = [
    validated.id,
    validated.name,
    validated.type,
    validated.venue,
    validated.endpoint_url,
    JSON.stringify(validated.auth),
    validated.capabilities,
    JSON.stringify(validated.metadata),
    validated.disabled,
    clientId,
  ];

  const result = await pool.query(query, values);
  const row = result.rows[0];
  const service = serviceJson(row);
  const created = Boolean(row.created);

  await audit(pool, {
    action: created ? 'service_self_registered' : 'service_self_updated',
    targetType: 'service',
    targetId: service.id,
    details: { clientId, type: service.type, venue: service.venue },
  }).catch(() => {});

  return { service, created };
}

/**
 * Delete service by its owning OIDC client (self-deregistration).
 * @param {import('pg').Pool} pool
 * @param {string} id
 * @param {{ clientId: string }} options
 */
export async function deleteClientService(pool, id, { clientId }) {
  const cleanId = validateServiceId(id);
  const existingRes = await pool.query(
    'SELECT id, owner_client_id FROM discovery_services WHERE id = $1',
    [cleanId],
  );
  if (existingRes.rows.length === 0) {
    return false;
  }
  const existing = existingRes.rows[0];
  if (existing.owner_client_id && existing.owner_client_id !== clientId) {
    throw new ServiceError(
      'forbidden',
      `Service '${cleanId}' is owned by client '${existing.owner_client_id}'`,
    );
  }

  const result = await pool.query('DELETE FROM discovery_services WHERE id = $1 RETURNING id', [
    cleanId,
  ]);
  const deleted = result.rowCount > 0;
  if (deleted) {
    await audit(pool, {
      action: 'service_self_deregistered',
      targetType: 'service',
      targetId: cleanId,
      details: { clientId },
    }).catch(() => {});
  }
  return deleted;
}

/**
 * Update service heartbeat timestamp (self-liveness check).
 * @param {import('pg').Pool} pool
 * @param {string} id
 * @param {{ clientId?: string }} [options]
 */
export async function touchServiceHeartbeat(pool, id, { clientId } = {}) {
  const cleanId = validateServiceId(id);
  const existingRes = await pool.query(
    'SELECT id, owner_client_id FROM discovery_services WHERE id = $1',
    [cleanId],
  );
  if (existingRes.rows.length === 0) {
    throw new ServiceError('not_found', `Service '${cleanId}' not found`);
  }
  const existing = existingRes.rows[0];
  if (clientId && existing.owner_client_id && existing.owner_client_id !== clientId) {
    throw new ServiceError(
      'forbidden',
      `Service '${cleanId}' is owned by client '${existing.owner_client_id}'`,
    );
  }

  const result = await pool.query(
    `UPDATE discovery_services SET updated_at = now() WHERE id = $1 RETURNING ${SERVICE_COLUMNS}`,
    [cleanId],
  );
  const service = serviceJson(result.rows[0]);

  await audit(pool, {
    action: 'service_heartbeat',
    targetType: 'service',
    targetId: cleanId,
    details: { clientId },
  }).catch(() => {});

  return service;
}

/**
 * Partial update for a service.
 * @param {import('pg').Pool} pool
 * @param {string} id
 * @param {Record<string, any>} body
 * @param {{ userId?: string }} [options]
 */
export async function patchService(pool, id, body, { userId } = {}) {
  const cleanId = validateServiceId(id);
  const validated = validateServiceInput(body, { isUpdate: true });

  const updates = [];
  const params = [cleanId];

  if (validated.name !== undefined) {
    params.push(validated.name);
    updates.push(`name = $${params.length}`);
  }
  if (validated.type !== undefined) {
    params.push(validated.type);
    updates.push(`type = $${params.length}`);
  }
  if (validated.venue !== undefined) {
    params.push(validated.venue);
    updates.push(`venue = $${params.length}`);
  }
  if (validated.endpoint_url !== undefined) {
    params.push(validated.endpoint_url);
    updates.push(`endpoint_url = $${params.length}`);
  }
  if (validated.auth !== undefined) {
    params.push(JSON.stringify(validated.auth));
    updates.push(`auth = $${params.length}`);
  }
  if (validated.capabilities !== undefined) {
    params.push(validated.capabilities);
    updates.push(`capabilities = $${params.length}`);
  }
  if (validated.metadata !== undefined) {
    params.push(JSON.stringify(validated.metadata));
    updates.push(`metadata = $${params.length}`);
  }
  if (validated.disabled !== undefined) {
    params.push(validated.disabled);
    updates.push(`disabled = $${params.length}`);
  }

  if (updates.length === 0) {
    const existing = await getService(pool, cleanId);
    if (!existing) throw new ServiceError('not_found', `Service '${cleanId}' not found`);
    return existing;
  }

  params.push(userId || null);
  updates.push(`updated_by = $${params.length}`);
  updates.push('updated_at = now()');

  const query = `
    UPDATE discovery_services
    SET ${updates.join(', ')}
    WHERE id = $1
    RETURNING ${SERVICE_COLUMNS}
  `;

  const result = await pool.query(query, params);
  if (result.rows.length === 0) {
    throw new ServiceError('not_found', `Service '${cleanId}' not found`);
  }

  const service = serviceJson(result.rows[0]);
  await audit(pool, {
    action: 'service_updated',
    actorUserId: userId,
    targetType: 'service',
    targetId: service.id,
  }).catch(() => {});
  return service;
}

/**
 * Delete a service from the registry.
 * @param {import('pg').Pool} pool
 * @param {string} id
 * @param {{ userId?: string }} [options]
 */
export async function deleteService(pool, id, { userId } = {}) {
  const cleanId = validateServiceId(id);
  const result = await pool.query('DELETE FROM discovery_services WHERE id = $1 RETURNING id', [
    cleanId,
  ]);
  const deleted = result.rowCount > 0;
  if (deleted) {
    await audit(pool, {
      action: 'service_deleted',
      actorUserId: userId,
      targetType: 'service',
      targetId: cleanId,
    }).catch(() => {});
  }
  return deleted;
}

/**
 * Public discovery endpoint catalog provider.
 * @param {import('pg').Pool} pool
 * @param {{ type?: string, venue?: string, capability?: string }} [filters]
 */
export async function getDiscoveryCatalog(pool, { type, venue, capability } = {}) {
  const conditions = ['disabled = false'];
  const params = [];

  if (type) {
    params.push(type.trim());
    conditions.push(`type = $${params.length}`);
  }
  if (venue) {
    params.push(venue.trim());
    conditions.push(`venue = $${params.length}`);
  }
  if (capability) {
    params.push(capability.trim());
    conditions.push(`$${params.length} = ANY(capabilities)`);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const query = `
    SELECT ${SERVICE_COLUMNS},
      MAX(updated_at) OVER () AS max_updated_at
    FROM discovery_services
    ${whereClause}
    ORDER BY venue ASC, type ASC, id ASC
  `;

  const result = await pool.query(query, params);
  const maxUpdated =
    result.rows.length > 0 && result.rows[0].max_updated_at instanceof Date
      ? result.rows[0].max_updated_at.toISOString()
      : new Date().toISOString();

  return {
    updated_at: maxUpdated,
    services: result.rows.map(discoveredServiceJson),
  };
}
