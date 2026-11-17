import { AdminError } from '../errors.js';
import {
  KeyError,
  listKeys as listSigningKeys,
  retireKey as retireSigningKey,
  rotateKeys as rotateSigningKeys,
} from '../../oidc/keys.js';

/** @typedef {import('../types.js').HandlerContext} HandlerContext */
/** @typedef {import('../types.js').HandlerResult} HandlerResult */

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function iso(v) {
  return v ? new Date(/** @type {string | Date} */ (v)).toISOString() : null;
}

/**
 * The SigningKey schema. `public_jwk` is the public half only.
 * @param {Record<string, any>} row a key row from oidc/keys.js
 */
function keyJson(row) {
  return {
    kid: row.kid,
    alg: row.alg,
    status: row.status,
    created_at: iso(row.created_at),
    activated_at: iso(row.activated_at),
    retired_at: iso(row.retired_at),
    published_until: iso(row.published_until),
    published: row.published,
    public_jwk: row.public_jwk,
  };
}

/**
 * Run after a key change. The change is already committed, so a failed reload is logged rather than
 * reported as a failed rotation: a retry would rotate a second time. The periodic check picks it up.
 * @param {HandlerContext} ctx
 */
async function reloadAfterChange(ctx) {
  try {
    await ctx.reloadKeys();
  } catch (err) {
    console.error('signing key reload after change failed', { err });
  }
}

export const handlers = {
  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async listKeys(ctx) {
    const rows = await listSigningKeys(ctx.pool, {
      includeUnpublished: ctx.query.include_unpublished,
    });
    return { body: { items: rows.map(keyJson) } };
  },

  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async rotateKeys(ctx) {
    const result = await rotateSigningKeys(
      ctx.pool,
      ctx.config.keyEncryptionSecret,
      ctx.config.keyRetiredGraceDays,
    );
    await reloadAfterChange(ctx);
    return {
      body: {
        active: keyJson(result.active),
        next: keyJson(result.next),
        retired: keyJson(result.retired),
        warnings: result.warnings,
      },
      audit: {
        targetType: 'signing_key',
        targetId: result.active.kid,
        details: {
          retired_kid: result.retired.kid,
          new_next_kid: result.next.kid,
          warnings: result.warnings,
        },
      },
    };
  },

  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async retireKey(ctx) {
    const kid = String(ctx.params.kid);
    let result;
    try {
      result = await retireSigningKey(ctx.pool, ctx.config.keyEncryptionSecret, kid);
    } catch (err) {
      if (err instanceof KeyError && err.code === 'not_found') {
        throw new AdminError(404, 'not_found', 'Key not found');
      }
      if (err instanceof KeyError && err.code === 'key_active') {
        throw new AdminError(409, 'key_active', err.message);
      }
      throw err;
    }
    await reloadAfterChange(ctx);
    return {
      body: keyJson(result.row),
      audit: {
        targetType: 'signing_key',
        targetId: kid,
        details: {
          previous_status: result.previousStatus,
          new_next_kid: result.newNextKid,
        },
      },
    };
  },
};
