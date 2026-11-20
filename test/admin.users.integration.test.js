import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as client from 'openid-client';
import { ADMIN_EMAIL, startAdmin } from './helpers/admin.js';
import { POST_LOGOUT, REDIRECT, browser } from './helpers/harness.js';

// A relying party that may refresh tokens, so the sign-in tests can check refresh-token revocation.
// oidc-provider grants offline_access only when the request also asks for consent.
const OFFLINE = { scope: 'openid email profile offline_access', prompt: 'consent' };

const RP = {
  client_id: 'rp',
  client_secret: 'rp-secret',
  redirect_uris: [REDIRECT],
  post_logout_redirect_uris: [POST_LOGOUT],
  token_endpoint_auth_method: 'client_secret_post',
  grant_types: ['authorization_code', 'refresh_token'],
  first_party: true,
  always_include_groups: true,
};

/** @type {Awaited<ReturnType<typeof startAdmin>>} */
let t;
/** The admin token the tests call with. The last-admin tests change which admin it belongs to. */
let token = '';

beforeAll(async () => {
  t = await startAdmin({ schema: 'tunnus_admin_users_test', clients: [RP] });
  token = t.token;
});
afterAll(async () => {
  await t.close();
});

/**
 * @param {string} method
 * @param {string} path
 * @param {{ body?: unknown, raw?: string, token?: string | null }} [opts]
 */
const api = (method, path, opts = {}) => t.api(method, path, { token, ...opts });

/**
 * Create a user through the API and return the body.
 * @param {string} email
 * @param {Record<string, unknown>} [extra]
 */
async function makeUser(email, extra = {}) {
  const res = await api('POST', '/users', { body: { email, ...extra } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return /** @type {any} */ (res.body);
}

/**
 * Sign a user in through the browser flow (email code) and exchange the code for tokens.
 * @param {string} email
 * @param {ReturnType<typeof browser>} [b]
 */
async function signIn(email, b = browser()) {
  const { page, verifier, state } = await t.startAuth(b, OFFLINE);
  const path = t.interactionPath(page.body);
  expect(path, page.body).toBeTruthy();
  const before = t.mails.length;
  await b.post(`${t.origin}${path}/email`, { email });
  await vi.waitFor(() => expect(t.mails.length).toBe(before + 1));
  const code = /** @type {any} */ (t.mails.at(-1)).code;
  let done = await b.post(`${t.origin}${path}/code`, { code });
  if (!done.finalUrl.startsWith(REDIRECT)) {
    // prompt=consent asks the user to confirm the grant, including offline_access.
    // The consent step has its own interaction id, so post to the form's action.
    const action = /action="([^"]+\/confirm)"/.exec(done.body)?.[1];
    expect(action, done.body).toBeTruthy();
    done = await b.post(`${t.origin}${action}`, {});
  }
  expect(done.finalUrl.startsWith(REDIRECT)).toBe(true);
  const tokens = await t.exchange(done.finalUrl, verifier, state);
  return { b, tokens, sub: /** @type {any} */ (tokens.claims()).sub };
}

/** @param {string} accountId */
async function oidcRows(accountId) {
  const { rows } = await t.pool.query(
    "SELECT count(*)::int AS n FROM oidc_payloads WHERE payload->>'accountId' = $1",
    [accountId],
  );
  return rows[0].n;
}

/** @param {string} email */
async function userRow(email) {
  const { rows } = await t.pool.query('SELECT id, status, is_admin FROM users WHERE email = $1', [
    email,
  ]);
  return rows[0];
}

