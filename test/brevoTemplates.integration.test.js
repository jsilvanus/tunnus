import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrevoTransport } from '../src/mail.js';
import { browser, REDIRECT, signInThrough, startTunnus } from './helpers/harness.js';

/**
 * A fetch that answers with the given statuses in order (the last repeats) and records bodies.
 * @param {number[]} statuses
 */
function brevoFetch(statuses) {
  /** @type {any[]} */
  const bodies = [];
  let i = 0;
  const fn = async (/** @type {string} */ _url, /** @type {any} */ init) => {
    bodies.push(JSON.parse(init.body));
    return new Response('{}', { status: statuses[Math.min(i++, statuses.length - 1)] });
  };
  return { fetch: /** @type {typeof fetch} */ (/** @type {unknown} */ (fn)), bodies };
}

/** @type {Awaited<ReturnType<typeof startTunnus>> | undefined} */
let t;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('sign-in through a Brevo template', () => {
  it('sends the code by template and the sign-in completes', async () => {
    const brevo = brevoFetch([201]);
    t = await startTunnus({
      schema: 'tunnus_brevo_tpl_test',
      env: {
        MAIL_PROVIDER: 'brevo',
        BREVO_API_KEY: 'key',
        BREVO_TEMPLATE_SIGNIN_ID: '7',
      },
      transport: createBrevoTransport('key', 'Tunnus <no-reply@example.org>', brevo.fetch, {
        info() {},
        debug() {},
        warn: vi.fn(),
      }),
    });
    const b = browser();
    const { page } = await t.startAuth(b);
    const done = await signInThrough(
      t,
      b,
      /** @type {string} */ (t.interactionPath(page.body)),
      'tpl.user@example.org',
    );
    expect(done.finalUrl.startsWith(REDIRECT)).toBe(true);

    await vi.waitFor(() => expect(brevo.bodies.length).toBeGreaterThanOrEqual(1));
    const code = /** @type {any} */ (t.mails[0]).code;
    expect(brevo.bodies[0]).toMatchObject({ templateId: 7, params: { code } });
    expect(brevo.bodies[0]).not.toHaveProperty('textContent');
    expect(Object.keys(brevo.bodies[0].params).sort()).toEqual([
      'brand_name',
      'code',
      'controller_contact',
      'controller_name',
      'link',
      'locale',
      'privacy_url',
    ]);
  });

  it('still signs in when Brevo rejects the template (4xx), sending the code as text', async () => {
    const brevo = brevoFetch([400, 201]);
    t = await startTunnus({
      schema: 'tunnus_brevo_tpl_fallback_test',
      env: {
        MAIL_PROVIDER: 'brevo',
        BREVO_API_KEY: 'key',
        BREVO_TEMPLATE_SIGNIN_ID: '7',
      },
      transport: createBrevoTransport('key', 'Tunnus <no-reply@example.org>', brevo.fetch, {
        info() {},
        debug() {},
        warn: vi.fn(),
      }),
    });
    const b = browser();
    const { page } = await t.startAuth(b);
    const done = await signInThrough(
      t,
      b,
      /** @type {string} */ (t.interactionPath(page.body)),
      'fallback.user@example.org',
    );
    expect(done.finalUrl.startsWith(REDIRECT)).toBe(true);

    await vi.waitFor(() => expect(brevo.bodies.length).toBe(2));
    const code = /** @type {any} */ (t.mails[0]).code;
    expect(brevo.bodies[0]).toHaveProperty('templateId', 7);
    expect(brevo.bodies[1]).not.toHaveProperty('templateId');
    expect(brevo.bodies[1].textContent).toContain(code);
  });
});
