import { notImplemented } from '../stub.js';

/** @typedef {import('../types.js').HandlerResult} HandlerResult */

export const handlers = {
  /** @returns {Promise<HandlerResult>} */
  async listUserGroups() {
    return notImplemented();
  },
  /** @returns {Promise<HandlerResult>} */
  async listGroups() {
    return notImplemented();
  },
  /** @returns {Promise<HandlerResult>} */
  async createGroup() {
    return notImplemented();
  },
  /** @returns {Promise<HandlerResult>} */
  async getGroup() {
    return notImplemented();
  },
  /** @returns {Promise<HandlerResult>} */
  async updateGroup() {
    return notImplemented();
  },
  /** @returns {Promise<HandlerResult>} */
  async deleteGroup() {
    return notImplemented();
  },
  /** @returns {Promise<HandlerResult>} */
  async listGroupMembers() {
    return notImplemented();
  },
  /** @returns {Promise<HandlerResult>} */
  async grantMembership() {
    return notImplemented();
  },
  /** @returns {Promise<HandlerResult>} */
  async revokeMembership() {
    return notImplemented();
  },
};
