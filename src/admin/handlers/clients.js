import { AdminError } from '../errors.js';
import { errorFields, logger } from '../../logger.js';
import {
  adoptClient as adoptClientRecord,
  ClientError,
  clientJson,
  deleteClient as deleteClientRecord,
  getClient as getClientRecord,
  listClientRecords,
  patchClient,
  putClient as putClientRecord,
  rotateSecret,
} from '../../clients/store.js';

/** @typedef {import('../types.js').HandlerContext} HandlerContext */
/** @typedef {import('../types.js').HandlerResult} HandlerResult */

/**
 * Map a store/validation ClientError to the HTTP AdminError.
 * @param {unknown} err
 */
function mapClientError(err) {
  if (!(err instanceof ClientError)) return err;
  if (err.code === 'not_found') return new AdminError(404, 'not_found', err.message);
  if (err.code === 'client_managed_by_file') {
    return new AdminError(409, 'client_managed_by_file', err.message);
  }
  return new AdminError(400, 'invalid_request', err.message, err.details);
}

/**
 * Reload the provider after a committed client change. A failed reload is logged so the HTTP
 * caller still sees the committed write (the periodic check / NOTIFY picks it up).
 * @param {HandlerContext} ctx
 */
async function reloadAfterChange(ctx) {
  try {
    await ctx.reloadKeys();
  } catch (err) {
    logger.error({ err: errorFields(err) }, 'client reload after change failed');
  }
}

export const handlers = {
  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async listClients(ctx) {
    const rows = await listClientRecords(ctx.pool);
    return { body: { items: rows.map(clientJson) } };
  },

  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async getClient(ctx) {
    const clientId = String(ctx.params.clientId);
    let row;
    try {
      row = await getClientRecord(ctx.pool, clientId);
    } catch (err) {
      throw mapClientError(err);
    }
    if (!row) throw new AdminError(404, 'not_found', `Client "${clientId}" not found`);
    return { body: clientJson(row) };
  },

  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async putClient(ctx) {
    const clientId = String(ctx.params.clientId);
    const { client_secret: clientSecret, disabled = false, ...metadata } = ctx.body;
    let result;
    try {
      result = await putClientRecord(ctx.pool, ctx.config.keyEncryptionSecret, {
        clientId,
        metadata,
        clientSecret,
        disabled,
        actorUserId: ctx.actor?.userId ?? null,
        ip: ctx.ip,
        provider: ctx.getProvider?.(),
      });
    } catch (err) {
      throw mapClientError(err);
    }
    if (result.created || result.changed) {
      await reloadAfterChange(ctx);
    }
    const baseBody = clientJson(result.record);
    return {
      status: result.created ? 201 : 200,
      body: result.generatedSecret
        ? { ...baseBody, client_secret: result.generatedSecret }
        : baseBody,
      audit: {
        targetType: 'client',
        targetId: clientId,
        details: { created: result.created, changed: result.changed },
      },
    };
  },

  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async updateClient(ctx) {
    const clientId = String(ctx.params.clientId);
    let result;
    try {
      result = await patchClient(ctx.pool, ctx.config.keyEncryptionSecret, {
        clientId,
        patch: ctx.body,
        actorUserId: ctx.actor?.userId ?? null,
        ip: ctx.ip,
        provider: ctx.getProvider?.(),
      });
    } catch (err) {
      throw mapClientError(err);
    }
    if (result.changed) {
      await reloadAfterChange(ctx);
    }
    return {
      body: clientJson(result.record),
      audit: {
        targetType: 'client',
        targetId: clientId,
        details: { changed: result.changed },
      },
    };
  },

  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async rotateClientSecret(ctx) {
    const clientId = String(ctx.params.clientId);
    const body = ctx.body ?? {};
    let result;
    try {
      result = await rotateSecret(ctx.pool, ctx.config.keyEncryptionSecret, {
        clientId,
        clientSecret: body.client_secret,
        revokeTokens: Boolean(body.revoke_tokens),
        actorUserId: ctx.actor?.userId ?? null,
        ip: ctx.ip,
      });
    } catch (err) {
      throw mapClientError(err);
    }
    await reloadAfterChange(ctx);
    const formatted = clientJson(result.record);
    return {
      body: {
        client_id: formatted.client_id,
        secret_set_at: formatted.secret_set_at,
        ...(result.generatedSecret ? { client_secret: result.generatedSecret } : {}),
        revoked: result.revoked,
      },
      audit: {
        targetType: 'client',
        targetId: clientId,
        details: { revoke_tokens: Boolean(body.revoke_tokens), revoked: result.revoked },
      },
    };
  },

  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async adoptClient(ctx) {
    const clientId = String(ctx.params.clientId);
    let result;
    try {
      result = await adoptClientRecord(ctx.pool, {
        clientId,
        actorUserId: ctx.actor?.userId ?? null,
        ip: ctx.ip,
      });
    } catch (err) {
      throw mapClientError(err);
    }
    if (result.adopted) {
      await reloadAfterChange(ctx);
    }
    return {
      body: clientJson(result.record),
      audit: {
        targetType: 'client',
        targetId: clientId,
        details: { adopted: result.adopted },
      },
    };
  },

  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async deleteClient(ctx) {
    const clientId = String(ctx.params.clientId);
    let result;
    try {
      result = await deleteClientRecord(ctx.pool, {
        clientId,
        actorUserId: ctx.actor?.userId ?? null,
        ip: ctx.ip,
      });
    } catch (err) {
      throw mapClientError(err);
    }
    await reloadAfterChange(ctx);
    return {
      status: 204,
      audit: {
        targetType: 'client',
        targetId: clientId,
        details: { revoked: result.revoked },
      },
    };
  },
};
