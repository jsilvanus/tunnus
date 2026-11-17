import crypto from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrate } from '../src/db.js';
import { ensureSigningKey } from '../src/oidc/keys.js';
import { startAdmin } from './helpers/admin.js';
import { REDIRECT, browser } from './helpers/harness.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PRIVATE_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi'];

/** @type {Awaited<ReturnType<typeof startAdmin>>} */
let t;

beforeAll(async () => {
  t = await startAdmin({ schema: 'tunnus_keys_test' });
});
afterAll(async () => {
  await t.close();
});

/** The public JWKS, found through discovery. */
async function jwks() {
  const disc = await (await fetch(`${t.issuer}/.well-known/openid-configuration`)).json();
  const res = await fetch(disc.jwks_uri);
  return /** @type {any[]} */ ((await res.json()).keys);
}

/** @param {string} [query] */
async function listed(query = '') {
  const res = await t.api('GET', `/keys${query}`);
  expect(res.status).toBe(200);
  return /** @type {any[]} */ (res.body.items);
}

/** @param {any[]} items @param {string} status */
const byStatus = (items, status) => items.filter((k) => k.status === status);

/** @param {string} jwt */
function headerOf(jwt) {
  return JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url').toString('utf8'));
}

/**
 * Check an RS256 JWT against a JWKS, using the key named by its header kid.
 * @param {string} jwt
 * @param {any[]} keys
 */
