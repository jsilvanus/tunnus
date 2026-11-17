import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, startTunnus } from './helpers/harness.js';

/** @type {Awaited<ReturnType<typeof startTunnus>>} */
let built;
/** @type {Awaited<ReturnType<typeof startTunnus>>} */
let hosted;

beforeAll(async () => {
  built = await startTunnus({
    schema: 'tunnus_privacy_it',
    env: { CONTROLLER_NAME: 'Example Organisation', CONTROLLER_CONTACT: 'privacy@example.org' },
  });
  hosted = await startTunnus({
    schema: 'tunnus_privacy_hosted_it',
    env: { PRIVACY_NOTICE_URL: 'https://notice.example.org/tunnus' },
  });
});
afterAll(async () => {
  await built.close();
  await hosted.close();
});

describe('GET <issuer>/privacy', () => {
  it('serves the notice as HTML with the controller and the retention settings', async () => {
    const res = await fetch(`${built.issuer}/privacy`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('Example Organisation');
    expect(body).toContain('privacy@example.org');
    expect(body).toContain('730');
  });

  it('follows ?lang= for the page language', async () => {
    const res = await fetch(`${built.issuer}/privacy?lang=fi`);
    expect(await res.text()).toContain('Tietosuojaseloste');
  });

  it('redirects with 302 to PRIVACY_NOTICE_URL when it is set', async () => {
    const res = await fetch(`${hosted.issuer}/privacy`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://notice.example.org/tunnus');
  });

  it('links the notice from the footer of the sign-in page', async () => {
    const { page } = await built.startAuth(browser());
    expect(page.body).toContain(`href="${built.issuer}/privacy"`);
  });
});
