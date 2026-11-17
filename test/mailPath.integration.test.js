import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { browser, startTunnus } from './helpers/harness.js';

describe('sign-in mail is sent in the background', () => {
  it('answers the request before the provider has finished', async () => {
    /** @type {(value?: unknown) => void} */
    let finish = () => {};
    const gate = new Promise((resolve) => (finish = resolve));
    let providerDone = false;
    const slow = await startTunnus({
      schema: 'tunnus_mail_slow_test',
      transport: {
        async send() {
          await gate;
          providerDone = true;
        },
      },
    });
    try {
      const b = browser();
      const { page } = await slow.startAuth(b);
      const path = slow.interactionPath(page.body);
      const sent = await b.post(`${slow.origin}${path}/email`, { email: 'slow@example.org' });
      expect(sent.res.status).toBe(200);
      expect(providerDone).toBe(false);
      await vi.waitFor(() => expect(slow.mails.length).toBe(1));
    } finally {
      finish(undefined);
      await slow.close();
    }
  });

  it('audits a failed send with the error name only, never the address or message', async () => {
    const failing = await startTunnus({
      schema: 'tunnus_mail_fail_test',
      transport: {
        async send(message) {
          throw new TypeError(`provider refused ${message.to}`);
        },
      },
    });
    try {
      const b = browser();
      const { page } = await failing.startAuth(b);
      const path = failing.interactionPath(page.body);
      const sent = await b.post(`${failing.origin}${path}/email`, {
        email: 'refused.user@example.org',
      });
      expect(sent.res.status).toBe(200);
      await vi.waitFor(async () => {
        const { rows } = await failing.pool.query(
          "SELECT details FROM audit_events WHERE action = 'mail_error'",
        );
        expect(rows.length).toBe(1);
        expect(rows[0].details).toEqual({ kind: 'sign_in_code', error: 'TypeError' });
      });
      const { rows } = await failing.pool.query(
        "SELECT details FROM audit_events WHERE action = 'mail_error'",
      );
      expect(JSON.stringify(rows)).not.toContain('refused.user');
      expect(JSON.stringify(rows)).not.toContain('provider refused');
    } finally {
      await failing.close();
    }
  });
});

describe('sign-in mail response does not depend on sending', () => {
  /** @type {Awaited<ReturnType<typeof startTunnus>>} */
  let t;
  beforeAll(async () => {
    t = await startTunnus({ schema: 'tunnus_mail_timing_test' });
  });
  afterAll(async () => {
    await t.close();
  });

  it('gives the same page for an allowed and a denied address', async () => {
    const b = browser();
    const { page } = await t.startAuth(b);
    const path = t.interactionPath(page.body);
    const allowed = await b.post(`${t.origin}${path}/email`, { email: 'timed@example.org' });
    const denied = await b.post(`${t.origin}${path}/email`, { email: 'ext-timed@example.org' });
    expect(allowed.body).toBe(denied.body);
    await vi.waitFor(() => expect(t.mails.length).toBe(1));
  });
});
