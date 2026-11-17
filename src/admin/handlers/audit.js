import { notImplemented } from '../stub.js';

/** @typedef {import('../types.js').HandlerResult} HandlerResult */

export const handlers = {
  /** @returns {Promise<HandlerResult>} */
  async listAuditEvents() {
    return notImplemented();
  },
};
