export const SERVICE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const SERVICE_TYPE_PATTERN = /^[a-z0-9_-]{1,32}$/;
export const VENUE_PATTERN = /^[a-z0-9_-]{1,32}$/;
export const ALLOWED_AUTH_TYPES = new Set(['none', 'api_key', 'bearer', 'oidc']);

/**
 * Error for service registry validation, conflict, or lookup failures.
 */
export class ServiceError extends Error {
  /**
   * @param {'invalid_request' | 'not_found' | 'conflict' | 'forbidden'} code
   * @param {string} message
   * @param {{ path: string, message: string }[]} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Validates a service ID.
 * @param {unknown} id
 * @returns {string}
 */
export function validateServiceId(id) {
  if (typeof id !== 'string' || !SERVICE_ID_PATTERN.test(id)) {
    throw new ServiceError(
      'invalid_request',
      'id must be 1-64 characters matching ^[a-z0-9][a-z0-9._-]{0,63}$',
      [{ path: 'id', message: 'invalid service identifier' }],
    );
  }
  return id;
}

/**
 * Checks if value is a plain non-null object.
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validates an HTTP or HTTPS URL.
 * @param {unknown} val
 * @param {string} path
 * @returns {string}
 */
function validateUrl(val, path = 'endpoint_url') {
  if (typeof val !== 'string' || !val.trim()) {
    throw new ServiceError('invalid_request', `${path} is required`, [
      { path, message: 'URL string is required' },
    ]);
  }
  let parsed;
  try {
    parsed = new URL(val.trim());
  } catch {
    throw new ServiceError('invalid_request', `${path} must be a valid URL`, [
      { path, message: 'invalid URL format' },
    ]);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ServiceError('invalid_request', `${path} must use http or https protocol`, [
      { path, message: 'protocol must be http: or https:' },
    ]);
  }
  return parsed.toString();
}

/**
 * Validates the auth configuration object.
 * @param {unknown} auth
 * @returns {Record<string, unknown>}
 */
export function validateServiceAuth(auth) {
  if (auth === undefined || auth === null) {
    return { type: 'none' };
  }
  if (!isPlainObject(auth)) {
    throw new ServiceError('invalid_request', 'auth must be an object', [
      { path: 'auth', message: 'must be an object' },
    ]);
  }
  const type = auth.type ?? 'none';
  if (typeof type !== 'string' || !ALLOWED_AUTH_TYPES.has(type)) {
    throw new ServiceError(
      'invalid_request',
      `auth.type must be one of: ${[...ALLOWED_AUTH_TYPES].join(', ')}`,
      [{ path: 'auth.type', message: 'invalid auth type' }],
    );
  }

  const result = { type };
  if (auth.client_id !== undefined) {
    if (typeof auth.client_id !== 'string') {
      throw new ServiceError('invalid_request', 'auth.client_id must be a string', [
        { path: 'auth.client_id', message: 'must be a string' },
      ]);
    }
    result.client_id = auth.client_id.trim();
  }

  if (auth.scopes !== undefined) {
    if (!Array.isArray(auth.scopes) || !auth.scopes.every((s) => typeof s === 'string')) {
      throw new ServiceError('invalid_request', 'auth.scopes must be an array of strings', [
        { path: 'auth.scopes', message: 'must be string[]' },
      ]);
    }
    result.scopes = auth.scopes;
  }

  if (auth.audience !== undefined) {
    if (typeof auth.audience !== 'string') {
      throw new ServiceError('invalid_request', 'auth.audience must be a string', [
        { path: 'auth.audience', message: 'must be a string' },
      ]);
    }
    result.audience = auth.audience.trim();
  }

  if (auth.header_name !== undefined) {
    if (typeof auth.header_name !== 'string') {
      throw new ServiceError('invalid_request', 'auth.header_name must be a string', [
        { path: 'auth.header_name', message: 'must be a string' },
      ]);
    }
    result.header_name = auth.header_name.trim();
  }

  return result;
}

/**
 * Validates a service payload for create or update.
 * @param {Record<string, unknown>} body
 * @param {{ isUpdate?: boolean }} [options]
 */
export function validateServiceInput(body, { isUpdate = false } = {}) {
  if (!isPlainObject(body)) {
    throw new ServiceError('invalid_request', 'Request body must be a JSON object');
  }

  const details = [];
  const result = {};

  if (!isUpdate || body.id !== undefined) {
    if (!isUpdate && body.id === undefined) {
      details.push({ path: 'id', message: 'id is required' });
    } else {
      try {
        result.id = validateServiceId(body.id);
      } catch (err) {
        if (err instanceof ServiceError && err.details) {
          details.push(...err.details);
        } else {
          details.push({ path: 'id', message: 'invalid id' });
        }
      }
    }
  }

  if (!isUpdate || body.name !== undefined) {
    if (!isUpdate && body.name === undefined) {
      details.push({ path: 'name', message: 'name is required' });
    } else if (typeof body.name !== 'string' || body.name.trim().length === 0 || body.name.length > 100) {
      details.push({ path: 'name', message: 'name must be 1-100 characters' });
    } else {
      result.name = body.name.trim();
    }
  }

  if (!isUpdate || body.type !== undefined) {
    if (!isUpdate && body.type === undefined) {
      details.push({ path: 'type', message: 'type is required' });
    } else if (typeof body.type !== 'string' || !SERVICE_TYPE_PATTERN.test(body.type)) {
      details.push({ path: 'type', message: 'type must be 1-32 chars matching ^[a-z0-9_-]+$' });
    } else {
      result.type = body.type.trim();
    }
  }

  if (!isUpdate || body.venue !== undefined) {
    if (!isUpdate && body.venue === undefined) {
      details.push({ path: 'venue', message: 'venue is required' });
    } else if (typeof body.venue !== 'string' || !VENUE_PATTERN.test(body.venue)) {
      details.push({ path: 'venue', message: 'venue must be 1-32 chars matching ^[a-z0-9_-]+$' });
    } else {
      result.venue = body.venue.trim();
    }
  }

  const rawUrl = body.endpoint_url !== undefined ? body.endpoint_url : body.url;
  if (!isUpdate || rawUrl !== undefined) {
    if (!isUpdate && rawUrl === undefined) {
      details.push({ path: 'endpoint_url', message: 'endpoint_url is required' });
    } else {
      try {
        result.endpoint_url = validateUrl(rawUrl, 'endpoint_url');
      } catch (err) {
        if (err instanceof ServiceError && err.details) {
          details.push(...err.details);
        } else {
          details.push({ path: 'endpoint_url', message: 'invalid endpoint_url' });
        }
      }
    }
  }

  if (body.auth !== undefined) {
    try {
      result.auth = validateServiceAuth(body.auth);
    } catch (err) {
      if (err instanceof ServiceError && err.details) {
        details.push(...err.details);
      } else {
        details.push({ path: 'auth', message: 'invalid auth' });
      }
    }
  } else if (!isUpdate) {
    result.auth = { type: 'none' };
  }

  if (body.capabilities !== undefined) {
    if (!Array.isArray(body.capabilities) || !body.capabilities.every((c) => typeof c === 'string')) {
      details.push({ path: 'capabilities', message: 'capabilities must be an array of strings' });
    } else {
      result.capabilities = body.capabilities.map((c) => c.trim()).filter(Boolean);
    }
  } else if (!isUpdate) {
    result.capabilities = [];
  }

  if (body.metadata !== undefined) {
    if (!isPlainObject(body.metadata)) {
      details.push({ path: 'metadata', message: 'metadata must be a JSON object' });
    } else {
      result.metadata = body.metadata;
    }
  } else if (!isUpdate) {
    result.metadata = {};
  }

  if (body.disabled !== undefined) {
    if (typeof body.disabled !== 'boolean') {
      details.push({ path: 'disabled', message: 'disabled must be a boolean' });
    } else {
      result.disabled = body.disabled;
    }
  } else if (!isUpdate) {
    result.disabled = false;
  }

  if (details.length > 0) {
    throw new ServiceError('invalid_request', 'Service validation failed', details);
  }

  return result;
}
