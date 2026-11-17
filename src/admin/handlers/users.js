import { notImplemented } from '../stub.js';

/** @typedef {import('../types.js').HandlerResult} HandlerResult */

export const handlers = {
  /** @returns {Promise<HandlerResult>} */
  async listUsers() {
    return notImplemented();
  },
  /** @returns {Promise<HandlerResult>} */
  async createUser() {
    return notImplemented();
  },
  /** @returns {Promise<HandlerResult>} */
  async getUser() {
    return notImplemented();
  },
  /** @returns {Promise<HandlerResult>} */
  async updateUser() {
    return notImplemented();
  },
  /** @returns {Promise<HandlerResult>} */
  async deleteUser() {
    return notImplemented();
  },
  /** @returns {Promise<HandlerResult>} */
  async revokeUserSessions() {
    return notImplemented();
  },
};
