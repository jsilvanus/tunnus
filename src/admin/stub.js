import { AdminError } from './errors.js';

/**
 * Body of a handler that is not written yet. Stubs keep the operation routed and documented.
 * @returns {never}
 */
export function notImplemented() {
  throw new AdminError(501, 'not_implemented', 'Not implemented');
}
