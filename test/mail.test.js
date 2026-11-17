import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  buildCodeMail,
  buildInactiveWarningMail,
  createBrevoTransport,
  createMailer,
  MAIL_TIMEOUT_MS,
  parseFrom,
  smtpTransportOptions,
} from '../src/mail.js';

const config = loadConfig({
  ISSUER: 'https://id.example.org',
  DATABASE_URL: 'postgres://x',
  KEY_ENCRYPTION_SECRET: 'test-key-encryption-secret-0123456789',
  COOKIE_SECRETS: 'cookie-secret-0123',
  ALLOW_CONSOLE_MAIL: 'true',
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

  it('ends the sign-in mail with a link to the privacy notice', () => {
    const en = buildCodeMail(config, '123456', 'https://id.example.org/l', 'en');
    expect(
      en.text.endsWith(
        '\n\n-- \nData controller: Example Organisation (privacy@example.org)\nPrivacy notice: https://id.example.org/privacy',
      ),
    ).toBe(true);
  });

  it('links the privacy notice configured with PRIVACY_NOTICE_URL', () => {
    const hosted = loadConfig({
      ISSUER: 'https://id.example.org',
      DATABASE_URL: 'postgres://x',
      KEY_ENCRYPTION_SECRET: 'test-key-encryption-secret-0123456789',
      COOKIE_SECRETS: 'cookie-secret-0123',
      ALLOW_CONSOLE_MAIL: 'true',
      PRIVACY_NOTICE_URL: 'https://notice.example.org/tunnus',
    });
    const mail = buildCodeMail(hosted, '123456', 'https://id.example.org/l', 'sv');
    expect(mail.text).toContain('Integritetspolicy: https://notice.example.org/tunnus');
    expect(mail.text).not.toContain('Data controller');
    expect(mail.text).not.toContain('https://id.example.org/privacy');
  });

  it('builds the inactivity warning in three locales with the deletion date, footer and privacy link', () => {
    const deleteOn = new Date('2026-12-17T10:00:00Z');
    const fi = buildInactiveWarningMail(config, 'fi', deleteOn);
    expect(fi.subject).toBe('Tunnus-tilisi poistetaan');
    expect(fi.text).toContain('Tili poistetaan 2026-12-17, ellei');
    expect(fi.text).toContain('Rekisterinpitäjä: Example Organisation (privacy@example.org)');
    expect(fi.text).toContain('Tietosuojaseloste: https://id.example.org/privacy');

    const sv = buildInactiveWarningMail(config, 'sv', deleteOn);
    expect(sv.subject).toBe('Ditt Tunnus-konto raderas');
    expect(sv.text).toContain('Det raderas den 2026-12-17 om');

    const en = buildInactiveWarningMail(config, 'en', deleteOn);
    expect(en.subject).toBe('Your Tunnus account will be deleted');
    expect(en.text).toContain('It will be deleted on 2026-12-17 unless you sign in');
    expect(en.text).toContain('Privacy notice: https://id.example.org/privacy');
  });

  it('formats the deletion date in UTC, whatever the time of day', () => {
    const late = buildInactiveWarningMail(config, 'en', new Date('2026-01-31T23:59:59Z'));
    expect(late.text).toContain('deleted on 2026-01-31 unless');
  });

  it('sends the inactivity warning through the transport', async () => {
    /** @type {any[]} */ const sent = [];
    const mailer = createMailer(config, { send: async (m) => void sent.push(m) });
    await mailer.sendInactiveWarning('user@example.org', new Date('2026-12-17T00:00:00Z'), 'en');
    expect(sent).toEqual([
      {
        to: 'user@example.org',
        ...buildInactiveWarningMail(config, 'en', new Date('2026-12-17T00:00:00Z')),
      },
    ]);
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

  it('aborts a Brevo request after the mail timeout', async () => {
    /** @type {any} */ let signal;
    const transport = createBrevoTransport('key', 'a@example.org', async (_url, init) => {
      signal = init?.signal;
      return new Response('{}', { status: 201 });
    });
    await transport.send({ to: 'b@example.org', subject: 's', text: 't' });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(MAIL_TIMEOUT_MS).toBe(10_000);
  });

  it('sets connect, greeting and socket timeouts on SMTP', () => {
    expect(smtpTransportOptions('smtp://mail.example.org:587')).toEqual({
      url: 'smtp://mail.example.org:587',
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });
  });
});
