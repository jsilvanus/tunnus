import { bootstrapAdmin } from '../../src/bootstrap.js';
import { startTunnus } from './harness.js';

export const ADMIN_EMAIL = 'admin@example.org';

/**
 * Start Tunnus with an admin user and a token for it.
 * @param {{ schema: string, env?: Record<string, string>, clients?: Record<string, any>[] }} opts
 */
export async function startAdmin(opts) {
  const tunnus = await startTunnus(opts);
  const admin = await bootstrapAdmin(tunnus.pool, {
    email: ADMIN_EMAIL,
    name: 'Admin Example',
    label: 'test',
    expiresDays: 90,
    defaultGroups: tunnus.config.defaultGroups,
  });
  const base = `${tunnus.issuer}/admin/api/v1`;

  /**
   * Call the admin API. `token`: undefined uses the admin token, null sends none, a string is used as is.
   * @param {string} method
   * @param {string} path
   * @param {{ body?: unknown, raw?: string, token?: string | null, headers?: Record<string, string> }} [opts]
   * @returns {Promise<{ status: number, body: any, headers: Headers }>}
   */
  async function api(method, path, { body, raw, token, headers = {} } = {}) {
    const auth = token === undefined ? admin.token : token;
    const h = { ...headers };
    if (auth) h.authorization = `Bearer ${auth}`;
    let payload;
    if (raw !== undefined) {
      payload = raw;
      h['content-type'] ??= 'application/json';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      h['content-type'] = 'application/json';
    }
    const res = await fetch(`${base}${path}`, { method, headers: h, body: payload });
    const text = await res.text();
    const isJson = (res.headers.get('content-type') ?? '').includes('json');
    return {
      status: res.status,
      body: isJson && text ? JSON.parse(text) : text,
      headers: res.headers,
    };
  }

  return {
    ...tunnus,
    token: admin.token,
    adminId: admin.userId,
    base,
    api,
  };
}
