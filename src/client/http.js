/**
 * An API error response (`{ error: { code, message, details? } }`), or a failure to reach the server
 * (`code: 'network'`, `status: 0`).
 */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {{ path: string, message: string }[]} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Lines that describe an API error for people: `code: message`, then `path: message` per detail.
 * @param {ApiError} err
 * @returns {string[]}
 */
export function describeApiError(err) {
  return [
    `${err.code}: ${err.message}`,
    ...(err.details ?? []).map((d) => `  ${d.path}: ${d.message}`),
  ];
}

/**
 * @typedef {import('./operations.js').ClientOperation} ClientOperation
 * @typedef {{ status: number, body: any }} CallResult
 */

/**
 * HTTP client for the admin API at `<url>/admin/api/v1`. Holds no state besides the URL and token.
 * @param {{ url: string, token?: string, fetch?: typeof globalThis.fetch, admin?: any }} options
 */
export function createApiClient({ url, token, fetch = globalThis.fetch, admin }) {
  const base = `${url.replace(/\/+$/, '')}/admin/api/v1`;
  return {
    /**
     * Call one operation. `params` holds path and query values by spec name; `body` is the JSON body.
     * Undefined values are left out. Errors throw ApiError.
     * @param {ClientOperation} op
     * @param {{ params?: Record<string, unknown>, body?: unknown }} [args]
     * @returns {Promise<CallResult>}
     */
    async call(op, { params = {}, body } = {}) {
      const path = op.path.replace(/\{([^}]+)\}/g, (_, name) => {
        const value = params[name];
        if (value === undefined || value === null || value === '') {
          throw new TypeError(`missing path parameter ${name}`);
        }
        return encodeURIComponent(String(value));
      });
      const search = new URLSearchParams();
      for (const q of op.queryParams) {
        const value = params[q.name];
        if (value === undefined) continue;
        search.set(q.name, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
      const query = search.toString();

      /** @type {Record<string, string>} */
      const headers = { accept: 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;
      let payload;
      if (op.bodySchema && body !== undefined) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }

      let res;
      try {
        res = await fetch(`${base}${path}${query ? `?${query}` : ''}`, {
          method: op.method.toUpperCase(),
          headers,
          body: payload,
          ...(admin ? { admin } : {}),
        });
      } catch (/** @type {any} */ err) {
        throw new ApiError(
          0,
          'network',
          `Cannot reach ${base}: ${err?.cause?.message ?? err?.message}`,
        );
      }
      if (res.status === 204) return { status: 204, body: undefined };

      const text = await res.text();
      /** @type {any} */
      let parsed;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
      }
      if (res.ok) return { status: res.status, body: parsed };
      if (typeof parsed?.error?.code === 'string') {
        throw new ApiError(
          res.status,
          parsed.error.code,
          String(parsed.error.message ?? ''),
          parsed.error.details,
        );
      }
      throw new ApiError(
        res.status,
        'unexpected_response',
        `HTTP ${res.status} without an error body`,
      );
    },
  };
}
