import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REDIRECT } from './helpers/harness.js';
import { startAdmin } from './helpers/admin.js';

const SECRET = 'rp-secret';

describe('clients (harness client)', () => {
  /** @type {Awaited<ReturnType<typeof startAdmin>>} */
  let t;

  beforeAll(async () => {
    t = await startAdmin({ schema: 'tunnus_clients_test' });
  });
  afterAll(async () => {
    await t.close();
  });

  it('lists the configured client with its settings and no secret', async () => {
    const res = await t.api('GET', '/clients');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(res.body.items).toEqual([
      {
        client_id: 'rp',
        redirect_uris: [REDIRECT],
        post_logout_redirect_uris: ['https://rp.example.org/bye'],
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code'],
        first_party: true,
        always_include_groups: true,
      },
    ]);
    expect(res.body.items[0]).not.toHaveProperty('client_secret');
  });
});

describe('clients (defaults)', () => {
  /** @type {Awaited<ReturnType<typeof startAdmin>>} */
  let t;
  const clientSecret = 'minimal-secret-value-456';

  beforeAll(async () => {
    t = await startAdmin({
      schema: 'tunnus_clients_defaults_test',
      clients: [
        {
          client_id: 'minimal',
          client_secret: clientSecret,
          redirect_uris: ['https://minimal.example.org/cb'],
        },
      ],
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('fills in defaults for optional settings and never returns the secret', async () => {
    const res = await t.api('GET', '/clients');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(clientSecret);
    expect(res.body.items).toEqual([
      {
        client_id: 'minimal',
        redirect_uris: ['https://minimal.example.org/cb'],
        post_logout_redirect_uris: [],
        token_endpoint_auth_method: 'client_secret_basic',
        grant_types: ['authorization_code'],
        first_party: false,
        always_include_groups: false,
      },
    ]);
  });
});
