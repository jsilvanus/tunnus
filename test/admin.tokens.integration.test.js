import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser } from '../src/accounts.js';
import { ADMIN_EMAIL, startAdmin } from './helpers/admin.js';

const TOKEN = /^tun_[A-Za-z0-9_-]{43}$/;
/** @type {Awaited<ReturnType<typeof startAdmin>>} */
let t;

beforeAll(async () => {
  t = await startAdmin({ schema: 'tunnus_admin_tokens_test' });
});
afterAll(async () => {
  await t.close();
});

/** @param {string} reason */
async function authFailures(reason) {
  const { rows } = await t.pool.query(
    "SELECT details, actor_user_id FROM audit_events WHERE action = 'admin.auth_failed' AND details->>'reason' = $1",
    [reason],
  );
  return rows;
}

/** Create a token through the API and return its value and id. */
async function newToken(label = 'test', extra = {}) {
  const res = await t.api('POST', '/admin-tokens', { body: { label, ...extra } });
  expect(res.status).toBe(201);
  return { value: /** @type {string} */ (res.body.token), id: /** @type {string} */ (res.body.id) };
}

describe('authentication', () => {
  it('rejects a missing header with 401, WWW-Authenticate and an audit row', async () => {
    const res = await t.api('GET', '/me', { token: null });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(res.body.error.code).toBe('unauthorized');
    const rows = await authFailures('missing');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].actor_user_id).toBeNull();
  });

  it('rejects a malformed token', async () => {
    const res = await t.api('GET', '/me', { token: 'Bearer-ish' });
    expect(res.status).toBe(401);
    expect(await authFailures('malformed')).toHaveLength(1);
  });

  it('rejects an unknown token of the right shape', async () => {
    const res = await t.api('GET', '/me', { token: `tun_${'a'.repeat(43)}` });
    expect(res.status).toBe(401);
    expect(await authFailures('unknown')).toHaveLength(1);
  });

  it('rejects an expired token', async () => {
    const { value, id } = await newToken('expiring');
    await t.pool.query(
      "UPDATE admin_tokens SET expires_at = now() - interval '1 day' WHERE id = $1",
      [id],
    );
    const res = await t.api('GET', '/me', { token: value });
    expect(res.status).toBe(401);
    expect(await authFailures('expired')).toHaveLength(1);
  });

  it('rejects a revoked token', async () => {
    const { value, id } = await newToken('revoking');
    expect((await t.api('DELETE', `/admin-tokens/${id}`)).status).toBe(204);
    const res = await t.api('GET', '/me', { token: value });
    expect(res.status).toBe(401);
    expect(await authFailures('revoked')).toHaveLength(1);
  });

  it('rejects a token whose user was demoted, and a disabled user', async () => {
    const demotedId = await createUser(t.pool, 'demoted@example.org', []);
    await t.pool.query('UPDATE users SET is_admin = true WHERE id = $1', [demotedId]);
    const { value: demotedToken } = await t
      .api('POST', '/admin-tokens', {
        body: { label: 'demoted', user_id: demotedId },
      })
      .then((r) => ({ value: r.body.token }));
    await t.pool.query('UPDATE users SET is_admin = false WHERE id = $1', [demotedId]);
    expect((await t.api('GET', '/me', { token: demotedToken })).status).toBe(401);
    expect(await authFailures('not_admin')).toHaveLength(1);

    const disabledId = await createUser(t.pool, 'disabled@example.org', []);
    await t.pool.query('UPDATE users SET is_admin = true WHERE id = $1', [disabledId]);
    const { body } = await t.api('POST', '/admin-tokens', {
      body: { label: 'disabled', user_id: disabledId },
    });
    await t.pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [disabledId]);
    expect((await t.api('GET', '/me', { token: body.token })).status).toBe(401);
    expect(await authFailures('disabled')).toHaveLength(1);
  });

  it('rejects an OIDC access token or any other non-tun_ string', async () => {
    const res = await t.api('GET', '/me', { token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig' });
    expect(res.status).toBe(401);
  });

  it('returns the caller and audits the call with the actor', async () => {
    const res = await t.api('GET', '/me');
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(ADMIN_EMAIL);
    expect(res.body.user.groups).toEqual(['all']);
    expect(res.body.user.is_admin).toBe(true);
    expect(res.body.token.id).toBeTruthy();
    expect(res.body.token).not.toHaveProperty('token');
    const { rows } = await t.pool.query(
      "SELECT actor_user_id, target_type FROM audit_events WHERE action = 'admin.getMe'",
    );
    expect(rows.at(-1)).toEqual({ actor_user_id: t.adminId, target_type: null });
  });

  it('updates last_used_at on use', async () => {
    const { value, id } = await newToken('usage');
    await t.api('GET', '/me', { token: value });
    const { rows } = await t.pool.query('SELECT last_used_at FROM admin_tokens WHERE id = $1', [
      id,
    ]);
    expect(rows[0].last_used_at).not.toBeNull();
  });
});

