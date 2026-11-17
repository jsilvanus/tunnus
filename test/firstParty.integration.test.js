import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, REDIRECT, signInThrough, startTunnus } from './helpers/harness.js';

/** @type {Awaited<ReturnType<typeof startTunnus>>} */
let t;
beforeAll(async () => {
  t = await startTunnus({ schema: 'tunnus_first_party_test' });
});
afterAll(async () => {
  await t.close();
});

describe('first-party grants', () => {
  it('shows no consent page for a scope asked for after the first sign-in', async () => {
    const email = 'later.scope@example.org';
    const b = browser();
    const first = await t.startAuth(b, { scope: 'openid profile' });
    const done = await signInThrough(
      t,
      b,
      /** @type {string} */ (t.interactionPath(first.page.body)),
      email,
    );
    expect(done.finalUrl.startsWith(REDIRECT)).toBe(true);
    const firstTokens = await t.exchange(done.finalUrl, first.verifier, first.state);
    expect(/** @type {any} */ (firstTokens.claims()).email).toBeUndefined();

    // Same browser: the session asks to continue, then the extra scope must come back without consent.
    const second = await t.startAuth(b, { scope: 'openid email profile' });
    const cont = await b.post(`${t.origin}${t.interactionPath(second.page.body)}/continue`, {});
    expect(cont.body).not.toContain('Allow');
    expect(cont.finalUrl.startsWith(REDIRECT)).toBe(true);
    const tokens = await t.exchange(cont.finalUrl, second.verifier, second.state);
    expect(/** @type {any} */ (tokens.claims()).email).toBe(email);
  });
});
