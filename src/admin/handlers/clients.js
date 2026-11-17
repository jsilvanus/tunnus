/** @typedef {import('../types.js').HandlerContext} HandlerContext */
/** @typedef {import('../types.js').HandlerResult} HandlerResult */

/**
 * The Client schema, built from an allowlist so client_secret can never leak.
 * @param {Record<string, any>} c one entry of CLIENTS_FILE
 */
function clientJson(c) {
  return {
    client_id: String(c.client_id),
    redirect_uris: [...(c.redirect_uris ?? [])],
    post_logout_redirect_uris: [...(c.post_logout_redirect_uris ?? [])],
    token_endpoint_auth_method: c.token_endpoint_auth_method ?? 'client_secret_basic',
    grant_types: [...(c.grant_types ?? ['authorization_code'])],
    first_party: Boolean(c.first_party),
    always_include_groups: Boolean(c.always_include_groups),
  };
}

export const handlers = {
  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async listClients(ctx) {
    return { body: { items: ctx.clients.map(clientJson) } };
  },
};
