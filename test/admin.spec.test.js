import { describe, expect, it } from 'vitest';
import { AdminError } from '../src/admin/errors.js';
import { decodeCursor, encodeCursor, page } from '../src/admin/paging.js';
import { listOperations, loadSpec } from '../src/admin/spec.js';
import { createSpecValidators } from '../src/admin/validate.js';
import { handlers } from '../src/admin/handlers/index.js';

const spec = loadSpec();
const operations = listOperations(spec);

describe('openapi.yaml and handlers', () => {
  it('has a handler for every operation and an operation for every handler', () => {
    const ids = operations.map((op) => op.operationId).sort();
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(handlers).sort()).toEqual(ids);
  });

  it('converts path parameters to Express syntax', () => {
    const byId = Object.fromEntries(operations.map((op) => [op.operationId, op]));
    expect(byId.getUser.expressPath).toBe('/users/:userId');
    expect(byId.revokeMembership.expressPath).toBe('/groups/:groupId/members/:userId');
    expect(byId.retireKey.expressPath).toBe('/keys/:kid/retire');
    expect(byId.listUsers.method).toBe('get');
  });

  it('merges path-level parameters into operations', () => {
    const revoke = operations.find((op) => op.operationId === 'revokeAdminToken');
    expect(revoke?.parameters.map((p) => p.name)).toEqual(['tokenId']);
  });

  it('compiles every operation schema and every component schema', () => {
    const validators = createSpecValidators(spec, operations);
    for (const op of operations) expect(() => validators.get(op.operationId)).not.toThrow();
    for (const name of Object.keys(spec.components.schemas)) {
      expect(() => validators.component(name)).not.toThrow();
    }
  });

  it('validates a User object and rejects a bad one', () => {
    const user = createSpecValidators(spec, operations).component('User');
    const good = {
      id: '6f1c2a4e-7b8d-4e9f-9a0b-1c2d3e4f5a6b',
      email: 'anna@example.org',
      display_name: 'Anna',
      status: 'active',
      is_admin: false,
      created_at: '2026-11-01T10:00:00.000Z',
      last_login_at: null,
      groups: ['all'],
    };
    expect(user(good).ok).toBe(true);
    const bad = user({ ...good, status: 'banned', extra: 1 });
    expect(bad.ok).toBe(false);
  });
});

describe('paging', () => {
  it('round-trips a cursor', () => {
    const cursor = encodeCursor({ id: '42' });
    expect(decodeCursor(cursor)).toEqual({ id: '42' });
  });

  it('rejects a bad cursor with 400 invalid_request', () => {
    for (const bad of ['not json', Buffer.from('[1]').toString('base64url'), '%%%']) {
      try {
        decodeCursor(bad);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AdminError);
        expect(/** @type {AdminError} */ (err).status).toBe(400);
        expect(/** @type {AdminError} */ (err).code).toBe('invalid_request');
      }
    }
  });

  it('shapes a page from limit + 1 rows', () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const first = page(rows, 2, (r) => ({ id: String(r.id) }));
    expect(first.items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(decodeCursor(/** @type {string} */ (first.next_cursor))).toEqual({ id: '2' });
    const last = page(rows.slice(0, 2), 2, (r) => ({ id: String(r.id) }));
    expect(last.next_cursor).toBeNull();
  });
});
