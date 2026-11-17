import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTunnus } from './helpers/harness.js';

/** @type {Awaited<ReturnType<typeof startTunnus>>} */
let t;
beforeAll(async () => {
  t = await startTunnus({ schema: 'tunnus_requestid_test' });
});
afterAll(async () => {
  await t.close();
});

describe('request ids on the real app', () => {
  it('sets X-Request-Id on every response, including the health check', async () => {
    const res = await fetch(`${t.issuer}/health`);
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('passes a client request id through', async () => {
    const res = await fetch(`${t.issuer}/health`, { headers: { 'X-Request-Id': 'client-7' } });
    expect(res.headers.get('x-request-id')).toBe('client-7');
  });
});
