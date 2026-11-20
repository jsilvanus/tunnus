import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  buildCodeMail,
  buildCodeTemplateParams,
  buildInactiveTemplateParams,
  buildInactiveWarningMail,
  createBrevoTransport,
  createConsoleTransport,
  createMailer,
  MAIL_TIMEOUT_MS,
  parseFrom,
  smtpTransportOptions,
  templateIdFor,
} from '../src/mail.js';

/**
 * A fetch that answers each call with the next status (the last one repeats) and records bodies.
 * @param {(number | Error)[]} statuses
 */
function fakeFetch(statuses) {
  /** @type {any[]} */
  const bodies = [];
  let i = 0;
  const fn = async (/** @type {string} */ _url, /** @type {any} */ init) => {
    bodies.push(JSON.parse(init.body));
    const next = statuses[Math.min(i++, statuses.length - 1)];
    if (next instanceof Error) throw next;
    return new Response('{}', { status: next });
  };
  return { fn: /** @type {typeof fetch} */ (/** @type {unknown} */ (fn)), bodies };
}

/** @returns {{ info: any, debug: any, warn: any }} */
const fakeLog = () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn() });

const BASE_ENV = {
  ISSUER: 'https://id.example.org',
  DATABASE_URL: 'postgres://x',
  KEY_ENCRYPTION_SECRET: 'test-key-encryption-secret-0123456789',
  COOKIE_SECRETS: 'cookie-secret-0123',
  CONTROLLER_NAME: 'Example Organisation',
  CONTROLLER_CONTACT: 'privacy@example.org',
};

/** @param {Record<string, string>} [extra] */
const brevoConfig = (extra = {}) =>
  loadConfig({ ...BASE_ENV, MAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'key', ...extra });

const SIGNIN_PARAM_KEYS = [
  'brand_name',
  'code',
  'controller_contact',
  'controller_name',
  'link',
  'locale',
  'privacy_url',
];
const INACTIVE_PARAM_KEYS = [
  'brand_name',
  'controller_contact',
  'controller_name',
  'date',
  'locale',
  'privacy_url',
];

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

