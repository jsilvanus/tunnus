import { describe, expect, it } from 'vitest';
import {
  createService,
  deleteService,
  discoveredServiceJson,
  getDiscoveryCatalog,
  getService,
  listServices,
  patchService,
  putService,
  serviceJson,
  ServiceError,
} from '../src/services/store.js';

function createMockPool(initialRows = []) {
  let rows = [...initialRows];

  return {
    async query(sql, params = []) {
      const text = sql.trim();

      // SELECT single
      if (text.startsWith('SELECT id, name, type, venue, endpoint_url') && text.includes('WHERE id = $1')) {
        const found = rows.find((r) => r.id === params[0]);
        return { rows: found ? [{ ...found }] : [] };
      }

      // SELECT list / catalog
      if (text.startsWith('SELECT id, name, type, venue, endpoint_url')) {
        let filtered = [...rows];
        let paramIdx = 1;

        if (text.includes('disabled = false')) {
          filtered = filtered.filter((r) => !r.disabled);
        }

        if (text.includes(`type = $`)) {
          const typeVal = params[paramIdx - 1];
          paramIdx++;
          filtered = filtered.filter((r) => r.type === typeVal);
        }

        if (text.includes(`venue = $`)) {
          const venueVal = params[paramIdx - 1];
          paramIdx++;
          filtered = filtered.filter((r) => r.venue === venueVal);
        }

        if (text.includes(`ANY(capabilities)`)) {
          const capVal = params[paramIdx - 1];
          filtered = filtered.filter((r) => r.capabilities?.includes(capVal));
        }

        const maxUpdated = filtered.length > 0
          ? new Date(Math.max(...filtered.map((r) => new Date(r.updated_at).getTime())))
          : new Date();

        return {
          rows: filtered.map((r) => ({ ...r, max_updated_at: maxUpdated })),
        };
      }

      // INSERT
      if (text.startsWith('INSERT INTO discovery_services') && !text.includes('ON CONFLICT')) {
        const [id, name, type, venue, endpoint_url, auth, capabilities, metadata, disabled, userId] = params;
        const now = new Date();
        const newRow = {
          id,
          name,
          type,
          venue,
          endpoint_url,
          auth: JSON.parse(auth),
          capabilities,
          metadata: JSON.parse(metadata),
          disabled,
          created_at: now,
          updated_at: now,
          created_by: userId,
          updated_by: userId,
        };
        rows.push(newRow);
        return { rows: [{ ...newRow }] };
      }

      // PUT (UPSERT)
      if (text.includes('ON CONFLICT (id) DO UPDATE')) {
        const [id, name, type, venue, endpoint_url, auth, capabilities, metadata, disabled, userId] = params;
        const now = new Date();
        const idx = rows.findIndex((r) => r.id === id);
        let created = false;
        let row;
        if (idx >= 0) {
          row = {
            ...rows[idx],
            name,
            type,
            venue,
            endpoint_url,
            auth: JSON.parse(auth),
            capabilities,
            metadata: JSON.parse(metadata),
            disabled,
            updated_at: now,
            updated_by: userId,
          };
          rows[idx] = row;
        } else {
          created = true;
          row = {
            id,
            name,
            type,
            venue,
            endpoint_url,
            auth: JSON.parse(auth),
            capabilities,
            metadata: JSON.parse(metadata),
            disabled,
            created_at: now,
            updated_at: now,
            created_by: userId,
            updated_by: userId,
          };
          rows.push(row);
        }
        return { rows: [{ ...row, created }] };
      }

      // UPDATE (PATCH)
      if (text.startsWith('UPDATE discovery_services')) {
        const id = params[0];
        const idx = rows.findIndex((r) => r.id === id);
        if (idx === -1) return { rows: [] };
        const row = rows[idx];
        const updated = { ...row, updated_at: new Date() };

        // Simple mock patch updater
        let p = 1;
        if (text.includes('name = $')) updated.name = params[p++];
        if (text.includes('type = $')) updated.type = params[p++];
        if (text.includes('venue = $')) updated.venue = params[p++];
        if (text.includes('endpoint_url = $')) updated.endpoint_url = params[p++];
        if (text.includes('auth = $')) updated.auth = JSON.parse(params[p++]);
        if (text.includes('capabilities = $')) updated.capabilities = params[p++];
        if (text.includes('metadata = $')) updated.metadata = JSON.parse(params[p++]);
        if (text.includes('disabled = $')) updated.disabled = params[p];

        rows[idx] = updated;
        return { rows: [updated] };
      }

      // DELETE
      if (text.startsWith('DELETE FROM discovery_services')) {
        const id = params[0];
        const before = rows.length;
        rows = rows.filter((r) => r.id !== id);
        return { rowCount: before - rows.length };
      }

      throw new Error(`Unhandled mock SQL query: ${text}`);
    },
  };
}

