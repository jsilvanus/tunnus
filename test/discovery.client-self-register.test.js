import { describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { once } from 'node:events';
import { createDiscoveryRouter } from '../src/web/discovery.js';
import { deriveSubkey, encryptWithKey } from '../src/oidc/keys.js';

async function request(app, path, { method = 'GET', headers = {}, body } = {}) {
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    const reqHeaders = { ...headers };
    let reqBody;
    if (body !== undefined) {
      reqHeaders['content-type'] = 'application/json';
      reqBody = JSON.stringify(body);
    }
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: reqHeaders,
      body: reqBody,
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { status: res.status, headers: res.headers, text, body: parsed };
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

describe('Discovery Client Self-Registration API', () => {
  const keyEncryptionSecret = 'test-secret-at-least-32-chars-long-12345';
  const clientSecretKey = deriveSubkey(keyEncryptionSecret, 'client-secret');

  const clientASecret = 'secret_A_123456';
  const clientBSecret = 'secret_B_654321';

  const mockClients = {
    'client-sissi': {
      client_id: 'client-sissi',
      metadata: {},
      secret_enc: encryptWithKey(clientASecret, clientSecretKey),
      disabled: false,
    },
    'client-piprogram': {
      client_id: 'client-piprogram',
      metadata: {},
      secret_enc: encryptWithKey(clientBSecret, clientSecretKey),
      disabled: false,
    },
    'client-disabled': {
      client_id: 'client-disabled',
      metadata: {},
      secret_enc: encryptWithKey('disabled-secret', clientSecretKey),
      disabled: true,
    },
    'client-no-perm': {
      client_id: 'client-no-perm',
      metadata: { allow_discovery_registration: false },
      secret_enc: encryptWithKey('noperm-secret', clientSecretKey),
      disabled: false,
    },
  };

  /** @type {Map<string, any>} */
  const servicesStore = new Map();

  function createMockPool() {
    return {
      async query(sql, params = []) {
        // oidc_clients query
        if (sql.includes('FROM oidc_clients WHERE client_id = $1')) {
          const client = mockClients[params[0]];
          return { rows: client ? [client] : [] };
        }

        // audit insert
        if (sql.includes('INSERT INTO audit_log')) {
          return { rows: [], rowCount: 1 };
        }

        // discovery_services select by id
        // discovery_services delete
        if (sql.includes('DELETE FROM discovery_services WHERE id = $1')) {
          const existed = servicesStore.delete(params[0]);
          return { rows: existed ? [{ id: params[0] }] : [], rowCount: existed ? 1 : 0 };
        }

        // discovery_services select by id for ownership check
        if (sql.includes('SELECT id, owner_client_id FROM discovery_services WHERE id = $1')) {
          const item = servicesStore.get(params[0]);
          return { rows: item ? [{ id: item.id, owner_client_id: item.owner_client_id }] : [] };
        }

        // discovery_services select full row by id
        if (sql.includes('FROM discovery_services WHERE id = $1')) {
          const item = servicesStore.get(params[0]);
          return { rows: item ? [item] : [] };
        }

        // discovery_services insert / update
        if (sql.includes('INSERT INTO discovery_services')) {
          const [id, name, type, venue, endpoint_url, auth, capabilities, metadata, disabled, owner_client_id] = params;
          const existed = servicesStore.has(id);
          const now = new Date();
          const record = {
            id,
            name,
            type,
            venue,
            endpoint_url,
            auth: JSON.parse(auth),
            capabilities,
            metadata: JSON.parse(metadata),
            disabled: Boolean(disabled),
            owner_client_id,
            created_at: existed ? servicesStore.get(id).created_at : now,
            updated_at: now,
            created: !existed,
          };
          servicesStore.set(id, record);
          return { rows: [record], rowCount: 1 };
        }

        // discovery_services heartbeat update
        if (sql.includes('UPDATE discovery_services SET updated_at = now() WHERE id = $1')) {
          const item = servicesStore.get(params[0]);
          if (!item) return { rows: [], rowCount: 0 };
          item.updated_at = new Date();
          return { rows: [item], rowCount: 1 };
        }

        // catalog query
        if (sql.includes('FROM discovery_services WHERE disabled = false')) {
          return { rows: Array.from(servicesStore.values()).filter((s) => !s.disabled) };
        }

        return { rows: [] };
      },
    };
  }

  function basicAuth(id, secret) {
    return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
  }

  it('rejects unauthenticated self-registration with 401 and WWW-Authenticate', async () => {
    const app = express();
    app.use(createDiscoveryRouter({ pool: createMockPool(), keyEncryptionSecret }));

    const res = await request(app, '/api/v1/discovery/services/sissi-signage', {
      method: 'PUT',
      body: { name: 'Sissi' },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Basic');
    expect(res.body.error).toBe('invalid_client');
  });

  it('rejects invalid client credentials with 401', async () => {
    const app = express();
    app.use(createDiscoveryRouter({ pool: createMockPool(), keyEncryptionSecret }));

    const res = await request(app, '/api/v1/discovery/services/sissi-signage', {
      method: 'PUT',
      headers: { Authorization: basicAuth('client-sissi', 'wrong-secret') },
      body: { name: 'Sissi' },
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });

  it('rejects disabled client with 403', async () => {
    const app = express();
    app.use(createDiscoveryRouter({ pool: createMockPool(), keyEncryptionSecret }));

    const res = await request(app, '/api/v1/discovery/services/test-service', {
      method: 'PUT',
      headers: { Authorization: basicAuth('client-disabled', 'disabled-secret') },
      body: { name: 'Test' },
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('client_disabled');
  });

  it('rejects client without registration permission with 403', async () => {
    const app = express();
    app.use(createDiscoveryRouter({ pool: createMockPool(), keyEncryptionSecret }));

    const res = await request(app, '/api/v1/discovery/services/test-service', {
      method: 'PUT',
      headers: { Authorization: basicAuth('client-no-perm', 'noperm-secret') },
      body: { name: 'Test' },
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('allows OIDC client to self-register a new service (201 Created)', async () => {
    const app = express();
    app.use(createDiscoveryRouter({ pool: createMockPool(), keyEncryptionSecret }));

    const payload = {
      name: 'Kyltti / Sissi Infonäytöt',
      type: 'signage',
      venue: 'parish-wide',
      endpoint_url: 'https://kehitys.riihimaenseurakunta.fi/sissi',
      auth: { type: 'oidc', client_id: 'client-sissi' },
      capabilities: ['screen_push', 'playlist_management'],
      metadata: { default_view: 'parish_bulletin' },
    };

    const res = await request(app, '/api/v1/discovery/services/sissi-signage', {
      method: 'PUT',
      headers: { Authorization: basicAuth('client-sissi', clientASecret) },
      body: payload,
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('sissi-signage');
    expect(res.body.owner_client_id).toBe('client-sissi');
    expect(res.body.url).toBe(payload.endpoint_url);
    expect(servicesStore.get('sissi-signage')?.owner_client_id).toBe('client-sissi');
  });

  it('allows same OIDC client to update its registered service using X-Client-* headers (200 OK)', async () => {
    const app = express();
    app.use(createDiscoveryRouter({ pool: createMockPool(), keyEncryptionSecret }));

    const payload = {
      name: 'Kyltti / Sissi Infonäytöt (Päivitetty)',
      type: 'signage',
      venue: 'parish-wide',
      endpoint_url: 'https://kehitys.riihimaenseurakunta.fi/sissi',
      auth: { type: 'oidc', client_id: 'client-sissi' },
      capabilities: ['screen_push', 'export_target'],
      metadata: { default_view: 'parish_bulletin' },
    };

    const res = await request(app, '/api/v1/discovery/services/sissi-signage', {
      method: 'PUT',
      headers: {
        'X-Client-Id': 'client-sissi',
        'X-Client-Secret': clientASecret,
      },
      body: payload,
    });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Kyltti / Sissi Infonäytöt (Päivitetty)');
    expect(res.body.capabilities).toContain('export_target');
  });

  it('forbids another client from modifying an owned service (403 Forbidden)', async () => {
    const app = express();
    app.use(createDiscoveryRouter({ pool: createMockPool(), keyEncryptionSecret }));

    const res = await request(app, '/api/v1/discovery/services/sissi-signage', {
      method: 'PUT',
      headers: { Authorization: basicAuth('client-piprogram', clientBSecret) },
      body: {
        name: 'Hijacked Sissi',
        type: 'signage',
        endpoint_url: 'https://evil.local',
      },
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(res.body.message).toContain('owned by client');
  });

  it('allows owner to send heartbeat (200 OK) but forbids non-owner (403)', async () => {
    const app = express();
    app.use(createDiscoveryRouter({ pool: createMockPool(), keyEncryptionSecret }));

    // Non-owner heartbeat attempt
    const foreignRes = await request(
      app,
      '/api/v1/discovery/services/sissi-signage/heartbeat',
      {
        method: 'POST',
        headers: { Authorization: basicAuth('client-piprogram', clientBSecret) },
      },
    );
    expect(foreignRes.status).toBe(403);
    expect(foreignRes.body.error).toBe('forbidden');

    // Owner heartbeat
    const ownerRes = await request(
      app,
      '/api/v1/discovery/services/sissi-signage/heartbeat',
      {
        method: 'POST',
        headers: { Authorization: basicAuth('client-sissi', clientASecret) },
      },
    );
    expect(ownerRes.status).toBe(200);
    expect(ownerRes.body.ok).toBe(true);
    expect(ownerRes.body.updated_at).toBeDefined();
  });

  it('retrieves single service details via GET /api/v1/discovery/services/:serviceId', async () => {
    const app = express();
    app.use(createDiscoveryRouter({ pool: createMockPool(), keyEncryptionSecret }));

    const res = await request(app, '/api/v1/discovery/services/sissi-signage');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('sissi-signage');
    expect(res.body.owner_client_id).toBe('client-sissi');

    const notFoundRes = await request(app, '/api/v1/discovery/services/non-existent');
    expect(notFoundRes.status).toBe(404);
  });

  it('forbids another client from deleting an owned service (403 Forbidden)', async () => {
    const app = express();
    app.use(createDiscoveryRouter({ pool: createMockPool(), keyEncryptionSecret }));

    const res = await request(app, '/api/v1/discovery/services/sissi-signage', {
      method: 'DELETE',
      headers: { Authorization: basicAuth('client-piprogram', clientBSecret) },
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(servicesStore.has('sissi-signage')).toBe(true);
  });

  it('allows owner to deregister/delete service (204 No Content)', async () => {
    const app = express();
    app.use(createDiscoveryRouter({ pool: createMockPool(), keyEncryptionSecret }));

    const res = await request(app, '/api/v1/discovery/services/sissi-signage', {
      method: 'DELETE',
      headers: { Authorization: basicAuth('client-sissi', clientASecret) },
    });

    expect(res.status).toBe(204);
    expect(servicesStore.has('sissi-signage')).toBe(false);
  });
});
