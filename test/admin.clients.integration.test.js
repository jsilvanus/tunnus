import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as client from 'openid-client';
import { POST_LOGOUT, REDIRECT, browser, signInThrough } from './helpers/harness.js';
import { startAdmin } from './helpers/admin.js';

const SECRET = 'rp-secret';
const METRICS_TOKEN = 'clients-metrics-token-secret';

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
        post_logout_redirect_uris: [POST_LOGOUT],
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        first_party: true,
        always_include_groups: true,
        allowed_resources: [],
        backchannel_logout_uri: null,
        backchannel_logout_session_required: null,
        id_token_signed_response_alg: 'RS256',
        client_name: null,
        source: 'file',
        disabled: false,
        secret_set_at: expect.any(String),
        created_at: expect.any(String),
        updated_at: expect.any(String),
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
        response_types: ['code'],
        first_party: false,
        always_include_groups: false,
        allowed_resources: [],
        backchannel_logout_uri: null,
        backchannel_logout_session_required: null,
        id_token_signed_response_alg: 'RS256',
        client_name: null,
        source: 'file',
        disabled: false,
        secret_set_at: expect.any(String),
        created_at: expect.any(String),
        updated_at: expect.any(String),
      },
    ]);
  });
});

describe('clients admin API (CRUD, live OIDC flow, audit, metrics)', () => {
  /** @type {Awaited<ReturnType<typeof startAdmin>>} */
  let t;

  beforeAll(async () => {
    t = await startAdmin({
      schema: 'tunnus_clients_crud_test',
      env: { METRICS_BEARER_TOKEN: METRICS_TOKEN, KEY_RELOAD_INTERVAL_SECONDS: '0' },
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('creates, reads, updates, rotates, adopts, and deletes clients with full validation', async () => {
    // 1. PUT create confidential client without secret -> 201 with generated secret once
    const createdGen = await t.api('PUT', '/clients/gen-app', {
      body: {
        redirect_uris: ['http://localhost:3000/cb', 'http://127.0.0.1:8080/cb'],
        token_endpoint_auth_method: 'client_secret_post',
        first_party: true,
        client_name: 'Generated App',
      },
    });
    expect(createdGen.status).toBe(201);
    expect(createdGen.body.source).toBe('api');
    expect(createdGen.body.client_secret).toBeTypeOf('string');
    expect(createdGen.body.client_secret.length).toBeGreaterThanOrEqual(32);

    // GET never returns secret
    const got = await t.api('GET', '/clients/gen-app');
    expect(got.status).toBe(200);
    expect(got.body).not.toHaveProperty('client_secret');
    expect(JSON.stringify(got.body)).not.toContain(createdGen.body.client_secret);

    // 2. PUT create confidential with supplied secret -> 201 without secret in response
    const supplied = 'supplied-client-secret-0123456789abcdef';
    const createdSupplied = await t.api('PUT', '/clients/sup-app', {
      body: {
        redirect_uris: ['https://sup.example.org/cb'],
        token_endpoint_auth_method: 'client_secret_post',
        client_secret: supplied,
        backchannel_logout_uri: 'https://sup.example.org/logout',
      },
    });
    expect(createdSupplied.status).toBe(201);
    expect(createdSupplied.body).not.toHaveProperty('client_secret');

    // Idempotent re-PUT keeps updated_at / secret_set_at unchanged
    const idem = await t.api('PUT', '/clients/sup-app', {
      body: {
        redirect_uris: ['https://sup.example.org/cb'],
        token_endpoint_auth_method: 'client_secret_post',
        client_secret: supplied,
        backchannel_logout_uri: 'https://sup.example.org/logout',
      },
    });
    expect(idem.status).toBe(200);
    expect(idem.body.updated_at).toBe(createdSupplied.body.updated_at);
    expect(idem.body.secret_set_at).toBe(createdSupplied.body.secret_set_at);

    // Replace metadata without client_secret keeps current secret
    const replaced = await t.api('PUT', '/clients/sup-app', {
      body: {
        redirect_uris: ['https://sup.example.org/cb2'],
        token_endpoint_auth_method: 'client_secret_post',
        backchannel_logout_uri: 'https://sup.example.org/logout',
      },
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body.redirect_uris).toEqual(['https://sup.example.org/cb2']);
    expect(replaced.body.secret_set_at).toBe(createdSupplied.body.secret_set_at);

    // 3. Public client (`none`)
    const pub = await t.api('PUT', '/clients/pub-cli', {
      body: {
        redirect_uris: ['http://127.0.0.1:9000/cb'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(pub.status).toBe(201);
    expect(pub.body.secret_set_at).toBeNull();
    expect(pub.body).not.toHaveProperty('client_secret');

    // Reject public -> confidential without secret
    const pubToConf = await t.api('PUT', '/clients/pub-cli', {
      body: {
        redirect_uris: ['http://127.0.0.1:9000/cb'],
        token_endpoint_auth_method: 'client_secret_post',
      },
    });
    expect(pubToConf.status).toBe(400);

    // Reject public client with secret
    const pubWithSec = await t.api('PUT', '/clients/pub-bad', {
      body: {
        redirect_uris: ['http://localhost:9000/cb'],
        token_endpoint_auth_method: 'none',
        client_secret: 'x'.repeat(32),
      },
    });
    expect(pubWithSec.status).toBe(400);

    // Reject unknown property, invalid URL, short secret
    const badKey = await t.api('PUT', '/clients/bad-key', {
      body: { redirect_uris: ['https://ok.example.org/cb'], extra_field: true },
    });
    expect(badKey.status).toBe(400);
    expect(badKey.body.error.code).toBe('invalid_request');

    const badUrl = await t.api('PUT', '/clients/bad-url', {
      body: { redirect_uris: ['http://evil.example.org/cb'] },
    });
    expect(badUrl.status).toBe(400);

    const shortSec = await t.api('PUT', '/clients/short-sec', {
      body: { redirect_uris: ['https://ok.example.org/cb'], client_secret: 'short' },
    });
    expect(shortSec.status).toBe(400);

    // 4. PATCH partial metadata, clear nullable fields, disable toggle, reject client_secret
    const patched = await t.api('PATCH', '/clients/sup-app', {
      body: {
        client_name: 'Supplied App',
        backchannel_logout_uri: null,
        disabled: true,
      },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.client_name).toBe('Supplied App');
    expect(patched.body.backchannel_logout_uri).toBeNull();
    expect(patched.body.disabled).toBe(true);
    expect(await t.holder.current.Client.find('sup-app')).toBeUndefined();

    const patchWithSecret = await t.api('PATCH', '/clients/sup-app', {
      body: { client_secret: 'z'.repeat(32) },
    });
    expect(patchWithSecret.status).toBe(400);

    // 5. Rotate secret
    const rotatedGen = await t.api('POST', '/clients/gen-app/secret');
    expect(rotatedGen.status).toBe(200);
    expect(rotatedGen.body.client_secret).toBeTypeOf('string');
    expect(rotatedGen.body.client_secret).not.toBe(createdGen.body.client_secret);

    const nextSupplied = 'rotated-supplied-secret-0123456789abcdef';
    const rotatedSup = await t.api('POST', '/clients/gen-app/secret', {
      body: { client_secret: nextSupplied, revoke_tokens: true },
    });
    expect(rotatedSup.status).toBe(200);
    expect(rotatedSup.body).not.toHaveProperty('client_secret');

    // Rotating public client fails 400
    expect((await t.api('POST', '/clients/pub-cli/secret')).status).toBe(400);

    // 6. 404 unknown client
    expect((await t.api('GET', '/clients/missing-app')).status).toBe(404);
    expect(
      (await t.api('PATCH', '/clients/missing-app', { body: { disabled: true } })).status,
    ).toBe(404);
    expect((await t.api('POST', '/clients/missing-app/secret')).status).toBe(404);
    expect((await t.api('POST', '/clients/missing-app/adopt')).status).toBe(404);
    expect((await t.api('DELETE', '/clients/missing-app')).status).toBe(404);

    // 7. 409 client_managed_by_file on file-seeded `rp`, then adopt -> mutable
    const rpPut = await t.api('PUT', '/clients/rp', {
      body: { redirect_uris: [REDIRECT] },
    });
    expect(rpPut.status).toBe(409);
    expect(rpPut.body.error.code).toBe('client_managed_by_file');
    expect((await t.api('PATCH', '/clients/rp', { body: { client_name: 'RP' } })).status).toBe(409);
    expect((await t.api('POST', '/clients/rp/secret')).status).toBe(409);
    expect((await t.api('DELETE', '/clients/rp')).status).toBe(409);

    const adopted = await t.api('POST', '/clients/rp/adopt');
    expect(adopted.status).toBe(200);
    expect(adopted.body.source).toBe('api');

    // Now rp can be patched
    const rpPatched = await t.api('PATCH', '/clients/rp', {
      body: { client_name: 'Adopted RP' },
    });
    expect(rpPatched.status).toBe(200);
    expect(rpPatched.body.client_name).toBe('Adopted RP');

    // 8. Delete API client
    expect((await t.api('DELETE', '/clients/pub-cli')).status).toBe(204);
    expect((await t.api('GET', '/clients/pub-cli')).status).toBe(404);

    // 9. Audit log checks: domain events exist and NO plaintext secrets leaked anywhere
    const { rows: auditRows } = await t.pool.query(
      "SELECT action, target_id, details FROM audit_events WHERE target_type = 'client' AND action LIKE 'client.%' ORDER BY id",
    );
    const actions = new Set(auditRows.map((r) => r.action));
    expect(actions).toEqual(
      new Set([
        'client.synced_from_file',
        'client.created',
        'client.updated',
        'client.disabled',
        'client.secret_rotated',
        'client.adopted',
        'client.deleted',
      ]),
    );
    const redirectAudit = auditRows.find(
      (r) => r.action === 'client.updated' && r.target_id === 'sup-app' && r.details?.redirect_uris,
    );
    expect(redirectAudit?.details.redirect_uris).toEqual({
      old: ['https://sup.example.org/cb'],
      new: ['https://sup.example.org/cb2'],
    });
    const serializedAudits = JSON.stringify(auditRows);
    for (const sec of [
      createdGen.body.client_secret,
      supplied,
      rotatedGen.body.client_secret,
      nextSupplied,
    ]) {
      expect(serializedAudits).not.toContain(sec);
    }

    // 10. Metrics scrape checks
    const metricsRes = await fetch(`${t.issuer}/metrics`, {
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(metricsRes.status).toBe(200);
    const metricsText = await metricsRes.text();
    expect(metricsText).toContain('tunnus_clients{source="api",disabled="false"}');
    expect(metricsText).toContain('tunnus_clients{source="api",disabled="true"}');
    expect(metricsText).toMatch(/tunnus_client_reloads_total [1-9]\d*/);
  });

  it('allows OIDC login, token exchange, and refresh without restart, and rejects refresh after delete', async () => {
    const liveRedirect = `${REDIRECT}/live`;
    const created = await t.api('PUT', '/clients/live-app', {
      body: {
        redirect_uris: [liveRedirect],
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code', 'refresh_token'],
        first_party: true,
        always_include_groups: true,
      },
    });
    expect(created.status).toBe(201);
    const liveSecret = created.body.client_secret;

    const rp = await client.discovery(
      new URL(t.issuer),
      'live-app',
      { client_secret: liveSecret },
      client.ClientSecretPost(liveSecret),
      { execute: [client.allowInsecureRequests] },
    );

    const b = browser();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const authUrl = client.buildAuthorizationUrl(rp, {
      redirect_uri: liveRedirect,
      scope: 'openid email profile offline_access',
      prompt: 'consent',
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
    });
    const page = await b.go(authUrl.href);
    const path = /** @type {string} */ (t.interactionPath(page.body));
    const done = await signInThrough(t, b, path, 'live.client@example.org', 'Live Client');
    expect(done.finalUrl.startsWith(liveRedirect)).toBe(true);

    const tokens = await client.authorizationCodeGrant(rp, new URL(done.finalUrl), {
      pkceCodeVerifier: verifier,
      expectedState: state,
      idTokenExpected: true,
    });
    expect(tokens.id_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();

    // Refresh works while client exists
    const refreshed = await client.refreshTokenGrant(
      rp,
      /** @type {string} */ (tokens.refresh_token),
    );
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.refresh_token).toBeTruthy();

    // Delete client via admin API -> refresh token is immediately rejected without restart
    const del = await t.api('DELETE', '/clients/live-app');
    expect(del.status).toBe(204);

    await expect(
      client.refreshTokenGrant(rp, /** @type {string} */ (refreshed.refresh_token)),
    ).rejects.toThrow();

    // Verify payloads were cleaned up
    const { rows } = await t.pool.query(
      "SELECT count(*)::int AS n FROM oidc_payloads WHERE payload->>'clientId' = 'live-app'",
    );
    expect(rows[0].n).toBe(0);
    // Avoid unused warning if vi imported for waitFor compatibility
    expect(vi).toBeDefined();
  });
});
