import { describe, expect, it, vi } from 'vitest';
import { createFindAccount, isAccountActive } from '../src/accounts.js';
import { autoActivateScheduledUsers, autoDisableExpiredUsers } from '../src/jobs/cleanup.js';
import { dispatchAllBackchannelLogouts } from '../src/oidc/backchannel.js';
import { accountPage } from '../src/web/pages.js';

describe('account lifecycle and status checks', () => {
  it('evaluates isAccountActive correctly for active and inactive states', () => {
    const now = new Date('2026-11-22T10:00:00Z');

    expect(isAccountActive(null, now)).toBe(false);
    expect(isAccountActive({ status: 'disabled' }, now)).toBe(false);

    // Active with no timestamps
    expect(isAccountActive({ status: 'active' }, now)).toBe(true);

    // Future activation -> inactive
    expect(isAccountActive({ status: 'active', activates_at: '2026-11-22T12:00:00Z' }, now)).toBe(
      false,
    );

    // Past activation -> active
    expect(isAccountActive({ status: 'active', activates_at: '2026-11-22T08:00:00Z' }, now)).toBe(
      true,
    );

    // Past disabling -> inactive
    expect(isAccountActive({ status: 'active', disables_at: '2026-11-22T09:00:00Z' }, now)).toBe(
      false,
    );

    // Future disabling -> active
    expect(isAccountActive({ status: 'active', disables_at: '2026-11-22T15:00:00Z' }, now)).toBe(
      true,
    );
  });

  it('createFindAccount excludes title and phone_number from OIDC claims and rejects inactive accounts', async () => {
    const activeUser = {
      id: 'user-1',
      email: 'user1@example.org',
      display_name: 'User One',
      title: 'Pastori',
      phone_number: '+358401234567',
      status: 'active',
      groups: ['staff'],
    };

    /** @type {any} */
    const pool = {
      query: async () => ({
        rows: [activeUser],
      }),
    };

    const findAccount = createFindAccount(pool);
    const account = await findAccount({}, 'user-1');
    expect(account).toBeDefined();
    expect(account?.accountId).toBe('user-1');

    const claims = await account?.claims();
    expect(claims).toEqual({
      sub: 'user-1',
      email: 'user1@example.org',
      email_verified: true,
      name: 'User One',
      groups: ['staff'],
    });
    // Explicitly verify title and phone_number are not present in OIDC claims
    expect(/** @type {any} */ (claims).title).toBeUndefined();
    expect(/** @type {any} */ (claims).phone_number).toBeUndefined();

    // Inactive account returns undefined
    /** @type {any} */
    const inactivePool = {
      query: async () => ({
        rows: [{ ...activeUser, status: 'disabled' }],
      }),
    };
    const findInactive = createFindAccount(inactivePool);
    expect(await findInactive({}, 'user-1')).toBeUndefined();
  });

  it('accountPage renders title, phone_number, status badge, and inactive banner', () => {
    const ctx = /** @type {any} */ ({
      locale: 'fi',
      config: {
        brand: { name: 'Tunnus', privacyNoticeUrl: '/privacy' },
        issuer: 'https://auth.example.org',
      },
    });

    // Active account
    const activeHtml = accountPage(ctx, {
      basePath: '',
      email: 'anna@example.org',
      displayName: 'Anna A',
      title: 'Pastori',
      phoneNumber: '+35840111222',
      isActive: true,
      status: 'active',
      groups: ['parish/riihimaki'],
      totpEnabled: false,
      freshEmail: true,
      csrf: 'csrf123',
    });

    expect(activeHtml).toContain('Anna A');
    expect(activeHtml).toContain('Pastori');
    expect(activeHtml).toContain('+35840111222');
    expect(activeHtml).toContain('Aktiivinen');
    expect(activeHtml).not.toContain('Tilisi ei ole aktiivinen');

    // Inactive account
    const inactiveHtml = accountPage(ctx, {
      basePath: '',
      email: 'anna@example.org',
      displayName: 'Anna A',
      title: 'Pastori',
      phoneNumber: '+35840111222',
      isActive: false,
      status: 'disabled',
      groups: [],
      totpEnabled: false,
      freshEmail: true,
      csrf: 'csrf123',
    });

    expect(inactiveHtml).toContain('Ei aktiivinen');
    expect(inactiveHtml).toContain('Tilisi ei ole aktiivinen');
  });

  it('dispatchAllBackchannelLogouts notifies distinct clients and revokes user sessions', async () => {
    const queries = [];
    /** @type {any} */
    const pool = {
      query: async (/** @type {string} */ sql, /** @type {any[]} */ params) => {
        queries.push({ sql, params });
        if (sql.includes("payload->>'clientId'")) {
          return { rows: [{ client_id: 'client-app-1' }, { client_id: 'client-app-2' }] };
        }
        if (sql.includes('DELETE FROM oidc_payloads')) {
          return { rowCount: 3 };
        }
        return { rows: [] };
      },
    };

    /** @type {string[]} */
    const dispatched = [];
    const provider = {
      Client: {
        find: async (/** @type {string} */ cid) => ({
          clientId: cid,
          backchannel_logout_uri: `https://${cid}.example.org/logout`,
        }),
      },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      dispatched.push(String(url));
      return new Response('OK', { status: 200 });
    });

    try {
      // Mock active key query
      pool.query = async (/** @type {string} */ sql, /** @type {any[]} */ params) => {
        queries.push({ sql, params });
        if (sql.includes("payload->>'clientId'")) {
          return { rows: [{ client_id: 'client-app-1' }, { client_id: 'client-app-2' }] };
        }
        if (sql.includes('signing_keys')) {
          const { generateKey, encrypt } = await import('../src/oidc/keys.js');
          const { kid, priv } = generateKey();
          return {
            rows: [
              {
                kid,
                private_jwk: encrypt(JSON.stringify(priv), '01234567890123456789012345678901'),
              },
            ],
          };
        }
        if (sql.includes('DELETE FROM oidc_payloads')) {
          return { rowCount: 2 };
        }
        return { rows: [] };
      };

      const result = await dispatchAllBackchannelLogouts({
        config: /** @type {any} */ ({
          issuer: 'https://auth.example.org',
          keyEncryptionSecret: '01234567890123456789012345678901',
        }),
        pool,
        getProvider: () => provider,
        userId: 'u-123',
        reason: 'auto_disabled',
      });

      expect(result.clientIds).toEqual(['client-app-1', 'client-app-2']);
      expect(result.count).toBe(2);
      expect(dispatched).toContain('https://client-app-1.example.org/logout');
      expect(dispatched).toContain('https://client-app-2.example.org/logout');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('autoDisableExpiredUsers and autoActivateScheduledUsers manage account status based on time', async () => {
    const now = new Date('2026-11-22T10:00:00Z');
    /** @type {any[]} */
    const userUpdates = [];
    /** @type {any} */
    const pool = {
      connect: async () => ({
        query: async (/** @type {string} */ sql, /** @type {any[]} */ params) => {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
          if (sql.includes('UPDATE users')) {
            userUpdates.push({ sql, params });
            return { rowCount: 1 };
          }
          return { rows: [] };
        },
        release: () => {},
      }),
      query: async (/** @type {string} */ sql) => {
        if (sql.includes("status = 'active'") && sql.includes('disables_at <=')) {
          return { rows: [{ id: 'user-to-disable' }] };
        }
        if (sql.includes("status = 'disabled'") && sql.includes('activates_at <=')) {
          return { rows: [{ id: 'user-to-activate' }] };
        }
        if (sql.includes("FROM oidc_payloads WHERE payload->>'accountId' = $1")) {
          return { rows: [] };
        }
        if (sql.includes('DELETE FROM oidc_payloads')) {
          return { rowCount: 0 };
        }
        return { rows: [] };
      },
    };

    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };

    const disabledCount = await autoDisableExpiredUsers({
      pool,
      config: /** @type {any} */ ({
        issuer: 'https://auth.example.org',
        keyEncryptionSecret: '01234567890123456789012345678901',
      }),
      logger,
      now,
    });
    expect(disabledCount).toBe(1);
    expect(userUpdates.some((u) => u.params?.includes('user-to-disable'))).toBe(true);

    const activatedCount = await autoActivateScheduledUsers({
      pool,
      logger,
      now,
    });
    expect(activatedCount).toBe(1);
    expect(userUpdates.some((u) => u.params?.includes('user-to-activate'))).toBe(true);
  });
});
