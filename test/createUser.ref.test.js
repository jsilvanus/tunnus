import { describe, expect, it } from 'vitest';
import { resolveMcpSubjectReference, resolveMcpUserReference } from '../src/mcp/identity.js';
import { handlers as userHandlers } from '../src/admin/handlers/users.js';

describe('resolveMcpSubjectReference and resolveMcpUserReference', () => {
  const scope = {
    ownerUserId: '11111111-1111-4111-8111-111111111111',
    authKind: 'oauth',
    authClientKey: 'client-xyz',
  };

  it('resolves an unlinked subject with resolveMcpSubjectReference but rejects with resolveMcpUserReference', async () => {
    const mockPool = {
      async query(sql) {
        if (sql.includes('FROM mcp_pseudonyms p')) {
          return {
            rows: [
              {
                id: 'subj-unlinked-1',
                tunnus_user_id: null,
                label: 'Anna Kanttori <anna@example.org>',
                pseudonym: 'anna',
              },
            ],
          };
        }
        return { rows: [] };
      },
    };

    const subject = await resolveMcpSubjectReference(mockPool, scope, 'pseudo:anna', 'pseudo_ref');
    expect(subject).toMatchObject({
      id: 'subj-unlinked-1',
      tunnus_user_id: null,
      label: 'Anna Kanttori <anna@example.org>',
    });

    await expect(
      resolveMcpUserReference(mockPool, scope, 'pseudo:anna', 'pseudo_ref'),
    ).rejects.toThrow('This identity is not linked to a Tunnus account');
  });

  it('resolves linked subjects for both', async () => {
    const mockPool = {
      async query(sql) {
        if (sql.includes('FROM mcp_pseudonyms p')) {
          return {
            rows: [
              {
                id: 'subj-linked-1',
                tunnus_user_id: '22222222-2222-4222-8222-222222222222',
                label: 'Matti Kirkkoherra',
                pseudonym: 'matti',
              },
            ],
          };
        }
        return { rows: [] };
      },
    };

    const subject = await resolveMcpSubjectReference(mockPool, scope, 'pseudo:matti', 'pseudo_ref');
    expect(subject.tunnus_user_id).toBe('22222222-2222-4222-8222-222222222222');

    const userId = await resolveMcpUserReference(mockPool, scope, 'pseudo:matti', 'pseudo_ref');
    expect(userId).toBe('22222222-2222-4222-8222-222222222222');
  });
});