describe('Brevo templates', () => {
  it('sends subject and textContent when there is no template, as before', async () => {
    const { fn, bodies } = fakeFetch([201]);
    const transport = createBrevoTransport('key', 'Tunnus <a@example.org>', fn, fakeLog());
    await transport.send({ to: 'b@example.org', subject: 'Subj', text: 'Body' });
    expect(bodies).toEqual([
      {
        sender: { name: 'Tunnus', email: 'a@example.org' },
        to: [{ email: 'b@example.org' }],
        subject: 'Subj',
        textContent: 'Body',
      },
    ]);
  });

  it('sends templateId and params, and no subject or textContent, when a template is set', async () => {
    const { fn, bodies } = fakeFetch([201]);
    const transport = createBrevoTransport('key', 'a@example.org', fn, fakeLog());
    await transport.send({
      to: 'b@example.org',
      subject: 'Subj',
      text: 'Body',
      template: { id: 7, params: { code: '123456', link: 'https://id.example.org/l' } },
    });
    expect(bodies).toEqual([
      {
        sender: { email: 'a@example.org' },
        to: [{ email: 'b@example.org' }],
        templateId: 7,
        params: { code: '123456', link: 'https://id.example.org/l' },
      },
    ]);
    expect(bodies[0]).not.toHaveProperty('subject');
    expect(bodies[0]).not.toHaveProperty('textContent');
  });

  it('uses the locale override over the default id, and the default otherwise', async () => {
    const cfg = brevoConfig({
      BREVO_TEMPLATE_SIGNIN_ID: '10',
      BREVO_TEMPLATE_SIGNIN_ID_SV: '20',
    });
    /** @type {{ to: string | string[], template?: any }[]} */
    const sent = [];
    const mailer = createMailer(cfg, { send: async (m) => void sent.push(m) });
    await mailer.sendCode('b@example.org', '123456', 'https://id.example.org/l', 'sv');
    await mailer.sendCode('b@example.org', '123456', 'https://id.example.org/l', 'fi');
    expect(sent.map((m) => m.template.id)).toEqual([20, 10]);
    expect(templateIdFor({ default: 10, sv: 20 }, 'en')).toBe(10);
    expect(templateIdFor({ en: 5 }, 'en')).toBe(5);
    expect(templateIdFor({}, 'en')).toBeUndefined();
  });

  it('sends plain text with no template when no id is configured for the kind and locale', async () => {
    const cfg = brevoConfig({ BREVO_TEMPLATE_INACTIVE_ID: '30' });
    /** @type {any[]} */
    const sent = [];
    const mailer = createMailer(cfg, { send: async (m) => void sent.push(m) });
    await mailer.sendCode('b@example.org', '123456', 'https://id.example.org/l', 'en');
    expect(sent[0]).not.toHaveProperty('template');
    await mailer.sendInactiveWarning('b@example.org', new Date('2026-12-17T00:00:00Z'), 'en');
    expect(sent[1].template).toEqual({
      id: 30,
      params: buildInactiveTemplateParams(cfg, 'en', new Date('2026-12-17T00:00:00Z')),
    });
  });

  it('retries once as plain text after a 4xx, logging only the error name and status', async () => {
    const { fn, bodies } = fakeFetch([400, 201]);
    const log = fakeLog();
    const transport = createBrevoTransport('key', 'a@example.org', fn, log);
    await transport.send({
      to: 'secret.person@example.org',
      subject: 'Your code: 654321',
      text: 'Code 654321',
      template: { id: 7, params: { code: '654321' } },
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toHaveProperty('templateId', 7);
    expect(bodies[1]).not.toHaveProperty('templateId');
    expect(bodies[1]).toMatchObject({ subject: 'Your code: 654321', textContent: 'Code 654321' });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toEqual({ error: 'Error', status: 400 });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret.person');
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('654321');
  });

  it('tries locale template first, then fallback default template, then plain text on 4xx', async () => {
    const cfg = brevoConfig({
      BREVO_TEMPLATE_SIGNIN_ID: '10',
      BREVO_TEMPLATE_SIGNIN_ID_FI: '21',
    });
    const { fn, bodies } = fakeFetch([404, 404, 201]);
    const log = fakeLog();
    const transport = createBrevoTransport('key', 'a@example.org', fn, log);
    const mailer = createMailer(cfg, transport);
    await mailer.sendCode('b@example.org', '123456', 'https://id.example.org/l', 'fi');
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toMatchObject({ templateId: 21, params: { locale: 'fi', code: '123456' } });
    expect(bodies[1]).toMatchObject({ templateId: 10, params: { locale: 'fi', code: '123456' } });
    expect(bodies[2]).not.toHaveProperty('templateId');
    expect(bodies[2]).toHaveProperty('textContent');
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 5xx as plain text', async () => {
    const { fn, bodies } = fakeFetch([503, 201]);
    const transport = createBrevoTransport('key', 'a@example.org', fn, fakeLog());
    await expect(
      transport.send({
        to: 'b@example.org',
        subject: 's',
        text: 't',
        template: { id: 7, params: {} },
      }),
    ).rejects.toThrow('Brevo responded 503');
    expect(bodies).toHaveLength(1);
  });

  it('does not retry a network error or timeout as plain text', async () => {
    const { fn, bodies } = fakeFetch([new TypeError('fetch failed'), 201]);
    const transport = createBrevoTransport('key', 'a@example.org', fn, fakeLog());
    await expect(
      transport.send({
        to: 'b@example.org',
        subject: 's',
        text: 't',
        template: { id: 7, params: {} },
      }),
    ).rejects.toThrow('fetch failed');
    expect(bodies).toHaveLength(1);
  });

  it('does not retry when the text send itself fails with a 4xx', async () => {
    const { fn, bodies } = fakeFetch([400, 401]);
    const transport = createBrevoTransport('key', 'a@example.org', fn, fakeLog());
    await expect(
      transport.send({
        to: 'b@example.org',
        subject: 's',
        text: 't',
        template: { id: 7, params: {} },
      }),
    ).rejects.toThrow('Brevo responded 401');
    expect(bodies).toHaveLength(2);
  });

  it('keeps the SMTP and console transports on text, and logs only the template id to the console', () => {
    const log = fakeLog();
    const transport = createConsoleTransport(log);
    return transport
      .send({
        to: 'b@example.org',
        subject: 's',
        text: 'Code 123456',
        template: { id: 9, params: { code: '123456' } },
      })
      .then(() => {
        expect(log.info.mock.calls[0][0]).toEqual({
          to: 'b@example.org',
          subject: 's',
          text: 'Code 123456',
        });
        expect(log.debug).toHaveBeenCalledWith(
          { templateId: 9 },
          'mail template (console provider, unused)',
        );
        expect(JSON.stringify(log.debug.mock.calls)).not.toContain('123456');
      });
  });

  it('passes exactly the documented params for the sign-in mail', () => {
    const cfg = brevoConfig();
    const params = buildCodeTemplateParams(cfg, '123456', 'https://id.example.org/l', 'fi');
    expect(Object.keys(params).sort()).toEqual(SIGNIN_PARAM_KEYS);
    for (const v of Object.values(params)) expect(typeof v).toBe('string');
    expect(params).toEqual({
      code: '123456',
      link: 'https://id.example.org/l',
      brand_name: 'Tunnus',
      privacy_url: 'https://id.example.org/privacy',
      controller_name: 'Example Organisation',
      controller_contact: 'privacy@example.org',
      locale: 'fi',
    });
  });

  it('passes exactly the documented params for the inactivity warning, date in UTC', () => {
    const cfg = brevoConfig({ PRIVACY_NOTICE_URL: 'https://notice.example.org/tunnus' });
    const params = buildInactiveTemplateParams(cfg, 'sv', new Date('2026-12-17T23:59:59Z'));
    expect(Object.keys(params).sort()).toEqual(INACTIVE_PARAM_KEYS);
    for (const v of Object.values(params)) expect(typeof v).toBe('string');
    expect(params.date).toBe('2026-12-17');
    expect(params.privacy_url).toBe('https://notice.example.org/tunnus');
    expect(params.locale).toBe('sv');
  });

  it('gives empty strings for an unset controller, never undefined', () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      CONTROLLER_NAME: '',
      CONTROLLER_CONTACT: '',
      ALLOW_CONSOLE_MAIL: 'true',
    });
    const params = buildCodeTemplateParams(cfg, '1', 'l', 'en');
    expect(params.controller_name).toBe('');
    expect(params.controller_contact).toBe('');
  });

  it('reads template ids from the environment only for MAIL_PROVIDER=brevo', () => {
    const cfg = brevoConfig({
      BREVO_TEMPLATE_SIGNIN_ID: '12',
      BREVO_TEMPLATE_SIGNIN_ID_EN: '13',
      BREVO_TEMPLATE_INACTIVE_ID: '14',
    });
    expect(cfg.brevoTemplates).toEqual({
      signin: { default: 12, fi: undefined, sv: undefined, en: 13 },
      inactive: { default: 14, fi: undefined, sv: undefined, en: undefined },
    });
    const smtp = loadConfig({
      ...BASE_ENV,
      MAIL_PROVIDER: 'smtp',
      SMTP_URL: 'smtp://mail.example.org:587',
      BREVO_TEMPLATE_SIGNIN_ID: 'not-a-number',
    });
    expect(smtp.brevoTemplates.signin.default).toBeUndefined();
  });

  it('treats an empty template variable as unset', () => {
    const cfg = brevoConfig({ BREVO_TEMPLATE_SIGNIN_ID: '' });
    expect(cfg.brevoTemplates.signin.default).toBeUndefined();
  });

  it.each(['0', '-3', '1.5', 'abc', '12abc', ' 12', '1e3'])(
    'rejects the template id %j at start-up',
    (value) => {
      expect(() => brevoConfig({ BREVO_TEMPLATE_SIGNIN_ID: value })).toThrow(
        'BREVO_TEMPLATE_SIGNIN_ID must be a positive integer',
      );
    },
  );

  it('names the variable when a locale override is invalid', () => {
    expect(() => brevoConfig({ BREVO_TEMPLATE_INACTIVE_ID_SV: '0' })).toThrow(
      'BREVO_TEMPLATE_INACTIVE_ID_SV must be a positive integer',
    );
  });
});
