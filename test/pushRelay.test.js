import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createPushRouter, validateSubscriptionBody } from '../src/web/pushRelay.js';

describe('Web Push Relay Router & Validation', () => {
  it('validates subscription body format correctly', () => {
    expect(validateSubscriptionBody(null).ok).toBe(false);
    expect(validateSubscriptionBody({ endpoint: 'http://insecure.com' }).ok).toBe(false);
    expect(validateSubscriptionBody({ endpoint: 'https://push.example.com' }).ok).toBe(false);
    expect(
      validateSubscriptionBody({
        endpoint: 'https://push.example.com',
        keys: { p256dh: 'abc' },
      }).ok
    ).toBe(false);

    const valid = validateSubscriptionBody({
      endpoint: 'https://push.example.com',
      keys: { p256dh: 'valid_p256dh', auth: 'valid_auth' },
    });
    expect(valid.ok).toBe(true);
  });

  describe('Endpoints', () => {
    let app;
    let pool;
    const token = 'test-push-token-123456';
    const vapidPublicKey = 'BEl62iUYgUivxIkv69yViEuiBIa...';

    beforeEach(() => {
      pool = {
        query: vi.fn(),
      };
      app = express();
      app.use(
        createPushRouter({
          pool: /** @type {any} */ (pool),
          token,
          vapidPublicKey,
        })
      );
    });

    it('GET /api/push/key returns the VAPID public key', async () => {
      const res = await request(app).get('/api/push/key');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ publicKey: vapidPublicKey });
    });

    it('POST /api/push/subscribe registers subscription in DB', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'sub-uuid-1',
            endpoint: 'https://push.example.com/sub1',
            p256dh: 'key1',
            auth: 'auth1',
          },
        ],
      });

      const res = await request(app)
        .post('/api/push/subscribe')
        .send({
          endpoint: 'https://push.example.com/sub1',
          keys: { p256dh: 'key1', auth: 'auth1' },
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, id: 'sub-uuid-1' });
      expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it('POST /api/push/unsubscribe removes subscription', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/push/unsubscribe')
        .send({ endpoint: 'https://push.example.com/sub1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(pool.query).toHaveBeenCalledWith(
        'DELETE FROM push_subscriptions WHERE endpoint = $1',
        ['https://push.example.com/sub1']
      );
    });

    it('POST /api/push/send rejects unauthorized requests without valid bearer token', async () => {
      const res = await request(app)
        .post('/api/push/send')
        .send({
          userId: 'user-123',
          notification: { title: 'Test push' },
        });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
    });

    it('POST /api/push/send dispatches notifications to user devices', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'sub-1',
            endpoint: 'https://push.example.com/1',
            p256dh: 'p1',
            auth: 'a1',
          },
        ],
      });
      // Update last_used_at on success
      pool.query.mockResolvedValueOnce({ rows: [] });
      // Audit log query
      pool.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/push/send')
        .set('Authorization', `Bearer ${token}`)
        .send({
          userId: 'user-123',
          notification: { title: 'Työvuoro vahvistettu', body: 'Muista sunnuntain messu' },
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.total).toBe(1);
    });
  });
});
