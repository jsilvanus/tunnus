import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildCodeMail, createBrevoTransport, parseFrom } from '../src/mail.js';

const config = loadConfig({
  ISSUER: 'https://id.example.org',
  DATABASE_URL: 'postgres://x',
  KEY_ENCRYPTION_SECRET: 's',
  COOKIE_SECRETS: 'c',
  CONTROLLER_NAME: 'Example Organisation',
  CONTROLLER_CONTACT: 'privacy@example.org',
});

describe('mail', () => {
  it('parses From headers', () => {
    expect(parseFrom('Tunnus <no-reply@example.org>')).toEqual({
      name: 'Tunnus',
      email: 'no-reply@example.org',
    });
    expect(parseFrom('no-reply@example.org')).toEqual({
      name: undefined,
      email: 'no-reply@example.org',
    });
  });

  it('builds a localised mail with the controller footer from config', () => {
    const fi = buildCodeMail(config, '123456', 'https://id.example.org/l', 'fi');
    expect(fi.subject).toBe('Kirjautumiskoodisi: 123456');
    expect(fi.text).toContain('https://id.example.org/l');
    expect(fi.text).toContain('Rekisterinpitäjä: Example Organisation (privacy@example.org)');
  });

  it('posts to the Brevo API', async () => {
    /** @type {any} */ let seen;
    const transport = createBrevoTransport('key', 'Tunnus <a@example.org>', async (url, init) => {
      seen = { url, init };
      return new Response('{}', { status: 201 });
    });
    await transport.send({ to: 'b@example.org', subject: 's', text: 't' });
    expect(seen.url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(seen.init.headers['api-key']).toBe('key');
    expect(JSON.parse(seen.init.body)).toMatchObject({
      sender: { email: 'a@example.org' },
      to: [{ email: 'b@example.org' }],
    });
  });
});
