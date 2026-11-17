import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_EMAIL, startAdmin } from './helpers/admin.js';

/** @type {Awaited<ReturnType<typeof startAdmin>>} */
let t;

beforeAll(async () => {
  t = await startAdmin({ schema: 'tunnus_admin_groups_test' });
});
afterAll(async () => {
  await t.close();
});

/**
 * @param {string} email
 * @param {Record<string, unknown>} [extra]
 */
async function makeUser(email, extra = {}) {
  const res = await t.api('POST', '/users', { body: { email, ...extra } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return /** @type {any} */ (res.body);
}

/**
 * @param {string} name
 * @param {string} [description]
 */
async function makeGroup(name, description) {
  const res = await t.api('POST', '/groups', {
    body: description === undefined ? { name } : { name, description },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return /** @type {any} */ (res.body);
}

/** @param {number} groupId @param {string} userId */
const grant = (groupId, userId) => t.api('PUT', `/groups/${groupId}/members/${userId}`);

describe('create and read', () => {
  it('creates a group with a numeric id, empty member count and no default flag', async () => {
    const res = await t.api('POST', '/groups', { body: { name: 'staff', description: 'Staff' } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(Number),
      name: 'staff',
      description: 'Staff',
      is_default: false,
      member_count: 0,
    });
    const audit = await t.pool.query(
      "SELECT target_type, target_id, details FROM audit_events WHERE action = 'admin.createGroup' ORDER BY id DESC LIMIT 1",
    );
    expect(audit.rows[0]).toEqual({
      target_type: 'group',
      target_id: String(res.body.id),
      details: { status: 201, name: 'staff' },
    });
  });

  it('defaults the description to empty and accepts nested names', async () => {
    const plain = await makeGroup('plain');
    expect(plain.description).toBe('');
    const nested = await makeGroup('lead/choir');
    expect(nested.name).toBe('lead/choir');
    await makeGroup('a.b_c-d');
  });

  it('rejects names outside the pattern with 400', async () => {
    for (const name of ['/lead', 'a//b', 'with space', 'trailing/']) {
      const res = await t.api('POST', '/groups', { body: { name } });
      expect(res.status, name).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
    }
  });

  it('answers 409 conflict for a duplicate name', async () => {
    const res = await t.api('POST', '/groups', { body: { name: 'staff' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });

  it('gets a group by id, 404 for an unknown one', async () => {
    const staff = (await t.api('GET', '/groups?name=staff')).body.items[0];
    const res = await t.api('GET', `/groups/${staff.id}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('staff');
    const missing = await t.api('GET', '/groups/999999');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
  });

  it('filters by exact name', async () => {
    const res = await t.api('GET', '/groups?name=staff');
    expect(res.body.items.map((/** @type {any} */ g) => g.name)).toEqual(['staff']);
    const none = await t.api('GET', '/groups?name=sta');
    expect(none.body).toEqual({ items: [], next_cursor: null });
  });

  it('pages through all groups in name order, two at a time', async () => {
    const all = await t.api('GET', '/groups?limit=200');
    const expected = all.body.items.map((/** @type {any} */ g) => g.name);
    const seen = [];
    let cursor = null;
    do {
      const qs = `/groups?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await t.api('GET', qs);
      seen.push(...res.body.items.map((/** @type {any} */ g) => g.name));
      cursor = res.body.next_cursor;
    } while (cursor);
    expect(seen).toEqual(expected);
    expect(seen.length).toBeGreaterThan(4);
  });

  it('marks the configured default group and counts its members', async () => {
    const all = (await t.api('GET', '/groups?name=all')).body.items[0];
    expect(all.is_default).toBe(true);
    expect(all.member_count).toBeGreaterThanOrEqual(1);
    const { rows } = await t.pool.query(
      "SELECT count(*)::int AS n FROM user_groups ug JOIN groups g ON g.id = ug.group_id WHERE g.name = 'all'",
    );
    expect(all.member_count).toBe(rows[0].n);
  });
});

describe('update and delete', () => {
  it('renames a group and changes its description', async () => {
    const group = await makeGroup('renamable', 'Old');
    const renamed = await t.api('PATCH', `/groups/${group.id}`, {
      body: { name: 'renamed', description: 'New' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ id: group.id, name: 'renamed', description: 'New' });
    const audit = await t.pool.query(
      "SELECT details FROM audit_events WHERE action = 'admin.updateGroup' ORDER BY id DESC LIMIT 1",
    );
    expect(audit.rows[0].details).toEqual({ status: 200, fields: ['name', 'description'] });
  });

  it('refuses a rename onto an existing name', async () => {
    const group = (await t.api('GET', '/groups?name=renamed')).body.items[0];
    const res = await t.api('PATCH', `/groups/${group.id}`, { body: { name: 'plain' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });

  it('refuses to rename a default group, or to rename a group onto a default name', async () => {
    const all = (await t.api('GET', '/groups?name=all')).body.items[0];
    const renameAll = await t.api('PATCH', `/groups/${all.id}`, { body: { name: 'everyone' } });
    expect(renameAll.status).toBe(409);
    expect(renameAll.body.error.code).toBe('default_group');

    const renamed = (await t.api('GET', '/groups?name=renamed')).body.items[0];
    const onto = await t.api('PATCH', `/groups/${renamed.id}`, { body: { name: 'all' } });
    expect(onto.status).toBe(409);
    expect(onto.body.error.code).toBe('default_group');
  });

  it('changes the description of a default group', async () => {
    const all = (await t.api('GET', '/groups?name=all')).body.items[0];
    const res = await t.api('PATCH', `/groups/${all.id}`, { body: { description: 'Everyone' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'all', description: 'Everyone', is_default: true });
  });

  it('rejects an empty change and an unknown group', async () => {
    const group = (await t.api('GET', '/groups?name=renamed')).body.items[0];
    expect((await t.api('PATCH', `/groups/${group.id}`, { body: {} })).status).toBe(400);
    expect((await t.api('PATCH', '/groups/999999', { body: { description: 'x' } })).status).toBe(
      404,
    );
  });

  it('refuses to delete a default group', async () => {
    const all = (await t.api('GET', '/groups?name=all')).body.items[0];
    const res = await t.api('DELETE', `/groups/${all.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('default_group');
  });

  it('deletes a group, and then 404s', async () => {
    const plain = (await t.api('GET', '/groups?name=plain')).body.items[0];
    expect((await t.api('DELETE', `/groups/${plain.id}`)).status).toBe(204);
    expect((await t.api('GET', `/groups/${plain.id}`)).status).toBe(404);
    expect((await t.api('DELETE', `/groups/${plain.id}`)).status).toBe(404);
  });
});

describe('memberships', () => {
  /** @type {any} */
  let staff;
  /** @type {any} */
  let one;
  /** @type {any} */
  let two;

  beforeAll(async () => {
    staff = await makeGroup('team/staff', 'Staff team');
    one = await makeUser('member.one@example.org');
    two = await makeUser('member.two@example.org');
  });

  it('grants a membership with 201, then 200 with the same row when repeated', async () => {
    const first = await grant(staff.id, one.id);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      user_id: one.id,
      email: 'member.one@example.org',
      display_name: 'Member One',
      group_id: staff.id,
      group_name: 'team/staff',
      granted_by: t.adminId,
      granted_at: expect.any(String),
    });
    const again = await grant(staff.id, one.id);
    expect(again.status).toBe(200);
    expect(again.body.granted_at).toBe(first.body.granted_at);
    expect(again.body.granted_by).toBe(t.adminId);

    const audit = await t.pool.query(
      "SELECT target_type, target_id, details FROM audit_events WHERE action = 'admin.grantMembership' ORDER BY id DESC LIMIT 1",
    );
    expect(audit.rows[0]).toEqual({
      target_type: 'group',
      target_id: String(staff.id),
      details: { status: 200, user_id: one.id },
    });
  });

  it('shows the group in the user record and in their memberships', async () => {
    const user = await t.api('GET', `/users/${one.id}`);
    expect(user.body.groups).toEqual(['all', 'team/staff']);
    const memberships = await t.api('GET', `/users/${one.id}/groups`);
    expect(memberships.body.items.map((/** @type {any} */ m) => m.group_name)).toEqual([
      'all',
      'team/staff',
    ]);
    const adminAll = await t.api('GET', `/users/${t.adminId}/groups`);
    const allMembership = adminAll.body.items.find(
      (/** @type {any} */ m) => m.group_name === 'all',
    );
    expect(allMembership.granted_by).toBeNull();
  });

  it('counts members and lists them by email, paged', async () => {
    await grant(staff.id, two.id);
    const group = await t.api('GET', `/groups/${staff.id}`);
    expect(group.body.member_count).toBe(2);

    const first = await t.api('GET', `/groups/${staff.id}/members?limit=1`);
    expect(first.body.items.map((/** @type {any} */ m) => m.email)).toEqual([
      'member.one@example.org',
    ]);
    expect(first.body.next_cursor).toEqual(expect.any(String));
    const second = await t.api(
      'GET',
      `/groups/${staff.id}/members?limit=1&cursor=${encodeURIComponent(first.body.next_cursor)}`,
    );
    expect(second.body.items.map((/** @type {any} */ m) => m.email)).toEqual([
      'member.two@example.org',
    ]);
    expect(second.body.next_cursor).toBeNull();
  });

  it('answers 404 when the user or the group does not exist', async () => {
    const noUser = await grant(staff.id, '00000000-0000-4000-8000-000000000000');
    expect(noUser.status).toBe(404);
    const noGroup = await grant(999999, one.id);
    expect(noGroup.status).toBe(404);
    expect((await t.api('GET', '/groups/999999/members')).status).toBe(404);
    expect((await t.api('GET', '/users/00000000-0000-4000-8000-000000000000/groups')).status).toBe(
      404,
    );
  });

  it('revokes a membership with 204, then 404 because it is gone', async () => {
    const removed = await t.api('DELETE', `/groups/${staff.id}/members/${one.id}`);
    expect(removed.status).toBe(204);
    expect((await t.api('DELETE', `/groups/${staff.id}/members/${one.id}`)).status).toBe(404);
    const group = await t.api('GET', `/groups/${staff.id}`);
    expect(group.body.member_count).toBe(1);
    const user = await t.api('GET', `/users/${one.id}`);
    expect(user.body.groups).toEqual(['all']);
  });

  it('removes the memberships of a group when the group is deleted', async () => {
    expect((await grant(staff.id, one.id)).status).toBe(201);
    expect((await t.api('DELETE', `/groups/${staff.id}`)).status).toBe(204);

    const { rows } = await t.pool.query('SELECT 1 FROM user_groups WHERE group_id = $1', [
      staff.id,
    ]);
    expect(rows).toEqual([]);
    const user = await t.api('GET', `/users/${two.id}`);
    expect(user.body.groups).toEqual(['all']);
    const memberships = await t.api('GET', `/users/${two.id}/groups`);
    expect(memberships.body.items.map((/** @type {any} */ m) => m.group_name)).toEqual(['all']);
  });

  it('keeps the admin as a member of the default group throughout', async () => {
    const admin = await t.api('GET', '/users?email=' + encodeURIComponent(ADMIN_EMAIL));
    expect(admin.body.items[0].groups).toEqual(['all']);
  });
});
