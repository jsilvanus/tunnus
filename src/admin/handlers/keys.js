import { notImplemented } from '../stub.js';

/** @typedef {import('../types.js').HandlerResult} HandlerResult */

export const handlers = {
  /** @returns {Promise<HandlerResult>} */
  async listKeys() {
    return notImplemented();
  },
  /** @returns {Promise<HandlerResult>} */
  async rotateKeys() {
    return notImplemented();
  },
  /** @returns {Promise<HandlerResult>} */
  async retireKey() {
    return notImplemented();
  },
};
