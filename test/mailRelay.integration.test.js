import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrevoTransport } from '../src/mail.js';
import { startTunnus } from './helpers/harness.js';

/** @type {Awaited<ReturnType<typeof startTunnus>> | undefined} */
let t;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('POST /api/mail integration', () => {
  it('relays an email through Brevo, records an audit event, and updates Prometheus metrics', async () => {
    /** @type {any[]} */
    const brevoBodies = [];
    const fetchMock = /** @type {typeof fetch} */ (
      /** @type {unknown} */ (
        async (/** @type {string} */ _url, /** @type {any} */ init) => {
          brevoBodies.push(JSON.parse(init.body));
          return new Response('{"messageId":"<1>"}', { status: 201 });
        }
      )
    );

    t = await startTunnus({
      schema: 'tunnus_mail_relay_it',
      env: {
        MAIL_PROVIDER: 'brevo',
        BREVO_API_KEY: 'brevo-key',
        MAIL_RELAY_TOKEN: 'relay-token-123',
        METRICS_BEARER_TOKEN: 'metrics-token-123',
      },
      transport: createBrevoTransport('brevo-key', 'Tunnus <no-reply@example.org>', fetchMock, {
        info() {},
        debug() {},
        warn: vi.fn(),
      }),
    });

    const payload = {
      from: 'app@example.org',
      to: ['keeper@example.org'],
      subject: '[App] Report (depleted): Pencils',
      text: 'Report (depleted): Pencils\nMain storage — Empty',
      templateId: 42,
      params: {
        title: 'Report (depleted): Pencils',
        body: 'Main storage — Empty',
        kind: 'depleted',
      },
    };

    const res = await fetch(`${t.issuer}/api/mail`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer relay-token-123',
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(brevoBodies).toEqual([
      {
        sender: { email: 'app@example.org' },
        to: [{ email: 'keeper@example.org' }],
        templateId: 42,
        params: payload.params,
      },
    ]);

    const { rows } = await t.pool.query(
      "SELECT action, details FROM audit_events WHERE action = 'mail_relay.sent'",
    );
    expect(rows).toEqual([
      {
        action: 'mail_relay.sent',
        details: { recipients: 1, templateId: 42 },
      },
    ]);

    const metricsRes = await fetch(`${t.issuer}/metrics`, {
      headers: { authorization: 'Bearer metrics-token-123' },
    });
    const metricsText = await metricsRes.text();
    expect(metricsText).toContain('tunnus_mail_relayed_total 1');
  });
});
