import { describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { once } from 'node:events';
import { createDiscoveryRouter } from '../src/web/discovery.js';

async function request(app, path, headers = {}) {
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, headers: res.headers, text, body };
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

describe('Discovery Web Router', () => {
  const sampleRows = [
    {
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
      max_updated_at: new Date('2026-11-20T10:00:00Z'),
    },
    {
      id: 'sissi-signage',
      name: 'Kyltti / Sissi Infonäytöt',
      type: 'signage',
      venue: 'parish-wide',
      endpoint_url: 'https://kehitys.riihimaenseurakunta.fi/sissi',
      auth: { type: 'oidc', client_id: 'canva-sissi' },
      capabilities: ['screen_push'],
      metadata: {},
      disabled: false,
      created_at: new Date('2026-11-21T10:00:00Z'),
      updated_at: new Date('2026-11-21T10:00:00Z'),
      max_updated_at: new Date('2026-11-21T10:00:00Z'),
    },
  ];

  function createMockPool() {
    return {
      async query(sql, params = []) {
        let rows = [...sampleRows];
        if (sql.includes('type = $')) {
          rows = rows.filter((r) => r.type === params[0]);
        }
        return { rows };
      },
    };
  }

  it('GET /api/v1/discovery returns services catalog and ETag', async () => {
    const app = express();
    app.use(createDiscoveryRouter({ pool: createMockPool() }));

    const res = await request(app, '/api/v1/discovery');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('etag')).toBeDefined();
    expect(res.body.services).toHaveLength(2);
    expect(res.body.services[0].id).toBe('keskuskirkko-piprogram');
    expect(res.body.services[0].url).toBe('https://gateway.keskuskirkko.riihimaenseurakunta.fi:8443/program');
  });

  it('GET /api/v1/discovery/:type filters by service type', async () => {
    const app = express();
    app.use(createDiscoveryRouter({ pool: createMockPool() }));

    const res = await request(app, '/api/v1/discovery/piprogram');
    expect(res.status).toBe(200);
    expect(res.body.services).toHaveLength(1);
    expect(res.body.services[0].type).toBe('piprogram');
  });

  it('returns 304 Not Modified when If-None-Match matches ETag', async () => {
    const app = express();
    app.use(createDiscoveryRouter({ pool: createMockPool() }));

    const first = await request(app, '/api/v1/discovery');
    const etag = first.headers.get('etag');
    expect(etag).toBeDefined();

    const second = await request(app, '/api/v1/discovery', { 'If-None-Match': etag });
    expect(second.status).toBe(304);
  });
});