function verifies(jwt, keys) {
  const [h, p, s] = jwt.split('.');
  const jwk = keys.find((k) => k.kid === headerOf(jwt).kid);
  if (!jwk) return false;
  return crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${h}.${p}`),
    crypto.createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(s, 'base64url'),
  );
}

/**
 * Sign in through the browser flow and return the ID token.
 * @param {string} email
 */
async function signIn(email) {
  const b = browser();
  const { page, verifier, state } = await t.startAuth(b);
  const path = /** @type {string} */ (t.interactionPath(page.body));
  await b.post(`${t.origin}${path}/email`, { email });
  const mail = /** @type {any} */ (t.mails.at(-1));
  const done = await b.post(`${t.origin}${path}/code`, { code: mail.code });
  let url = done.finalUrl;
  if (!url.startsWith(REDIRECT)) {
    url = (await b.post(`${t.origin}${path}/name`, { name: 'Key Tester' })).finalUrl;
  }
  const tokens = await t.exchange(url, verifier, state);
  return /** @type {string} */ (tokens.id_token);
}

describe('signing keys', () => {
  /** @type {string} */
  let activeKid;
  /** @type {string} */
  let nextKid;
  /** @type {string} */
  let beforeToken;
  /** @type {string} */
  let newActiveKid;
  /** @type {string} */
  let newNextKid;
  /** @type {string} */
  let retiredKid;

  it('fresh start has one active and one next key, both published in JWKS', async () => {
    const items = await listed();
    expect(byStatus(items, 'active')).toHaveLength(1);
    expect(byStatus(items, 'next')).toHaveLength(1);
    activeKid = byStatus(items, 'active')[0].kid;
    nextKid = byStatus(items, 'next')[0].kid;
    expect(byStatus(items, 'active')[0].published).toBe(true);
    expect(byStatus(items, 'next')[0].published).toBe(true);

    const keys = await jwks();
    const kids = keys.map((k) => k.kid);
    expect(new Set(kids)).toEqual(new Set([activeKid, nextKid]));
    expect(kids[0]).toBe(activeKid);
    for (const k of keys) {
      for (const field of PRIVATE_FIELDS) expect(k).not.toHaveProperty(field);
    }
  });

  it('signs a token before rotation with the active key', async () => {
    beforeToken = await signIn('signer.before@example.org');
    expect(headerOf(beforeToken).kid).toBe(activeKid);
    expect(verifies(beforeToken, await jwks())).toBe(true);
  });

  it('rotate promotes next, retires the old active key for the grace period, and adds a new next', async () => {
    const res = await t.api('POST', '/keys/rotate');
    expect(res.status).toBe(200);
    const { active, next, retired, warnings } = res.body;

    expect(active.kid).toBe(nextKid);
    expect(active.status).toBe('active');
    expect(active.published).toBe(true);
    expect(active.activated_at).not.toBeNull();

    expect(retired.kid).toBe(activeKid);
    expect(retired.status).toBe('retired');
    expect(retired.published).toBe(true);
    const untilGap = Date.parse(retired.published_until) - (Date.now() + 7 * DAY_MS);
    expect(Math.abs(untilGap)).toBeLessThan(60_000);

    expect(next.status).toBe('next');
    expect(next.kid).not.toBe(activeKid);
    expect(next.kid).not.toBe(nextKid);
    expect(warnings).toEqual([]);

    newActiveKid = active.kid;
    newNextKid = next.kid;
    retiredKid = retired.kid;

    const keys = await jwks();
    expect(keys).toHaveLength(3);
    expect(keys[0].kid).toBe(newActiveKid);

    const { rows } = await t.pool.query(
      "SELECT target_id, details FROM audit_events WHERE action = 'admin.rotateKeys' ORDER BY id DESC LIMIT 1",
    );
    expect(rows[0].target_id).toBe(newActiveKid);
    expect(rows[0].details).toMatchObject({
      retired_kid: retiredKid,
      new_next_kid: newNextKid,
      warnings: [],
    });
  });

  it('an ID token from a sign-in after rotation is signed with the new active key', async () => {
    const token = await signIn('signer.after@example.org');
    expect(headerOf(token).kid).toBe(newActiveKid);
    expect(verifies(token, await jwks())).toBe(true);
  });

  it('a token signed before rotation still verifies against JWKS while the old key is in grace', async () => {
    expect(headerOf(beforeToken).kid).toBe(activeKid);
    expect(verifies(beforeToken, await jwks())).toBe(true);
  });

  it('retiring the retired key removes it from JWKS now and from the default list', async () => {
    const res = await t.api('POST', `/keys/${retiredKid}/retire`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('retired');
    expect(res.body.published).toBe(false);
    expect(Date.parse(res.body.published_until)).toBeLessThanOrEqual(Date.now());

    const kids = (await jwks()).map((k) => k.kid);
    expect(kids).not.toContain(retiredKid);
    expect(kids).toHaveLength(2);
    expect(verifies(beforeToken, await jwks())).toBe(false);

    const defaults = await listed();
    expect(defaults.map((k) => k.kid)).not.toContain(retiredKid);
    const everything = await listed('?include_unpublished=true');
    expect(everything.map((k) => k.kid)).toContain(retiredKid);
  });

  it('refuses to retire the active key with 409 key_active', async () => {
    const res = await t.api('POST', `/keys/${newActiveKid}/retire`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('key_active');
    const items = await listed();
    expect(byStatus(items, 'active').map((k) => k.kid)).toEqual([newActiveKid]);
  });

  it('retiring the next key creates a new next key and keeps the old one out of JWKS', async () => {
    const res = await t.api('POST', `/keys/${newNextKid}/retire`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('retired');
    expect(res.body.published).toBe(false);

    const items = await listed();
    const nexts = byStatus(items, 'next');
    expect(nexts).toHaveLength(1);
    expect(nexts[0].kid).not.toBe(newNextKid);

    const kids = (await jwks()).map((k) => k.kid);
    expect(kids).not.toContain(newNextKid);
    expect(kids).toContain(nexts[0].kid);

    const { rows } = await t.pool.query(
      "SELECT details FROM audit_events WHERE action = 'admin.retireKey' AND target_id = $1 ORDER BY id DESC LIMIT 1",
      [newNextKid],
    );
    expect(rows[0].details).toMatchObject({ new_next_kid: nexts[0].kid });
  });

  it('retiring an unknown kid is 404', async () => {
    const res = await t.api('POST', '/keys/no-such-key/retire');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('rotating with no next key creates one and warns next_key_missing', async () => {
    await t.pool.query("DELETE FROM signing_keys WHERE status = 'next'");
    const res = await t.api('POST', '/keys/rotate');
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual(['next_key_missing']);
    expect(res.body.active.status).toBe('active');
    expect(res.body.next.status).toBe('next');
    const items = await listed();
    expect(byStatus(items, 'active')).toHaveLength(1);
    expect(byStatus(items, 'next')).toHaveLength(1);
  });

  it('a retired key whose grace period has ended leaves JWKS after a reload', async () => {
    const res = await t.api('POST', '/keys/rotate');
    const graceKid = res.body.retired.kid;
    expect((await jwks()).map((k) => k.kid)).toContain(graceKid);

    await t.pool.query(
      "UPDATE signing_keys SET published_until = now() - interval '1 minute' WHERE kid = $1",
      [graceKid],
    );
    await t.holder.reload();

    expect((await jwks()).map((k) => k.kid)).not.toContain(graceKid);
    const defaults = await listed();
    expect(defaults.map((k) => k.kid)).not.toContain(graceKid);
    const everything = await listed('?include_unpublished=true');
    expect(everything.find((k) => k.kid === graceKid).published).toBe(false);
  });

  it('two concurrent rotations leave exactly one active and one next key', async () => {
    const [a, b] = await Promise.all([
      t.api('POST', '/keys/rotate'),
      t.api('POST', '/keys/rotate'),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.active.kid).not.toBe(b.body.active.kid);

    const items = await listed();
    const active = byStatus(items, 'active');
    expect(active).toHaveLength(1);
    expect(byStatus(items, 'next')).toHaveLength(1);
    expect((await jwks())[0].kid).toBe(active[0].kid);
  });

  it('never returns private key material', async () => {
    const items = await listed('?include_unpublished=true');
    expect(items.length).toBeGreaterThan(1);
    for (const k of items) {
      expect(Object.keys(k)).not.toContain('private_jwk');
      for (const field of PRIVATE_FIELDS) expect(Object.keys(k.public_jwk)).not.toContain(field);
    }
    const text = JSON.stringify(items);
    expect(text).not.toContain('private_jwk');
    expect(text).not.toMatch(/"d":"/);
  });
});

describe('concurrent start', () => {
  it('two processes starting at once leave one active and one next key', async () => {
    const schema = 'tunnus_keys_race_test';
    const url = /** @type {string} */ (process.env.DATABASE_URL);
    const admin = new pg.Pool({ connectionString: url });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
    await admin.end();

    const pool = createPool(url, schema);
    try {
      await migrate(pool);
      await Promise.all([
        ensureSigningKey(pool, 'race-secret'),
        ensureSigningKey(pool, 'race-secret'),
      ]);
      const { rows } = await pool.query(
        'SELECT status, count(*)::int AS n FROM signing_keys GROUP BY status',
      );
      const counts = Object.fromEntries(rows.map((r) => [r.status, r.n]));
      expect(counts).toEqual({ active: 1, next: 1 });
    } finally {
      await pool.end();
    }
  });
});
