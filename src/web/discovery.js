import express from 'express';
import { getDiscoveryCatalog } from '../services/store.js';

/**
 * Public Service Discovery Router.
 * Mounted at `/api/v1/discovery` and `/discovery`.
 * @param {{ pool: import('pg').Pool }} deps
 */
export function createDiscoveryRouter({ pool }) {
  const router = express.Router();

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

  router.get('/api/v1/discovery', handleDiscovery);
  router.get('/api/v1/discovery/:type', handleDiscovery);
  router.get('/discovery', handleDiscovery);

  return router;
}
