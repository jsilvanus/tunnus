import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createDiscoveryClient,
  startServiceDiscovery,
  fetchDiscoveryCatalog,
} from '../src/client/discovery.js';

describe('Discovery Client Module', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  const validOptions = {
    tunnusUrl: 'https://tunnus.riihimaenseurakunta.fi',
    clientId: 'client-sissi',
    clientSecret: 'secret-123456',
    service: {
      id: 'sissi-signage',
      name: 'Kyltti / Sissi Infonäytöt',
      type: 'signage',
      venue: 'parish-wide',
      endpointUrl: 'https://kehitys.riihimaenseurakunta.fi/sissi',
      auth: { type: 'oidc' },
      capabilities: ['screen_push', 'export_target'],
      metadata: { default_view: 'parish_bulletin' },
    },
    heartbeatIntervalSec: 60,
    retryIntervalSec: 5,
    autoDeregisterOnShutdown: false,
  };

  it('validates required configuration', () => {
    expect(() => createDiscoveryClient({ ...validOptions, clientId: '' })).toThrow(/clientId/);
    expect(() => createDiscoveryClient({ ...validOptions, clientSecret: '' })).toThrow(/clientSecret/);
    expect(() =>
      createDiscoveryClient({ ...validOptions, service: { ...validOptions.service, id: '' } }),
    ).toThrow(/service\.id/);
    expect(() =>
      createDiscoveryClient({ ...validOptions, service: { ...validOptions.service, endpointUrl: '' } }),
    ).toThrow(/service\.endpoint_url/);
  });

  it('normalizes camelCase endpointUrl and sets oidc client_id default', async () => {
    let capturedReq = null;
    const mockFetch = vi.fn(async (url, init) => {
      capturedReq = { url, init };
      return {
        ok: true,
        status: 201,
        json: async () => ({ id: 'sissi-signage' }),
      };
    });

    const client = createDiscoveryClient({
      ...validOptions,
      fetch: mockFetch,
    });

    await client.register();

    expect(capturedReq.url).toBe(
      'https://tunnus.riihimaenseurakunta.fi/api/v1/discovery/services/sissi-signage',
    );
    expect(capturedReq.init.method).toBe('PUT');
    expect(capturedReq.init.headers.Authorization).toMatch(/^Basic /);

    const body = JSON.parse(capturedReq.init.body);
    expect(body.endpoint_url).toBe('https://kehitys.riihimaenseurakunta.fi/sissi');
    expect(body.auth.type).toBe('oidc');
    expect(body.auth.client_id).toBe('client-sissi');
    expect(client.state.isRegistered).toBe(true);
    expect(client.state.lastHeartbeatAt).toBeInstanceOf(Date);
  });

  it('runs periodic heartbeat at configured interval', async () => {
    const calls = [];
    const mockFetch = vi.fn(async (url, init) => {
      calls.push({ url, method: init?.method || 'GET' });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, updated_at: new Date().toISOString() }),
      };
    });

    const client = await startServiceDiscovery({
      ...validOptions,
      heartbeatIntervalSec: 30,
      fetch: mockFetch,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PUT');

    // Advance time by 30 seconds
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe('POST');
    expect(calls[1].url).toContain('/services/sissi-signage/heartbeat');

    // Advance time by another 30 seconds
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(3);
    expect(calls[2].method).toBe('POST');

    client.stop();
  });

  it('re-registers if heartbeat returns 404 (service lost on server restart)', async () => {
    const methods = [];
    const mockFetch = vi.fn(async (url, init) => {
      const method = init?.method || 'GET';
      methods.push(method);

      if (method === 'POST') {
        // Return 404 on heartbeat
        return {
          ok: false,
          status: 404,
          text: async () => 'Not found',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'sissi-signage' }),
      };
    });

    const client = await startServiceDiscovery({
      ...validOptions,
      heartbeatIntervalSec: 10,
      fetch: mockFetch,
    });

    expect(methods).toEqual(['PUT']);

    // Trigger heartbeat (which returns 404)
    await vi.advanceTimersByTimeAsync(10_000);
    expect(methods).toEqual(['PUT', 'POST']);

    // Re-registration should be scheduled after 1s
    await vi.advanceTimersByTimeAsync(1000);
    expect(methods).toEqual(['PUT', 'POST', 'PUT']);

    client.stop();
  });

  it('handles background retry if initial registration fails with network error', async () => {
    let attempt = 0;
    const mockFetch = vi.fn(async () => {
      attempt++;
      if (attempt === 1) {
        return {
          ok: false,
          status: 503,
          text: async () => 'Service unavailable',
        };
      }
      return {
        ok: true,
        status: 201,
        json: async () => ({ id: 'sissi-signage' }),
      };
    });

    const client = createDiscoveryClient({
      ...validOptions,
      retryIntervalSec: 5,
      fetch: mockFetch,
    });

    // start() does not throw for 5xx/network errors, but schedules background retry
    await client.start();
    expect(client.state.isRegistered).toBe(false);

    // Advance time to retry
    await vi.advanceTimersByTimeAsync(5000);
    expect(attempt).toBe(2);
    expect(client.state.isRegistered).toBe(true);

    client.stop();
  });

  it('throws immediately on start() if authentication is rejected (401)', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: 'invalid_client', message: 'Bad credentials' }),
    }));

    const client = createDiscoveryClient({
      ...validOptions,
      fetch: mockFetch,
    });

    await expect(client.start()).rejects.toThrow(/Failed to register service/);
    expect(client.state.isRegistered).toBe(false);
  });

  it('deregisters cleanly via DELETE', async () => {
    let deleted = false;
    const mockFetch = vi.fn(async (url, init) => {
      if (init?.method === 'DELETE') {
        deleted = true;
        return { ok: true, status: 204 };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'sissi-signage' }),
      };
    });

    const client = await startServiceDiscovery({
      ...validOptions,
      fetch: mockFetch,
    });

    expect(client.state.isRegistered).toBe(true);

    const result = await client.deregister();
    expect(result).toBe(true);
    expect(deleted).toBe(true);
    expect(client.state.isRegistered).toBe(false);
  });

  it('fetchDiscoveryCatalog queries catalog with filters', async () => {
    let capturedUrl = '';
    const mockFetch = vi.fn(async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ updated_at: '2026-11-25T15:00:00Z', services: [] }),
      };
    });

    const result = await fetchDiscoveryCatalog({
      tunnusUrl: 'https://tunnus.riihimaenseurakunta.fi',
      type: 'signage',
      capability: 'export_target',
      fetch: mockFetch,
    });

    expect(capturedUrl).toBe(
      'https://tunnus.riihimaenseurakunta.fi/api/v1/discovery?type=signage&capability=export_target',
    );
    expect(result.services).toBeDefined();
  });
});
