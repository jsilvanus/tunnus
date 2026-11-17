#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * URL of the health endpoint on the loopback interface, under the issuer's path prefix.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function healthcheckUrl(env = process.env) {
  if (!env.ISSUER) throw new Error('ISSUER is required');
  const basePath = new URL(env.ISSUER).pathname.replace(/\/$/, '');
  const port = env.PORT ?? '3000';
  if (!/^\d+$/.test(port)) throw new Error('PORT must be a number');
  return `http://127.0.0.1:${port}${basePath}/health`;
}

/**
 * Exit 0 when the app answers 200 on its health endpoint, 1 otherwise.
 * @returns {Promise<number>}
 */
export async function runHealthcheck() {
  try {
    const res = await fetch(healthcheckUrl(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
    return res.status === 200 ? 0 : 1;
  } catch {
    return 1;
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  process.exitCode = await runHealthcheck();
}