describe('Services Store', () => {
  const sampleService = {
    id: 'keskuskirkko-piprogram',
    name: 'Keskuskirkko — Sali (Pi Program)',
    type: 'piprogram',
    venue: 'keskuskirkko',
    endpoint_url: 'https://gateway.keskuskirkko.riihimaenseurakunta.fi:8443/program',
    auth: { type: 'api_key', header_name: 'X-API-Key' },
    capabilities: ['slides', 'shutter'],
    metadata: { pipeline: 'primary' },
    disabled: false,
    created_at: new Date('2026-11-20T10:00:00Z'),
    updated_at: new Date('2026-11-20T10:00:00Z'),
  };

  it('serviceJson and discoveredServiceJson format properly', () => {
    const formatted = serviceJson(sampleService);
    expect(formatted.id).toBe(sampleService.id);
    expect(formatted.endpoint_url).toBe(sampleService.endpoint_url);
    expect(formatted.url).toBe(sampleService.endpoint_url);

    const discovered = discoveredServiceJson(sampleService);
    expect(discovered.id).toBe(sampleService.id);
    expect(discovered.url).toBe(sampleService.endpoint_url);
    expect(discovered).not.toHaveProperty('disabled');
    expect(discovered).not.toHaveProperty('created_at');
  });

  it('creates, retrieves and lists services', async () => {
    const pool = createMockPool();

    const created = await createService(pool, sampleService);
    expect(created.id).toBe('keskuskirkko-piprogram');

    const fetched = await getService(pool, 'keskuskirkko-piprogram');
    expect(fetched).not.toBeNull();
    expect(fetched?.name).toBe('Keskuskirkko — Sali (Pi Program)');

    const list = await listServices(pool);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('keskuskirkko-piprogram');
  });

  it('rejects duplicate ID creation with conflict', async () => {
    const pool = createMockPool([sampleService]);
    await expect(createService(pool, sampleService)).rejects.toThrowError(ServiceError);
  });

  it('upserts with putService', async () => {
    const pool = createMockPool();
    const res1 = await putService(pool, sampleService.id, sampleService);
    expect(res1.created).toBe(true);
    expect(res1.service.id).toBe(sampleService.id);

    const res2 = await putService(pool, sampleService.id, {
      ...sampleService,
      name: 'Updated Name',
    });
    expect(res2.created).toBe(false);
    expect(res2.service.name).toBe('Updated Name');
  });

  it('patches an existing service', async () => {
    const pool = createMockPool([sampleService]);
    const patched = await patchService(pool, sampleService.id, { disabled: true });
    expect(patched.disabled).toBe(true);

    const check = await getService(pool, sampleService.id);
    expect(check?.disabled).toBe(true);
  });

  it('deletes a service', async () => {
    const pool = createMockPool([sampleService]);
    const deleted = await deleteService(pool, sampleService.id);
    expect(deleted).toBe(true);

    const check = await getService(pool, sampleService.id);
    expect(check).toBeNull();
  });

  it('provides the public discovery catalog excluding disabled items', async () => {
    const disabledService = {
      ...sampleService,
      id: 'kappeli-piprogram',
      disabled: true,
    };
    const pool = createMockPool([sampleService, disabledService]);

    const catalog = await getDiscoveryCatalog(pool);
    expect(catalog.services).toHaveLength(1);
    expect(catalog.services[0].id).toBe('keskuskirkko-piprogram');
    expect(catalog.services[0].url).toBe(sampleService.endpoint_url);
    expect(catalog.updated_at).toBeDefined();
  });
});
