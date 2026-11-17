import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, signInThrough, startTunnus } from './helpers/harness.js';

/** @type {Awaited<ReturnType<typeof startTunnus>>} */
let t;
beforeAll(async () => {
  t = await startTunnus({ schema: 'tunnus_always_groups_test' });
});
afterAll(async () => {
  await t.close();
});

describe('always_include_groups', () => {
  it('gives the groups claim on GET /auth without the groups scope', async () => {
    const b = browser();
    const { page, verifier, state } = await t.startAuth(b, { scope: 'openid email profile' });
    const done = await signInThrough(
      t,
      b,
      /** @type {string} */ (t.interactionPath(page.body)),
      'groups.get@example.org',
    );
    const tokens = await t.exchange(done.finalUrl, verifier, state);
    expect(/** @type {any} */ (tokens.claims()).groups).toEqual(['all']);
  });

  it('does not serve POST /auth, so the form path cannot skip the groups rewrite', async () => {
    const res = await fetch(`${t.issuer}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: 'rp', scope: 'openid' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(404);
  });

  it('gives the groups claim on a request that carries no request_uri', async () => {
    const b = browser();
    const { page, verifier, state } = await t.startAuth(b, { scope: 'openid' });
    const done = await signInThrough(
      t,
      b,
      /** @type {string} */ (t.interactionPath(page.body)),
      'groups.plain@example.org',
    );
    const tokens = await t.exchange(done.finalUrl, verifier, state);
    expect(/** @type {any} */ (tokens.claims()).groups).toEqual(['all']);
  });
});
