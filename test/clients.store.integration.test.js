import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { createPool, migrate } from '../src/db.js';
import { createMetrics } from '../src/metrics.js';
import { ensureSigningKey } from '../src/oidc/keys.js';
import { createProviderHolder } from '../src/oidc/providerHolder.js';
import {
  adoptClient,
  ClientError,
  deleteClient,
  getClient,
  getClientVersion,
  listClientRecords,
  listClients,
  patchClient,
  putClient,
  rotateSecret,
  syncFromFile,
} from '../src/clients/store.js';

const SCHEMA = 'tunnus_clients_store_test';
const SECRET = 'test-key-encryption-secret-0123456789';

/** @type {import('pg').Pool} */
let pool;
/** @type {import('../src/config.js').Config} */
let config;

beforeAll(async () => {
  const url = /** @type {string} */ (process.env.DATABASE_URL);
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await admin.end();

  config = loadConfig({
    ISSUER: 'http://127.0.0.1:3000/id',
    DATABASE_URL: url,
    KEY_ENCRYPTION_SECRET: SECRET,
    COOKIE_SECRETS: 'cookie-secret-0123',
    KEY_RELOAD_INTERVAL_SECONDS: '0',
  });
  pool = createPool(url, SCHEMA);
  await migrate(pool);
  await ensureSigningKey(pool, SECRET);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('DELETE FROM oidc_clients');
  await pool.query('DELETE FROM oidc_payloads');
});

