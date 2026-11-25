import { AdminError } from '../errors.js';
import {
  createService as createServiceRecord,
  deleteService as deleteServiceRecord,
  getService as getServiceRecord,
  listServices as listServiceRecords,
  patchService as patchServiceRecord,
  putService as putServiceRecord,
  ServiceError,
} from '../../services/store.js';

/** @typedef {import('../types.js').HandlerContext} HandlerContext */
/** @typedef {import('../types.js').HandlerResult} HandlerResult */

/**
 * Map a ServiceError to an AdminError.
 * @param {unknown} err
 */
function mapServiceError(err) {
  if (!(err instanceof ServiceError)) return err;
  if (err.code === 'not_found') return new AdminError(404, 'not_found', err.message);
  if (err.code === 'conflict') return new AdminError(409, 'conflict', err.message);
  return new AdminError(400, 'invalid_request', err.message, err.details);
}

export const handlers = {
  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async listServices(ctx) {
    const includeDisabled = ctx.query.include_disabled === true || ctx.query.include_disabled === 'true';
    const type = typeof ctx.query.type === 'string' ? ctx.query.type : undefined;
    const venue = typeof ctx.query.venue === 'string' ? ctx.query.venue : undefined;

    const items = await listServiceRecords(ctx.pool, {
      includeDisabled,
      type,
      venue,
    });
    return { body: { items } };
  },

  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async getService(ctx) {
    const serviceId = String(ctx.params.serviceId);
    let service;
    try {
      service = await getServiceRecord(ctx.pool, serviceId);
    } catch (err) {
      throw mapServiceError(err);
    }
    if (!service) {
      throw new AdminError(404, 'not_found', `Service "${serviceId}" not found`);
    }
    return { body: service };
  },

  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async createService(ctx) {
    let service;
    try {
      service = await createServiceRecord(ctx.pool, ctx.body, {
        userId: ctx.actor?.userId ?? undefined,
      });
    } catch (err) {
      throw mapServiceError(err);
    }
    return {
      status: 201,
      body: service,
      audit: {
        targetType: 'service',
        targetId: service.id,
        details: { action: 'created', type: service.type, venue: service.venue },
      },
    };
  },

  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async putService(ctx) {
    const serviceId = String(ctx.params.serviceId);
    let result;
    try {
      result = await putServiceRecord(ctx.pool, serviceId, ctx.body, {
        userId: ctx.actor?.userId ?? undefined,
      });
    } catch (err) {
      throw mapServiceError(err);
    }
    return {
      status: result.created ? 201 : 200,
      body: result.service,
      audit: {
        targetType: 'service',
        targetId: serviceId,
        details: { created: result.created },
      },
    };
  },

  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async updateService(ctx) {
    const serviceId = String(ctx.params.serviceId);
    let service;
    try {
      service = await patchServiceRecord(ctx.pool, serviceId, ctx.body, {
        userId: ctx.actor?.userId ?? undefined,
      });
    } catch (err) {
      throw mapServiceError(err);
    }
    return {
      body: service,
      audit: {
        targetType: 'service',
        targetId: serviceId,
        details: { action: 'updated' },
      },
    };
  },

  /**
   * @param {HandlerContext} ctx
   * @returns {Promise<HandlerResult>}
   */
  async deleteService(ctx) {
    const serviceId = String(ctx.params.serviceId);
    let deleted;
    try {
      deleted = await deleteServiceRecord(ctx.pool, serviceId, {
        userId: ctx.actor?.userId ?? undefined,
      });
    } catch (err) {
      throw mapServiceError(err);
    }
    if (!deleted) {
      throw new AdminError(404, 'not_found', `Service "${serviceId}" not found`);
    }
    return {
      status: 204,
      body: undefined,
      audit: {
        targetType: 'service',
        targetId: serviceId,
        details: { action: 'deleted' },
      },
    };
  },
};
