import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createWebhookRouter } from '../src/web/webhookRouter.js';
import { formatSlackPayload, formatDiscordPayload } from '../src/webhooks.js';

describe('Central Webhook Engine (Tunnus)', () => {
  it('formats Slack payload with block kit structure', () => {
    const payload = {
      event: 'asset.created',
      timestamp: '2026-11-25T20:00:00.000Z',
      parishSlug: 'riihimaki',
      asset: {
        id: '123',
        title: 'Seurakunnan Logo',
        format: 'svg',
        kind: 'logo',
      },
      context: { channel: 'canva', canvaDesignTitle: 'Joulujuhla' },
    };

    const slack = formatSlackPayload(payload);
    expect(slack.text).toContain('Seurakunnan Logo');
    expect(slack.blocks).toHaveLength(3);
    expect(slack.blocks[0].text.text).toContain('Uusi media lisätty');
  });

  it('formats Discord payload with embeds', () => {
    const payload = {
      event: 'asset.used',
      timestamp: '2026-11-25T20:00:00.000Z',
      parishSlug: 'riihimaki',
      asset: {
        id: '123',
        title: 'Kirkkokuva',
        format: 'png',
        kind: 'photo',
      },
    };

    const discord = formatDiscordPayload(payload);
    expect(discord.embeds).toHaveLength(1);
    expect(discord.embeds[0].title).toBe('🚀 Media otettu käyttöön');
  });

  describe('Webhook Endpoints', () => {
    let app;
    let pool;
    const token = 'test-token-valopankki';

    beforeEach(() => {
      pool = {
        query: vi.fn(),
      };
      app = express();
      app.use(
        createWebhookRouter({
          pool: /** @type {any} */ (pool),
          token,
        })
      );
    });

    it('POST /api/events requires valid authorization', async () => {
      const res = await request(app)
        .post('/api/events')
        .send({ event: 'asset.created' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
    });

    it('POST /api/events dispatches matching active hooks', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'hook-1',
            name: 'Slack Alerts',
            url: 'https://hooks.slack.com/services/T00/B00/X00',
            events: ['asset.created'],
            secret: null,
          },
        ],
      });
      // audit query
      pool.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/events')
        .set('Authorization', `Bearer ${token}`)
        .send({
          event: 'asset.created',
          parishSlug: 'riihimaki',
          asset: { id: '1', title: 'Banner' },
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.dispatched).toBe(1);
    });

    it('CRUD hooks: registers new hook on POST /api/v1/notifications/hooks', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'hook-new-uuid',
            name: 'My Discord',
            url: 'https://discord.com/api/webhooks/123/abc',
            events: ['*'],
          },
        ],
      });

      const res = await request(app)
        .post('/api/v1/notifications/hooks')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'My Discord',
          url: 'https://discord.com/api/webhooks/123/abc',
          events: ['*'],
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('hook-new-uuid');
    });
  });
});