describe('create and read', () => {
  it('creates a user with a derived name, lowercases the email and joins the default group', async () => {
    const res = await api('POST', '/users', { body: { email: 'Anna.Virtanen@Example.org' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      email: 'anna.virtanen@example.org',
      display_name: 'Anna Virtanen',
      status: 'active',
      is_admin: false,
      last_login_at: null,
      groups: ['all'],
    });
    const audit = await t.pool.query(
      "SELECT target_type, target_id, details FROM audit_events WHERE action = 'admin.createUser' ORDER BY id DESC LIMIT 1",
    );
    expect(audit.rows[0]).toEqual({
      target_type: 'user',
      target_id: res.body.id,
      details: { status: 201, is_admin: false },
    });
  });

  it('allows any email domain and an explicit display name', async () => {
    const user = await makeUser('someone@other.example', { display_name: 'Other Person' });
    expect(user.email).toBe('someone@other.example');
    expect(user.display_name).toBe('Other Person');
  });

  it('answers 409 conflict for an email that already exists, whatever its case', async () => {
    const res = await api('POST', '/users', { body: { email: 'ANNA.virtanen@example.org' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });

  it('rejects an invalid email and unknown properties with 400', async () => {
    const bad = await api('POST', '/users', { body: { email: 'not-an-email' } });
    expect(bad.status).toBe(400);
    const extra = await api('POST', '/users', { body: { email: 'x@example.org', role: 'x' } });
    expect(extra.status).toBe(400);
  });

  it('gets a user, 404 for an unknown id, 400 for a malformed one', async () => {
    const created = await makeUser('get.me@example.org');
    const res = await api('GET', `/users/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.id);
    const missing = await api('GET', '/users/00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
    expect((await api('GET', '/users/not-a-uuid')).status).toBe(400);
  });
});

describe('list', () => {
  const pagerEmails = [1, 2, 3, 4, 5].map((i) => `pager${i}@example.org`);

  beforeAll(async () => {
    for (const email of pagerEmails) await makeUser(email);
    await makeUser('under_score@example.org');
    const disabled = await makeUser('status.user@example.org');
    await api('PATCH', `/users/${disabled.id}`, { body: { status: 'disabled' } });
  });

  it('pages through matches two at a time, with next_cursor null on the last page', async () => {
    const seen = [];
    const sizes = [];
    let cursor = null;
    /** @type {any} */
    let last;
    do {
      const qs = `/users?q=pager&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      last = await api('GET', qs);
      expect(last.status).toBe(200);
      sizes.push(last.body.items.length);
      seen.push(...last.body.items.map((/** @type {any} */ u) => u.email));
      cursor = last.body.next_cursor;
    } while (cursor);
    expect(sizes).toEqual([2, 2, 1]);
    expect(last.body.next_cursor).toBeNull();
    expect(seen).toEqual(pagerEmails);
  });

  it('filters by exact email, ignoring case', async () => {
    const res = await api('GET', '/users?email=PAGER3@Example.org');
    expect(res.body.items.map((/** @type {any} */ u) => u.email)).toEqual(['pager3@example.org']);
  });

  it('matches q literally, so % and _ are not wildcards', async () => {
    const underscore = await api('GET', '/users?q=_');
    expect(underscore.body.items.map((/** @type {any} */ u) => u.email)).toEqual([
      'under_score@example.org',
    ]);
    const percent = await api('GET', '/users?q=%25');
    expect(percent.body.items).toEqual([]);
  });

  it('filters by status', async () => {
    const res = await api('GET', '/users?status=disabled');
    const emails = res.body.items.map((/** @type {any} */ u) => u.email);
    expect(emails).toEqual(['status.user@example.org']);
    expect(res.body.items.every((/** @type {any} */ u) => u.status === 'disabled')).toBe(true);
  });

  it('filters by admin flag and by group', async () => {
    const admins = await api('GET', '/users?is_admin=true');
    expect(admins.body.items.every((/** @type {any} */ u) => u.is_admin)).toBe(true);
    expect(admins.body.items.map((/** @type {any} */ u) => u.email)).toContain(ADMIN_EMAIL);

    const { rows } = await t.pool.query("SELECT id FROM groups WHERE name = 'all'");
    const inAll = await api('GET', `/users?group_id=${rows[0].id}&limit=200`);
    const emails = inAll.body.items.map((/** @type {any} */ u) => u.email);
    expect(emails).toEqual(expect.arrayContaining([...pagerEmails, ADMIN_EMAIL]));

    const none = await api('GET', '/users?group_id=999999');
    expect(none.body).toEqual({ items: [], next_cursor: null });
  });

  it('filters users by a slash-boundary-aware group path prefix and combines filters', async () => {
    const root = await t.api('POST', '/groups', { body: { name: 'parish/riihimäki' } });
    const child = await t.api('POST', '/groups', { body: { name: 'parish/riihimäki/staff' } });
    const sibling = await t.api('POST', '/groups', { body: { name: 'parish/riihimäkix/staff' } });
    expect(root.status).toBe(201);
    expect(child.status).toBe(201);
    expect(sibling.status).toBe(201);

    const inRoot = await makeUser('prefix.root@example.org');
    const inChild = await makeUser('prefix.child@example.org');
    const outside = await makeUser('prefix.outside@example.org');
    await api('PUT', `/groups/${root.body.id}/members/${inRoot.id}`);
    await api('PUT', `/groups/${child.body.id}/members/${inChild.id}`);
    await api('PUT', `/groups/${sibling.body.id}/members/${outside.id}`);

    const found = await api('GET', '/users?group_prefix=' + encodeURIComponent('parish/riihimäki'));
    expect(found.body.items.map((/** @type {any} */ u) => u.email)).toEqual([
      'prefix.child@example.org',
      'prefix.root@example.org',
    ]);

    const combined = await api(
      'GET',
      '/users?group_prefix=' + encodeURIComponent('parish/riihimäki') +
        '&email=PREFIX.CHILD%40EXAMPLE.ORG&status=active',
    );
    expect(combined.body.items.map((/** @type {any} */ u) => u.email)).toEqual([
      'prefix.child@example.org',
    ]);
    const exactAndPrefix = await api(
      'GET',
      `/users?group_id=${child.body.id}&group_prefix=` + encodeURIComponent('parish/riihimäki'),
    );
    expect(exactAndPrefix.body.items.map((/** @type {any} */ u) => u.email)).toEqual([
      'prefix.child@example.org',
    ]);
  });

  it('rejects a cursor it did not issue', async () => {
    expect((await api('GET', '/users?cursor=not-a-cursor')).body.error.code).toBe(
      'invalid_request',
    );
    const noEmail = Buffer.from(JSON.stringify({ x: 1 })).toString('base64url');
    const res = await api('GET', `/users?cursor=${noEmail}`);
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([expect.objectContaining({ path: '/cursor' })]);
  });
});

describe('update', () => {
  /** @type {any} */
  let target;

  beforeAll(async () => {
    target = await makeUser('update.target@example.org');
  });

  it('updates the display name and audits the field name only', async () => {
    const res = await api('PATCH', `/users/${target.id}`, {
      body: { display_name: '  Updated Name ' },
    });
    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('Updated Name');
    const audit = await t.pool.query(
      "SELECT details FROM audit_events WHERE action = 'admin.updateUser' ORDER BY id DESC LIMIT 1",
    );
    expect(audit.rows[0].details).toEqual({ status: 200, fields: ['display_name'] });
  });

  it('changes the email, lowercased, and refuses an email taken by another user', async () => {
    const res = await api('PATCH', `/users/${target.id}`, {
      body: { email: 'Renamed.Target@Example.org' },
    });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('renamed.target@example.org');
    const taken = await api('PATCH', `/users/${target.id}`, { body: { email: ADMIN_EMAIL } });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('conflict');
  });

  it('sets and clears the admin flag', async () => {
    const granted = await api('PATCH', `/users/${target.id}`, { body: { is_admin: true } });
    expect(granted.body.is_admin).toBe(true);
    const cleared = await api('PATCH', `/users/${target.id}`, { body: { is_admin: false } });
    expect(cleared.body.is_admin).toBe(false);
  });

  it('sets the status back and forth', async () => {
    const off = await api('PATCH', `/users/${target.id}`, { body: { status: 'disabled' } });
    expect(off.body.status).toBe('disabled');
    const on = await api('PATCH', `/users/${target.id}`, { body: { status: 'active' } });
    expect(on.body.status).toBe('active');
  });

  it('rejects an empty change, a blank display name, and an unknown user', async () => {
    const empty = await api('PATCH', `/users/${target.id}`, { body: {} });
    expect(empty.status).toBe(400);
    const blank = await api('PATCH', `/users/${target.id}`, { body: { display_name: '   ' } });
    expect(blank.status).toBe(400);
    expect(blank.body.error.details[0].path).toBe('/display_name');
    const missing = await api('PATCH', '/users/00000000-0000-4000-8000-000000000000', {
      body: { status: 'active' },
    });
    expect(missing.status).toBe(404);
  });
});

describe('sessions', () => {
  it('disabling a user ends their sessions, grants and tokens, and their admin tokens', async () => {
    const user = await makeUser('session.user@example.org');
    const { tokens, sub } = await signIn('session.user@example.org');
    expect(tokens.refresh_token).toBeTruthy();
    expect(sub).toBe(user.id);
    expect(await oidcRows(sub)).toBeGreaterThan(0);

    const info = await client.fetchUserInfo(t.rp, tokens.access_token, sub);
    expect(info.email).toBe('session.user@example.org');
    const refreshed = await client.refreshTokenGrant(
      t.rp,
      /** @type {string} */ (tokens.refresh_token),
    );

    const disabled = await api('PATCH', `/users/${user.id}`, { body: { status: 'disabled' } });
    expect(disabled.body.status).toBe('disabled');
    expect(await oidcRows(sub)).toBe(0);
    await expect(client.fetchUserInfo(t.rp, tokens.access_token, sub)).rejects.toThrow();
    await expect(
      client.refreshTokenGrant(t.rp, /** @type {string} */ (refreshed.refresh_token)),
    ).rejects.toThrow();
  });

  it('a user whose admin token was revoked by disabling gets 401', async () => {
    const admin = await makeUser('token.holder@example.org', { is_admin: true });
    const created = await api('POST', '/admin-tokens', {
      body: { label: 'holder', user_id: admin.id },
    });
    expect(created.status).toBe(201);
    const held = created.body.token;
    expect((await api('GET', '/me', { token: held })).status).toBe(200);

    await api('PATCH', `/users/${admin.id}`, { body: { status: 'disabled' } });
    const after = await api('GET', '/me', { token: held });
    expect(after.status).toBe(401);
    const { rows } = await t.pool.query(
      "SELECT 1 FROM audit_events WHERE action = 'admin.auth_failed' AND details->>'reason' = 'revoked'",
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('revoke-sessions returns the count, signs the browser out, and leaves admin tokens alone', async () => {
    const user = await makeUser('revoke.user@example.org');
    const b = browser();
    const first = await signIn('revoke.user@example.org', b);
    const before = await oidcRows(first.sub);
    expect(before).toBeGreaterThan(0);

    const res = await api('POST', `/users/${user.id}/revoke-sessions`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: before });
    expect(await oidcRows(first.sub)).toBe(0);
    await expect(
      client.refreshTokenGrant(t.rp, /** @type {string} */ (first.tokens.refresh_token)),
    ).rejects.toThrow();

    // The same browser is no longer offered "Continue as": the session is gone.
    const again = await t.startAuth(b, { scope: 'openid email profile' });
    expect(again.page.body).toContain('name="email"');
    expect(again.page.body).not.toContain('Continue as');

    // The user can sign in again, and a second revoke finds nothing.
    const later = await signIn('revoke.user@example.org');
    expect(later.sub).toBe(user.id);
    expect((await api('POST', `/users/${user.id}/revoke-sessions`)).body.revoked).toBeGreaterThan(
      0,
    );
    expect((await api('POST', `/users/${user.id}/revoke-sessions`)).body.revoked).toBe(0);

    // Admin tokens of the same user are not affected.
    expect((await api('POST', `/users/${t.adminId}/revoke-sessions`)).status).toBe(200);
    expect((await api('GET', '/me')).status).toBe(200);
  });

  it('revoke-sessions is 404 for an unknown user', async () => {
    const res = await api('POST', '/users/00000000-0000-4000-8000-000000000000/revoke-sessions');
    expect(res.status).toBe(404);
  });

  it('revokeUserSessions in accounts.js returns the number of rows removed', async () => {
    const { revokeUserSessions } = await import('../src/accounts.js');
    const user = await makeUser('direct.revoke@example.org');
    await t.pool.query(
      `INSERT INTO oidc_payloads (type, id, payload) VALUES
         ('Session', 'direct-1', $1), ('Grant', 'direct-2', $1)`,
      [JSON.stringify({ accountId: user.id })],
    );
    expect(await revokeUserSessions(t.pool, user.id)).toBe(2);
    expect(await revokeUserSessions(t.pool, user.id)).toBe(0);
  });
});

describe('last admin', () => {
  it('refuses to demote, disable or delete the only active admin', async () => {
    const demote = await api('PATCH', `/users/${t.adminId}`, { body: { is_admin: false } });
    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe('last_admin');
    const disable = await api('PATCH', `/users/${t.adminId}`, { body: { status: 'disabled' } });
    expect(disable.body.error.code).toBe('last_admin');
    const del = await api('DELETE', `/users/${t.adminId}`);
    expect(del.body.error.code).toBe('last_admin');

    const me = await api('GET', '/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ is_admin: true, status: 'active' });
  });

  it('allows a change to the only admin that keeps an admin active', async () => {
    const res = await api('PATCH', `/users/${t.adminId}`, {
      body: { display_name: 'Admin Renamed' },
    });
    expect(res.status).toBe(200);
  });

  describe('with a second active admin', () => {
    /** @type {string} */
    let secondToken = '';
    /** @type {string} */
    let secondId = '';

    beforeAll(async () => {
      const second = await makeUser('second.admin@example.org', { is_admin: true });
      secondId = second.id;
      const created = await api('POST', '/admin-tokens', {
        body: { label: 'second', user_id: secondId },
      });
      secondToken = created.body.token;
    });

    it('lets the second admin disable the first, and the first admin token then fails', async () => {
      const firstToken = token;
      const disable = await api('PATCH', `/users/${t.adminId}`, {
        token: secondToken,
        body: { status: 'disabled' },
      });
      expect(disable.status).toBe(200);
      expect((await api('GET', '/me', { token: firstToken })).status).toBe(401);
      const back = await api('PATCH', `/users/${t.adminId}`, {
        token: secondToken,
        body: { status: 'active' },
      });
      expect(back.status).toBe(200);
    });

    it('revokes the admin token of a user whose admin flag is removed', async () => {
      const made = await api('POST', '/users', {
        token: secondToken,
        body: { email: 'third.admin@example.org', is_admin: true },
      });
      expect(made.status).toBe(201);
      const third = made.body;
      const created = await api('POST', '/admin-tokens', {
        token: secondToken,
        body: { label: 'third', user_id: third.id },
      });
      const thirdToken = created.body.token;
      expect((await api('GET', '/me', { token: thirdToken })).status).toBe(200);

      const demoted = await api('PATCH', `/users/${third.id}`, {
        token: secondToken,
        body: { is_admin: false },
      });
      expect(demoted.body.is_admin).toBe(false);
      expect((await api('GET', '/me', { token: thirdToken })).status).toBe(401);
    });

    it('lets the second admin step down, leaving the first as the only admin', async () => {
      const fresh = await api('POST', '/admin-tokens', {
        token: secondToken,
        body: { label: 'fresh', user_id: t.adminId },
      });
      token = fresh.body.token;

      const stepDown = await api('PATCH', `/users/${secondId}`, {
        token: secondToken,
        body: { is_admin: false },
      });
      expect(stepDown.status).toBe(200);
      expect((await api('GET', '/me', { token: secondToken })).status).toBe(401);
    });

    it('refuses the last-admin changes again once the first admin is alone', async () => {
      expect(
        (await api('PATCH', `/users/${t.adminId}`, { body: { is_admin: false } })).status,
      ).toBe(409);
      expect((await api('DELETE', `/users/${t.adminId}`)).status).toBe(409);
      expect((await api('GET', '/me')).body.user.is_admin).toBe(true);
    });
  });
});

describe('delete', () => {
  it('ends sessions, removes the user and their memberships, and keeps no email in audit rows', async () => {
    const user = await makeUser('delete.me@example.org');
    const { sub } = await signIn('delete.me@example.org');
    expect(await oidcRows(sub)).toBeGreaterThan(0);

    const res = await api('DELETE', `/users/${user.id}`);
    expect(res.status).toBe(204);
    expect(await userRow('delete.me@example.org')).toBeUndefined();
    expect(await oidcRows(sub)).toBe(0);
    const memberships = await t.pool.query('SELECT 1 FROM user_groups WHERE user_id = $1', [
      user.id,
    ]);
    expect(memberships.rowCount).toBe(0);
    expect((await api('GET', `/users/${user.id}`)).status).toBe(404);

    const audit = await t.pool.query(
      "SELECT target_id FROM audit_events WHERE action = 'admin.deleteUser' AND target_id = $1",
      [user.id],
    );
    expect(audit.rowCount).toBe(1);
    const withEmail = await t.pool.query(
      "SELECT id FROM audit_events WHERE details::text LIKE '%@%'",
    );
    expect(withEmail.rows).toEqual([]);
  });

  it('answers 404 for an unknown user', async () => {
    const res = await api('DELETE', '/users/00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
  });
});

describe('audit', () => {
  it('audits every call with the actor and the operation id', async () => {
    const { rows } = await t.pool.query(
      `SELECT DISTINCT action FROM audit_events
        WHERE actor_user_id IS NOT NULL
          AND action IN ('admin.listUsers', 'admin.createUser', 'admin.getUser', 'admin.updateUser',
                         'admin.deleteUser', 'admin.revokeUserSessions')`,
    );
    expect(rows.map((/** @type {any} */ r) => r.action).sort()).toEqual([
      'admin.createUser',
      'admin.deleteUser',
      'admin.getUser',
      'admin.listUsers',
      'admin.revokeUserSessions',
      'admin.updateUser',
    ]);
  });
});
