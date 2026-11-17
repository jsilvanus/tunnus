/**
 * An error with an HTTP status and a stable machine-readable code. Handlers throw these;
 * the router renders them as `{ error: { code, message, details? } }`.
 */
export class AdminError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {{ path: string, message: string }[]} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AdminError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * The JSON error body for an error code.
 * @param {string} code
 * @param {string} message
 * @param {{ path: string, message: string }[]} [details]
 */
export function errorBody(code, message, details) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

/**
 * Send an error response.
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {{ path: string, message: string }[]} [details]
 */
export function sendError(res, status, code, message, details) {
  res.status(status).json(errorBody(code, message, details));
}