describe('createUser handler with ref', () => {
  const adminId = '11111111-1111-4111-8111-111111111111';
  const scope = {
    ownerUserId: adminId,
    authKind: 'oauth',
    authClientKey: 'chatgpt-client',
  };

  it('creates user from ref, deriving email and name from label, and links subject', async () => {
    let insertedUser = null;
    let linkedSubject = null;
    const client = {
      async query(sql, params) {
        if (sql.includes('INSERT INTO users')) {
          insertedUser = { id: 'new-user-123', email: params[0], display_name: params[1] };
          return { rows: [insertedUser] };
        }
        if (sql.includes('UPDATE mcp_identity_subjects')) {
          linkedSubject = { userId: params[0], subjectId: params[1], ownerUserId: params[2] };
          return { rows: [{ id: params[1], tunnus_user_id: params[0] }] };
        }
        return { rows: [] };
      },
    };

    const pool = {
      async connect() {
        return {
          ...client,
          release: () => {},
        };
      },
      async query(sql) {
        if (sql.includes('FROM mcp_pseudonyms p')) {
          return {
            rows: [
              {
                id: 'subj-external-1',
                tunnus_user_id: null,
                label: 'Kerttu Kanttori <kerttu@riihimaenseurakunta.fi>',
                pseudonym: 'kerttu',
              },
            ],
          };
        }
        if (
          sql.includes('FROM users u') ||
          (sql.includes('SELECT') && sql.includes('WHERE u.id = $1'))
        ) {
          return {
            rows: [
              {
                id: 'new-user-123',
                email: 'kerttu@riihimaenseurakunta.fi',
                display_name: 'Kerttu Kanttori',
                status: 'active',
                is_admin: false,
                created_at: new Date(),
                groups: ['user'],
              },
            ],
          };
        }
        return { rows: [] };
      },
    };

    const ctx = {
      pool,
      config: { defaultGroups: ['user'] },
      actor: { userId: adminId },
      identityScope: scope,
      identityMode: 'pseudo_ref',
      body: {
        ref: 'pseudo:kerttu',
      },
    };

    const res = await userHandlers.createUser(ctx);
    expect(res.status).toBe(201);
    expect(res.body.email).toBe('kerttu@riihimaenseurakunta.fi');
    expect(res.body.display_name).toBe('Kerttu Kanttori');
    expect(insertedUser).toEqual({
      id: 'new-user-123',
      email: 'kerttu@riihimaenseurakunta.fi',
      display_name: 'Kerttu Kanttori',
    });
    expect(linkedSubject).toEqual({
      userId: 'new-user-123',
      subjectId: 'subj-external-1',
      ownerUserId: adminId,
    });
  });

  it('accepts ref passed in email field as fallback', async () => {
    let insertedUser = null;
    const client = {
      async query(sql, params) {
        if (sql.includes('INSERT INTO users')) {
          insertedUser = { id: 'new-user-456', email: params[0], display_name: params[1] };
          return { rows: [insertedUser] };
        }
        if (sql.includes('UPDATE mcp_identity_subjects')) {
          return { rows: [{ id: params[1], tunnus_user_id: params[0] }] };
        }
        return { rows: [] };
      },
    };

    const pool = {
      async connect() {
        return {
          ...client,
          release: () => {},
        };
      },
      async query(sql) {
        if (sql.includes('FROM mcp_pseudonyms p')) {
          return {
            rows: [
              {
                id: 'subj-external-2',
                tunnus_user_id: null,
                label: 'pekka@example.org',
                pseudonym: 'pekka',
              },
            ],
          };
        }
        if (sql.includes('FROM users u') || sql.includes('WHERE u.id = $1')) {
          return {
            rows: [
              {
                id: 'new-user-456',
                email: 'pekka@example.org',
                display_name: 'pekka',
                status: 'active',
                is_admin: false,
                created_at: new Date(),
                groups: ['user'],
              },
            ],
          };
        }
        return { rows: [] };
      },
    };

    const ctx = {
      pool,
      config: { defaultGroups: ['user'] },
      actor: { userId: adminId },
      identityScope: scope,
      identityMode: 'pseudo_ref',
      body: {
        email: 'pseudo:pekka',
      },
    };

    const res = await userHandlers.createUser(ctx);
    expect(res.status).toBe(201);
    expect(insertedUser.email).toBe('pekka@example.org');
  });

  it('rejects createUser if the identity is already linked to a user', async () => {
    const pool = {
      async query(sql) {
        if (sql.includes('FROM mcp_pseudonyms p')) {
          return {
            rows: [
              {
                id: 'subj-already-linked',
                tunnus_user_id: '99999999-9999-4999-8999-999999999999',
                label: 'Existing Person',
                pseudonym: 'existing',
              },
            ],
          };
        }
        return { rows: [] };
      },
    };

    const ctx = {
      pool,
      config: { defaultGroups: ['user'] },
      actor: { userId: adminId },
      identityScope: scope,
      identityMode: 'pseudo_ref',
      body: {
        ref: 'pseudo:existing',
      },
    };

    await expect(userHandlers.createUser(ctx)).rejects.toThrow(
      'This identity is already linked to a Tunnus account',
    );
  });

  it('rejects createUser if no email and reference label has no email', async () => {
    const pool = {
      async query(sql) {
        if (sql.includes('FROM mcp_pseudonyms p')) {
          return {
            rows: [
              {
                id: 'subj-no-email',
                tunnus_user_id: null,
                label: 'Only A Name Without Email',
                pseudonym: 'nameless',
              },
            ],
          };
        }
        return { rows: [] };
      },
    };

    const ctx = {
      pool,
      config: { defaultGroups: ['user'] },
      actor: { userId: adminId },
      identityScope: scope,
      identityMode: 'pseudo_ref',
      body: {
        ref: 'pseudo:nameless',
      },
    };

    await expect(userHandlers.createUser(ctx)).rejects.toThrow(
      'Email is required when reference identity label does not contain a valid email address',
    );
  });
});
