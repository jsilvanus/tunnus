import express from 'express';
import {
  getDiscoveryCatalog,
  getService,
  putClientService,
  deleteClientService,
  touchServiceHeartbeat,
} from '../services/store.js';
import { parseClientCredentials, authenticateOidcClient } from '../services/clientAuth.js';
import { ServiceError } from '../services/validate.js';

/**
 * Service Discovery Router.
 * Public catalog mounted at `/api/v1/discovery` and `/discovery`.
 * Client self-registration mounted at `/api/v1/discovery/services/:serviceId`.
 *
 * @param {{ pool: import('pg').Pool, keyEncryptionSecret?: string }} deps
 */
export function createDiscoveryRouter({ pool, keyEncryptionSecret }) {
  const router = express.Router();
  const parseJson = express.json({ limit: '100kb' });

  const requireClientAuth = async (req, res, next) => {
    if (!keyEncryptionSecret) {
      return res.status(500).json({
        error: 'server_error',
        message: 'Client authentication secret not configured',
      });
    }

    const creds = parseClientCredentials(req);
    if (!creds) {
      res.set('WWW-Authenticate', 'Basic realm="Service Discovery Registration"');
      return res.status(401).json({
        error: 'invalid_client',
        message: 'Client credentials required (Basic auth or X-Client-Id / X-Client-Secret)',
      });
    }

    const result = await authenticateOidcClient(
      pool,
      keyEncryptionSecret,
      creds.clientId,
      creds.clientSecret,
    );

    if (!result.ok) {
      if (result.status === 401) {
        res.set('WWW-Authenticate', 'Basic realm="Service Discovery Registration"');
      }
      return res.status(result.status).json({
        error: result.error,
        message: result.message,
      });
    }

    req.client = result.client;
    next();
  };

  const handleDiscovery = async (req, res, next) => {
    try {
      const type =
        typeof req.params.type === 'string'
          ? req.params.type
          : typeof req.query.type === 'string'
          ? req.query.type
          : undefined;
      const venue = typeof req.query.venue === 'string' ? req.query.venue : undefined;
      const capability =
        typeof req.query.capability === 'string' ? req.query.capability : undefined;

      const catalog = await getDiscoveryCatalog(pool, { type, venue, capability });

      const etag = `W/"${Buffer.from(catalog.updated_at).toString('base64url')}"`;
      res.set('ETag', etag);
      res.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=60');

      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      res.json(catalog);
    } catch (err) {
      next(err);
    }
  };

  const handleGetService = async (req, res, next) => {
    try {
      const service = await getService(pool, req.params.serviceId);
      if (!service || service.disabled) {
        return res.status(404).json({
          error: 'not_found',
          message: `Service '${req.params.serviceId}' not found`,
        });
      }
      res.json(service);
    } catch (err) {
      if (err instanceof ServiceError) {
        return res.status(err.code === 'not_found' ? 404 : 400).json({
          error: err.code,
          message: err.message,
        });
      }
      next(err);
    }
  };

  const handlePutService = async (req, res, next) => {
    try {
      const serviceId = req.params.serviceId;
      const body = req.body || {};
      const { service, created } = await putClientService(pool, serviceId, body, {
        clientId: req.client.clientId,
      });
      res.status(created ? 201 : 200).json(service);
    } catch (err) {
      if (err instanceof ServiceError) {
        const status = err.code === 'forbidden' ? 403 : err.code === 'not_found' ? 404 : 400;
        return res.status(status).json({
          error: err.code,
          message: err.message,
        });
      }
      next(err);
    }
  };

  const handleDeleteService = async (req, res, next) => {
    try {
      const serviceId = req.params.serviceId;
      const deleted = await deleteClientService(pool, serviceId, {
        clientId: req.client.clientId,
      });
      if (!deleted) {
        return res.status(404).json({
          error: 'not_found',
          message: `Service '${serviceId}' not found`,
        });
      }
      res.status(204).end();
    } catch (err) {
      if (err instanceof ServiceError) {
        const status = err.code === 'forbidden' ? 403 : err.code === 'not_found' ? 404 : 400;
        return res.status(status).json({
          error: err.code,
          message: err.message,
        });
      }
      next(err);
    }
  };

  const handleHeartbeat = async (req, res, next) => {
    try {
      const serviceId = req.params.serviceId;
      const service = await touchServiceHeartbeat(pool, serviceId, {
        clientId: req.client.clientId,
      });
      res.json({ ok: true, updated_at: service.updated_at });
    } catch (err) {
      if (err instanceof ServiceError) {
        const status = err.code === 'forbidden' ? 403 : err.code === 'not_found' ? 404 : 400;
        return res.status(status).json({
          error: err.code,
          message: err.message,
        });
      }
      next(err);
    }
  };

  // Public discovery endpoints
  router.get('/api/v1/discovery', handleDiscovery);
  router.get('/api/v1/discovery/services/:serviceId', handleGetService);
  router.get('/api/v1/discovery/:type', handleDiscovery);
  router.get('/discovery', handleDiscovery);
  router.get('/discovery/services/:serviceId', handleGetService);

  // Authenticated OIDC client self-registration endpoints
  router.put('/api/v1/discovery/services/:serviceId', parseJson, requireClientAuth, handlePutService);
  router.delete('/api/v1/discovery/services/:serviceId', requireClientAuth, handleDeleteService);
  router.post('/api/v1/discovery/services/:serviceId/heartbeat', requireClientAuth, handleHeartbeat);
  router.put('/discovery/services/:serviceId', parseJson, requireClientAuth, handlePutService);
  router.delete('/discovery/services/:serviceId', requireClientAuth, handleDeleteService);
  router.post('/discovery/services/:serviceId/heartbeat', requireClientAuth, handleHeartbeat);

  return router;
}
