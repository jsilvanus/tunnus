import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAdmin } from './helpers/admin.js';

/** @type {Awaited<ReturnType<typeof startAdmin>>} */
let t;
/** @type {{ alpha: string, beta: string, gamma: string }} */
const fixture = { alpha: '', beta: '', gamma: '' };

beforeAll(async () => {
  t = await startAdmin({ schema: 'tunnus_audit_test' });
  // Fixture rows with fixed times and ids: alpha < beta < gamma by id.
  const rows = [
    ['fixture.alpha', '2026-01-01T00:00:00Z', t.adminId, 'fixture-target', 'a-1', 'alpha'],
    ['fixture.beta', '2026-01-02T00:00:00Z', null, 'fixture-target', 'b-1', 'beta'],
    ['fixture_x.gamma', '2026-01-03T00:00:00Z', null, 'fixture-target', 'c-1', 'gamma'],
  ];
  for (const [action, at, actor, targetType, targetId, key] of rows) {
    const { rows: inserted } = await t.pool.query(
      `INSERT INTO audit_events (action, at, actor_user_id, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5, '{"fixture": true}') RETURNING id`,
      [action, at, actor, targetType, targetId],
    );
    fixture[/** @type {'alpha' | 'beta' | 'gamma'} */ (key)] = String(inserted[0].id);
  }
});
afterAll(async () => {
  await t.close();
});

/** @param {string} query */
async function list(query) {
  const res = await t.api('GET', `/audit-events${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return /** @type {{ items: any[], next_cursor: string | null }} */ (res.body);
}

/** @param {any[]} items */
const ids = (items) => items.map((e) => e.id);

describe('audit events', () => {
  it('lists events newest first, with string ids and ISO times', async () => {
    const body = await list('?limit=200');
    expect(body.items.length).toBeGreaterThan(3);
    const numeric = body.items.map((e) => BigInt(e.id));
    for (let i = 1; i < numeric.length; i++) expect(numeric[i - 1] > numeric[i]).toBe(true);
    for (const e of body.items) {
      expect(typeof e.id).toBe('string');
      expect(new Date(e.at).toISOString()).toBe(e.at);
      expect(typeof e.details).toBe('object');
    }
    // The API's own calls are audited too: the row for an earlier call is listed.
    expect((await t.api('GET', '/me')).status).toBe(200);
    const after = await list('?action=admin.getMe');
    expect(after.items.length).toBeGreaterThan(0);
    expect(after.items[0].actor_user_id).toBe(t.adminId);
    expect(after.items[0].details.status).toBe(200);
  });

  it('filters by exact action', async () => {
    const body = await list('?action=fixture.alpha');
    expect(ids(body.items)).toEqual([fixture.alpha]);
  });

  it('filters by a prefix ending in *', async () => {
    const body = await list('?action=fixture.*');
    expect(ids(body.items)).toEqual([fixture.beta, fixture.alpha]);
    const admin = await list('?action=admin.*&limit=200');
    expect(admin.items.length).toBeGreaterThan(0);
    for (const e of admin.items) expect(e.action.startsWith('admin.')).toBe(true);
  });

  it('treats LIKE wildcards in a prefix literally', async () => {
    // "fixture_" with an unescaped _ would also match "fixture.alpha".
    const body = await list('?action=fixture_*');
    expect(ids(body.items)).toEqual([fixture.gamma]);
    const percent = await list('?action=fixture%25*');
    expect(percent.items).toEqual([]);
  });

  it('filters by actor_user_id', async () => {
    const body = await list(`?actor_user_id=${t.adminId}&action=fixture*`);
    expect(ids(body.items)).toEqual([fixture.alpha]);
    const all = await list(`?actor_user_id=${t.adminId}&limit=200`);
    for (const e of all.items) expect(e.actor_user_id).toBe(t.adminId);
  });

  it('filters by target_type and target_id', async () => {
    const byType = await list('?target_type=fixture-target');
    expect(ids(byType.items)).toEqual([fixture.gamma, fixture.beta, fixture.alpha]);
    const byId = await list('?target_type=fixture-target&target_id=b-1');
    expect(ids(byId.items)).toEqual([fixture.beta]);
  });

  it('filters by since (inclusive) and until (exclusive)', async () => {
    const window = await list(
      '?action=fixture*&since=2026-01-02T00:00:00Z&until=2026-01-03T00:00:00Z',
    );
    expect(ids(window.items)).toEqual([fixture.beta]);

    const sinceOnly = await list('?action=fixture*&since=2026-01-03T00:00:00Z');
    expect(ids(sinceOnly.items)).toEqual([fixture.gamma]);

    const untilOnly = await list('?action=fixture*&until=2026-01-02T00:00:00Z');
    expect(ids(untilOnly.items)).toEqual([fixture.alpha]);
  });

  it('pages with limit and an opaque cursor, without repeats', async () => {
    const first = await list('?action=fixture*&limit=2');
    expect(ids(first.items)).toEqual([fixture.gamma, fixture.beta]);
    expect(first.next_cursor).toBeTruthy();

    const second = await list(`?action=fixture*&limit=2&cursor=${first.next_cursor}`);
    expect(ids(second.items)).toEqual([fixture.alpha]);
    expect(second.next_cursor).toBeNull();
  });

  it('rejects a cursor it did not issue with 400', async () => {
    const garbage = await t.api('GET', '/audit-events?cursor=not-a-cursor!!');
    expect(garbage.status).toBe(400);
    expect(garbage.body.error.code).toBe('invalid_request');

    const notObject = Buffer.from('"text"').toString('base64url');
    expect((await t.api('GET', `/audit-events?cursor=${notObject}`)).status).toBe(400);

    const badId = Buffer.from(JSON.stringify({ id: 'abc' })).toString('base64url');
    const res = await t.api('GET', `/audit-events?cursor=${badId}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');

    const tooBig = Buffer.from(JSON.stringify({ id: '99999999999999999999' })).toString(
      'base64url',
    );
    expect((await t.api('GET', `/audit-events?cursor=${tooBig}`)).status).toBe(400);
  });

  it('rejects a malformed since with 400', async () => {
    const res = await t.api('GET', '/audit-events?since=yesterday');
    expect(res.status).toBe(400);
  });
});
