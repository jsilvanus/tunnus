import { describe, expect, it } from 'vitest';
import { handlers } from '../src/admin/handlers/users.js';

describe('user directory and autofill account search', () => {
  it('searches users with unified q matching title, display_name or email', async () => {
    /** @type {any[]} */
    let capturedParams = [];
    /** @type {any} */
    const pool = {
      query: async (/** @type {string} */ _sql, /** @type {any[]} */ params) => {
        capturedParams = params;
        return {
          rows: [
            {
              id: 'u-1',
              email: 'anna.pastori@example.org',
              display_name: 'Anna Pastori',
              title: 'Kirkkoherra',
              phone_number: '+358401234567',
              status: 'active',
              is_admin: false,
              created_at: '2026-11-20T00:00:00.000Z',
              last_login_at: null,
              last_email_verified_at: null,
              activates_at: null,
              disables_at: null,
              disabled_at: null,
              totp_enabled_at: null,
              groups: ['staff'],
            },
          ],
        };
      },
    };

    const res = await handlers.listUsers(/** @type {any} */ ({
      pool,
      query: { q: 'Kirkkoherra', limit: 10 },
    }));

    expect(capturedParams[0]).toBe('%Kirkkoherra%');
    expect((/** @type {any} */ (res.body)).items).toHaveLength(1);
    expect((/** @type {any} */ (res.body)).items[0]).toEqual({
      id: 'u-1',
      email: 'anna.pastori@example.org',
      display_name: 'Anna Pastori',
      title: 'Kirkkoherra',
      phone_number: '+358401234567',
      status: 'active',
      is_admin: false,
      created_at: '2026-11-20T00:00:00.000Z',
      last_login_at: null,
      last_email_verified_at: null,
      activates_at: null,
      disables_at: null,
      disabled_at: null,
      totp_enabled: false,
      groups: ['staff'],
    });
  });

  it('filters specifically by name, title, email, and status', async () => {
    /** @type {any[]} */
    let capturedParams = [];
    /** @type {any} */
    const pool = {
      query: async (/** @type {string} */ _sql, /** @type {any[]} */ params) => {
        capturedParams = params;
        return { rows: [] };
      },
    };

    await handlers.listUsers(/** @type {any} */ ({
      pool,
      query: {
        name: 'Anna',
        title: 'Pastori',
        email: 'anna@example.org',
        status: 'active',
        limit: 25,
      },
    }));

    // params: pattern(q), email, status, isAdmin, groupId, groupPrefix, namePattern, titlePattern, after, limit+1
    expect(capturedParams[1]).toBe('anna@example.org');
    expect(capturedParams[2]).toBe('active');
    expect(capturedParams[6]).toBe('%Anna%');
    expect(capturedParams[7]).toBe('%Pastori%');
    expect(capturedParams[9]).toBe(26);
  });
});