describe('admin tokens', () => {
  it('creates a token that matches the format and works, and never lists its value', async () => {
    const created = await t.api('POST', '/admin-tokens', {
      body: { label: 'ci', expires_in_days: 7 },
    });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(TOKEN);
    expect(created.body.created_by).toBe(t.adminId);
    expect(created.body.user_id).toBe(t.adminId);
    const listed = await t.api('GET', '/admin-tokens');
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.token);
    expect(listed.body.items.every((/** @type {any} */ item) => !('token' in item))).toBe(true);
    expect((await t.api('GET', '/me', { token: created.body.token })).status).toBe(200);
  });

  it('refuses a token for a user who is not an active admin', async () => {
    const plainId = await createUser(t.pool, 'plain@example.org', []);
    const res = await t.api('POST', '/admin-tokens', { body: { label: 'x', user_id: plainId } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
    const unknown = await t.api('POST', '/admin-tokens', {
      body: { label: 'x', user_id: '00000000-0000-4000-8000-000000000000' },
    });
    expect(unknown.status).toBe(404);
  });

  it('lists active tokens by default and includes inactive ones on request', async () => {
    const revoked = await newToken('listed-revoked');
    await t.api('DELETE', `/admin-tokens/${revoked.id}`);
    const expired = await newToken('listed-expired');
    await t.pool.query(
      "UPDATE admin_tokens SET expires_at = now() - interval '1 day' WHERE id = $1",
      [expired.id],
    );

    const active = await t.api('GET', '/admin-tokens');
    const activeIds = active.body.items.map((/** @type {any} */ i) => i.id);
    expect(activeIds).not.toContain(revoked.id);
    expect(activeIds).not.toContain(expired.id);

    const all = await t.api('GET', '/admin-tokens?include_inactive=true');
    const allIds = all.body.items.map((/** @type {any} */ i) => i.id);
    expect(allIds).toContain(revoked.id);
    expect(allIds).toContain(expired.id);
  });

  it('revokes idempotently and returns 404 for unknown ids', async () => {
    const { value, id } = await newToken('to-revoke');
    expect((await t.api('DELETE', `/admin-tokens/${id}`)).status).toBe(204);
    expect((await t.api('GET', '/me', { token: value })).status).toBe(401);
    expect((await t.api('DELETE', `/admin-tokens/${id}`)).status).toBe(204);
    const missing = await t.api('DELETE', '/admin-tokens/00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
  });
});

describe('request validation', () => {
  it('rejects a malformed path id with details', async () => {
    const res = await t.api('DELETE', '/admin-tokens/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
    expect(res.body.error.details).toEqual([expect.objectContaining({ path: '/tokenId' })]);
  });

  it('rejects an unknown body property', async () => {
    const res = await t.api('POST', '/admin-tokens', { body: { label: 'x', admin: true } });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('/admin');
  });

  it('rejects a missing required body and invalid JSON', async () => {
    const none = await t.api('POST', '/admin-tokens', { token: t.token });
    expect(none.status).toBe(400);
    const broken = await t.api('POST', '/admin-tokens', { raw: '{"label":' });
    expect(broken.status).toBe(400);
    expect(broken.body.error.code).toBe('invalid_request');
  });

  it('rejects an empty JSON body where one is required, and a body where none is allowed', async () => {
    const empty = await t.api('POST', '/admin-tokens', {
      raw: '',
      headers: { 'content-type': 'application/json' },
    });
    expect(empty.status).toBe(400);
    const unexpected = await t.api('DELETE', '/admin-tokens/00000000-0000-4000-8000-000000000000', {
      body: { surprise: true },
    });
    expect(unexpected.status).toBe(400);
    expect(unexpected.body.error.code).toBe('invalid_request');
  });

  it('treats an empty JSON request as bodyless', async () => {
    // POST /keys/rotate takes no body; it is a stub, so 501 shows the body check passed.
    const res = await t.api('POST', '/keys/rotate', {
      raw: '',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(501);
  });

  it('rejects an unknown query parameter and a badly typed one', async () => {
    expect((await t.api('GET', '/admin-tokens?foo=1')).status).toBe(400);
    const typed = await t.api('GET', '/admin-tokens?include_inactive=maybe');
    expect(typed.status).toBe(400);
  });

  it('serves the spec without authentication', async () => {
    const res = await t.api('GET', '/openapi.yaml', { token: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/yaml');
    expect(res.body).toContain('openapi: 3.1.0');
  });

  it('answers unknown admin paths with 404 JSON when authenticated', async () => {
    const res = await t.api('GET', '/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('stubs', () => {
  // Other handlers are not written yet. Delete this test when the users, groups, keys, audit and clients handlers land.
  it('stubs return 501', async () => {
    const res = await t.api('GET', '/users');
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('not_implemented');
  });
});