describe('clients store', () => {
  it('encrypts secrets at rest, bumps version, and handles idempotent put/patch/rotate/delete', async () => {
    expect(await getClientVersion(pool)).toBe('0');

    const secretA = 'a'.repeat(32);
    const created = await putClient(pool, SECRET, {
      clientId: 'store-app',
      metadata: {
        redirect_uris: ['https://store-app.example.org/cb'],
        token_endpoint_auth_method: 'client_secret_post',
        first_party: true,
      },
      clientSecret: secretA,
    });
    expect(created.created).toBe(true);
    expect(created.changed).toBe(true);
    expect(created.generatedSecret).toBeUndefined();
    expect(await getClientVersion(pool)).toBe('1');

    // Stored encrypted, never plaintext
    const raw = await pool.query('SELECT secret_enc FROM oidc_clients WHERE client_id = $1', [
      'store-app',
    ]);
    expect(raw.rows[0].secret_enc).toBeTruthy();
    expect(raw.rows[0].secret_enc).not.toContain(secretA);

    // listClientRecords and getClient do not decrypt or expose secret
    const rec = await getClient(pool, 'store-app');
    expect(rec).not.toBeNull();
    expect(JSON.stringify(rec)).not.toContain(secretA);
    expect(JSON.stringify(await listClientRecords(pool))).not.toContain(secretA);

    // listClients decrypts for providerHolder
    const decrypted = await listClients(pool, SECRET);
    expect(decrypted.find((c) => c.client_id === 'store-app')?.client_secret).toBe(secretA);

    // Idempotent PUT with exact same metadata and secret is a no-op (no version bump)
    const idem = await putClient(pool, SECRET, {
      clientId: 'store-app',
      metadata: {
        redirect_uris: ['https://store-app.example.org/cb'],
        token_endpoint_auth_method: 'client_secret_post',
        first_party: true,
      },
      clientSecret: secretA,
    });
    expect(idem.created).toBe(false);
    expect(idem.changed).toBe(false);
    expect(await getClientVersion(pool)).toBe('1');

    // Public client creation & refusal to become confidential without a secret
    const pub = await putClient(pool, SECRET, {
      clientId: 'pub-app',
      metadata: {
        redirect_uris: ['http://127.0.0.1:4100/cb'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(pub.created).toBe(true);
    expect(pub.generatedSecret).toBeUndefined();
    expect(pub.record.secret_set_at).toBeNull();

    await expect(
      putClient(pool, SECRET, {
        clientId: 'pub-app',
        metadata: {
          redirect_uris: ['http://127.0.0.1:4100/cb'],
          token_endpoint_auth_method: 'client_secret_post',
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    await expect(
      patchClient(pool, SECRET, {
        clientId: 'pub-app',
        patch: { token_endpoint_auth_method: 'client_secret_post' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    // Patch metadata + clear nullable fields
    await patchClient(pool, SECRET, {
      clientId: 'store-app',
      patch: {
        client_name: 'Store App',
        backchannel_logout_uri: 'https://store-app.example.org/logout',
      },
    });
    expect((await getClient(pool, 'store-app'))?.metadata.client_name).toBe('Store App');

    await patchClient(pool, SECRET, {
      clientId: 'store-app',
      patch: { client_name: null, backchannel_logout_uri: null },
    });
    const cleared = await getClient(pool, 'store-app');
    expect(cleared?.metadata.client_name).toBeUndefined();
    expect(cleared?.metadata.backchannel_logout_uri).toBeUndefined();

    // Rotate with revokeTokens deletes only that client's payloads/grants
    await pool.query(
      `INSERT INTO oidc_payloads (type, id, payload, grant_id) VALUES
         ('Grant', 'g-store', '{"clientId":"store-app"}', 'g-store'),
         ('RefreshToken', 'rt-store', '{"clientId":"store-app"}', 'g-store'),
         ('Grant', 'g-other', '{"clientId":"pub-app"}', 'g-other')`,
    );
    const rot = await rotateSecret(pool, SECRET, {
      clientId: 'store-app',
      revokeTokens: true,
    });
    expect(rot.generatedSecret).toBeTruthy();
    expect(rot.revoked).toBe(2);
    const remaining = await pool.query('SELECT id FROM oidc_payloads ORDER BY id');
    expect(remaining.rows.map((r) => r.id)).toEqual(['g-other']);

    // Delete revokes remaining payloads and removes row
    await deleteClient(pool, { clientId: 'pub-app' });
    expect(await getClient(pool, 'pub-app')).toBeNull();
    const afterDel = await pool.query('SELECT id FROM oidc_payloads');
    expect(afterDel.rows).toHaveLength(0);
    await deleteClient(pool, { clientId: 'store-app' });
  });

  it('enforces syncFromFile rules (file wins for file, api wins over file, removed disables)', async () => {
    const warnings = /** @type {any[]} */ ([]);
    const warnLogger = {
      warn: (/** @type {any} */ obj, /** @type {any} */ msg) => warnings.push({ obj, msg }),
    };

    // Seed three file clients: normal short-secret, enabled to-be-removed, and fallback disabled empty secret
    await syncFromFile(
      pool,
      [
        {
          client_id: 'file-one',
          client_secret: 'short-legacy',
          redirect_uris: ['https://file-one.example.org/cb'],
        },
        {
          client_id: 'file-two',
          client_secret: 'short-two',
          redirect_uris: ['https://file-two.example.org/cb'],
        },
        {
          client_id: 'file-fallback',
          client_secret: '',
          redirect_uris: ['https://file-fallback.example.org/cb'],
          disabled: true,
        },
      ],
      SECRET,
      warnLogger,
    );

    expect((await getClient(pool, 'file-one'))?.source).toBe('file');
    expect((await getClient(pool, 'file-fallback'))?.disabled).toBe(true);

    // File-managed client refuses mutations with 409 client_managed_by_file
    for (const op of [
      () =>
        putClient(pool, SECRET, {
          clientId: 'file-one',
          metadata: { redirect_uris: ['https://file-one.example.org/cb'] },
        }),
      () => patchClient(pool, SECRET, { clientId: 'file-one', patch: { client_name: 'X' } }),
      () => rotateSecret(pool, SECRET, { clientId: 'file-one' }),
      () => deleteClient(pool, { clientId: 'file-one' }),
    ]) {
      await expect(op()).rejects.toMatchObject({ code: 'client_managed_by_file' });
    }

    // Create an API client that collides with a file entry
    await putClient(pool, SECRET, {
      clientId: 'api-wins',
      metadata: { redirect_uris: ['https://api.example.org/cb'] },
      clientSecret: 'b'.repeat(32),
    });

    // Re-sync: file-one updated, api-wins skipped with warning, file-two removed -> disabled (not deleted)
    warnings.length = 0;
    const res = await syncFromFile(
      pool,
      [
        {
          client_id: 'file-one',
          client_secret: 'updated-legacy',
          redirect_uris: ['https://file-one.example.org/cb2'],
        },
        {
          client_id: 'file-fallback',
          client_secret: '',
          redirect_uris: ['https://file-fallback.example.org/cb'],
          disabled: true,
        },
        {
          client_id: 'api-wins',
          client_secret: 'file-override-should-lose',
          redirect_uris: ['https://wrong.example.org/cb'],
        },
      ],
      SECRET,
      warnLogger,
    );

    expect(res).toEqual({ synced: 1, disabled: 1, skippedApi: 1 });
    expect((await getClient(pool, 'file-one'))?.metadata.redirect_uris).toEqual([
      'https://file-one.example.org/cb2',
    ]);
    expect((await getClient(pool, 'api-wins'))?.metadata.redirect_uris).toEqual([
      'https://api.example.org/cb',
    ]);
    expect((await getClient(pool, 'file-two'))?.disabled).toBe(true);
    expect(warnings.some((w) => w.obj?.clientId === 'api-wins')).toBe(true);
    expect(warnings.some((w) => w.obj?.clientId === 'file-two')).toBe(true);

    const disabledAudit = await pool.query(
      "SELECT details FROM audit_events WHERE action = 'client.disabled' AND target_id = 'file-two' ORDER BY id DESC LIMIT 1",
    );
    expect(disabledAudit.rows[0].details).toEqual({ reason: 'removed_from_file' });

    // Adopt file-one -> api, then delete
    const adopted = await adoptClient(pool, { clientId: 'file-one' });
    expect(adopted.adopted).toBe(true);
    expect(adopted.record.source).toBe('api');
    expect((await adoptClient(pool, { clientId: 'file-one' })).adopted).toBe(false);

    // Clean up
    await deleteClient(pool, { clientId: 'file-one' });
    await deleteClient(pool, { clientId: 'api-wins' });
    await adoptClient(pool, { clientId: 'file-two' });
    await deleteClient(pool, { clientId: 'file-two' });
  });

  it('isolates invalid DB client rows in providerHolder without failing startup', async () => {
    await putClient(pool, SECRET, {
      clientId: 'healthy-client',
      metadata: { redirect_uris: ['https://healthy.example.org/cb'] },
      clientSecret: 'c'.repeat(32),
    });
    // Directly insert corrupt ciphertext row and invalid-metadata row bypassing API validation
    await pool.query(
      `INSERT INTO oidc_clients (client_id, metadata, secret_enc, source)
       VALUES
         ('bad-crypto', '{"redirect_uris":["https://bad.example.org/cb"]}'::jsonb, 'not-valid-base64-gcm', 'api'),
         ('bad-meta', '{"redirect_uris":["not-a-url"]}'::jsonb, NULL, 'api')`,
    );

    const errors = /** @type {any[]} */ ([]);
    const spyLogger = {
      error: (/** @type {any} */ obj, /** @type {any} */ msg) => errors.push({ obj, msg }),
    };
    const metrics = createMetrics();
    const holder = await createProviderHolder({ config, pool, metrics, logger: spyLogger });

    expect(holder.clients.map((c) => c.client_id)).toEqual(['healthy-client']);
    expect(holder.clients[0]).not.toHaveProperty('client_secret');
    expect(await holder.current.Client.find('healthy-client')).toBeDefined();
    expect(await holder.current.Client.find('bad-crypto')).toBeUndefined();
    expect(await holder.current.Client.find('bad-meta')).toBeUndefined();

    expect(errors.filter((e) => e.msg === 'client.invalid')).toHaveLength(2);
    const metricsText = await metrics.registry.metrics();
    expect(metricsText).toContain('tunnus_client_invalid_total 2');

    await holder.stop();
  });

  it('reloads via LISTEN/NOTIFY when keyReloadIntervalSeconds is 0', async () => {
    const holder = await createProviderHolder({ config, pool });
    await holder.start();
    try {
      const secret = 'notify-secret-0123456789abcdefghijkl';
      await putClient(pool, SECRET, {
        clientId: 'notify-client',
        metadata: { redirect_uris: ['https://notify.example.org/cb'] },
        clientSecret: secret,
      });
      await vi.waitFor(
        async () => {
          expect(holder.clients.some((c) => c.client_id === 'notify-client')).toBe(true);
          expect(await holder.current.Client.find('notify-client')).toBeDefined();
        },
        { timeout: 5000 },
      );
      await deleteClient(pool, { clientId: 'notify-client' });
      await vi.waitFor(
        async () => {
          expect(holder.clients.some((c) => c.client_id === 'notify-client')).toBe(false);
        },
        { timeout: 5000 },
      );
    } finally {
      await holder.stop();
    }
  });

  it('throws ClientError on unknown client', async () => {
    await expect(
      patchClient(pool, SECRET, { clientId: 'nope', patch: { first_party: true } }),
    ).rejects.toBeInstanceOf(ClientError);
    await expect(deleteClient(pool, { clientId: 'nope' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
