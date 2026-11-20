import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import { loadConfig, parseProcessors } from '../src/config.js';
import { t, LOCALES } from '../src/i18n.js';
import { createPrivacyRouter, privacyPage } from '../src/web/privacy.js';
import { emailPage } from '../src/web/pages.js';

const MINIMAL = {
  ISSUER: 'https://id.example.org',
  DATABASE_URL: 'postgres://localhost/tunnus',
  KEY_ENCRYPTION_SECRET: 'test-key-encryption-secret-0123456789',
  COOKIE_SECRETS: 'cookie-secret-0123',
  ALLOW_CONSOLE_MAIL: 'true',
  CONTROLLER_NAME: 'Example Organisation',
  CONTROLLER_CONTACT: 'privacy@example.org',
};

const PROCESSOR = { name: 'Mail provider', purpose: 'Sending sign-in codes', location: 'EU' };
const inline = (/** @type {unknown} */ value) => JSON.stringify(value);

describe('parseProcessors', () => {
  it('returns an empty list when neither variable is set', () => {
    expect(parseProcessors({}, () => '')).toEqual([]);
    expect(parseProcessors({ PROCESSORS: '  ', PROCESSORS_FILE: '' }, () => '')).toEqual([]);
  });

  it('parses the inline JSON list and trims values', () => {
    const env = {
      PROCESSORS: inline([{ name: ' Mail ', purpose: 'Codes', location: 'EU ' }]),
    };
    expect(parseProcessors(env, () => '')).toEqual([
      { name: 'Mail', purpose: 'Codes', location: 'EU' },
    ]);
  });

  it('reads PROCESSORS_FILE through the injected reader', () => {
    /** @type {string[]} */
    const reads = [];
    const readFile = (/** @type {string} */ path, /** @type {'utf8'} */ enc) => {
      reads.push(`${path}:${enc}`);
      return inline([PROCESSOR]);
    };
    expect(parseProcessors({ PROCESSORS_FILE: '/etc/tunnus/processors.json' }, readFile)).toEqual([
      PROCESSOR,
    ]);
    expect(reads).toEqual(['/etc/tunnus/processors.json:utf8']);
  });

  it('ignores an empty PROCESSORS_FILE when PROCESSORS is set', () => {
    const env = { PROCESSORS: inline([PROCESSOR]), PROCESSORS_FILE: '' };
    expect(
      parseProcessors(env, () => {
        throw new Error('must not read');
      }),
    ).toEqual([PROCESSOR]);
  });

  it('refuses both variables at once', () => {
    const env = { PROCESSORS: inline([PROCESSOR]), PROCESSORS_FILE: '/x.json' };
    expect(() => parseProcessors(env, () => inline([PROCESSOR]))).toThrow(
      'Set PROCESSORS or PROCESSORS_FILE, not both',
    );
  });

  it('names PROCESSORS when the inline value is not valid JSON', () => {
    expect(() => parseProcessors({ PROCESSORS: '[{' }, () => '')).toThrow(
      'PROCESSORS must be valid JSON',
    );
  });

  it('names PROCESSORS_FILE when the file is not valid JSON or cannot be read', () => {
    expect(() => parseProcessors({ PROCESSORS_FILE: '/x.json' }, () => 'nope')).toThrow(
      'PROCESSORS_FILE must be valid JSON',
    );
    expect(() =>
      parseProcessors({ PROCESSORS_FILE: '/missing.json' }, () => {
        throw new Error('ENOENT');
      }),
    ).toThrow('PROCESSORS_FILE could not be read');
  });

  it('requires a JSON array', () => {
    expect(() => parseProcessors({ PROCESSORS: inline({ name: 'x' }) }, () => '')).toThrow(
      'PROCESSORS must be a JSON array',
    );
  });

  it('requires non-empty string name, purpose and location on every item', () => {
    const bad = [
      null,
      'Mail',
      { name: 'Mail', purpose: 'Codes' },
      { name: 'Mail', purpose: 'Codes', location: '' },
      { name: 'Mail', purpose: 'Codes', location: 3 },
      { name: '  ', purpose: 'Codes', location: 'EU' },
    ];
    for (const item of bad) {
      expect(() => parseProcessors({ PROCESSORS: inline([PROCESSOR, item]) }, () => '')).toThrow(
        'PROCESSORS item 1 must have non-empty string name, purpose and location',
      );
    }
  });

  it('is applied by loadConfig through the injected reader', () => {
    const config = loadConfig(
      { ...MINIMAL, PROCESSORS_FILE: '/p.json' },
      { readFile: () => inline([PROCESSOR]) },
    );
    expect(config.privacy.processors).toEqual([PROCESSOR]);
  });

  it('makes loadConfig fail for a bad processor file, naming the variable', () => {
    expect(() =>
      loadConfig({ ...MINIMAL, PROCESSORS_FILE: '/p.json' }, { readFile: () => '{}' }),
    ).toThrow('PROCESSORS_FILE must be a JSON array');
  });
});

describe('privacy page rendering', () => {
  /**
   * @param {Record<string, string>} [extra]
   * @param {import('../src/i18n.js').Locale} [lang]
   */
  const render = (extra = {}, lang = 'en') => {
    const config = loadConfig({ ...MINIMAL, ...extra });
    return privacyPage({ config, locale: lang });
  };

  it('escapes configured text', () => {
    const html = render({
      CONTROLLER_NAME: '<script>alert(1)</script>',
      PROCESSORS: inline([{ name: '<b>x</b>', purpose: 'a & b', location: '"EU"' }]),
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&#60;script&#62;');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('a &#38; b');
  });

  it('omits the DPO section when no DPO contact is configured', () => {
    expect(render()).not.toContain(t('en', 'privacy_dpo'));
  });

  it('shows the DPO section when a DPO contact is configured', () => {
    const html = render({
      DPO_CONTACT: 'dpo@example.org',
      CONTROLLER_URL: 'https://www.riihimaenseurakunta.fi/info-ja-asiointi/tietosuoja',
    });
    expect(html).toContain(t('en', 'privacy_dpo'));
    expect(html).toContain('dpo@example.org');
    expect(html).toContain(
      '<a href="https://www.riihimaenseurakunta.fi/info-ja-asiointi/tietosuoja">https://www.riihimaenseurakunta.fi/info-ja-asiointi/tietosuoja</a>',
    );
  });

  it('renders retention numbers from the settings', () => {
    const html = render({
      INACTIVE_USER_DELETE_DAYS: '400',
      INACTIVE_USER_WARN_DAYS: '20',
      AUDIT_RETENTION_DAYS: '90',
      AUDIT_IP_RETENTION_DAYS: '10',
    });
    expect(html).toContain(t('en', 'privacy_inactive', { days: '400', warnDays: '20' }));
    expect(html).toContain(t('en', 'privacy_audit', { days: '90' }));
    expect(html).toContain(t('en', 'privacy_audit_ip', { days: '10' }));
    expect(html).toContain(t('en', 'privacy_admins'));
  });

  it('omits deletion text when inactive-user deletion is disabled', () => {
    const html = render({ INACTIVE_USER_DELETE_DAYS: '0' });
    expect(html).not.toContain(t('en', 'privacy_inactive', { days: '0', warnDays: '30' }));
    expect(html).not.toContain(t('en', 'privacy_admins'));
    expect(html).toContain(t('en', 'privacy_audit', { days: '365' }));
  });

  it('omits audit text when the audit retention tasks are disabled', () => {
    const html = render({ AUDIT_RETENTION_DAYS: '0', AUDIT_IP_RETENTION_DAYS: '0' });
    expect(html).not.toContain(t('en', 'privacy_audit', { days: '0' }));
    expect(html).not.toContain(t('en', 'privacy_audit_ip', { days: '0' }));
  });

  it('renders processors as a table, or says there are none', () => {
    const html = render({ PROCESSORS: inline([PROCESSOR]) });
    expect(html).toContain('<table>');
    expect(html).toContain('<td>Mail provider</td><td>Sending sign-in codes</td><td>EU</td>');
    expect(render({ PROCESSORS: '' })).toContain(t('en', 'privacy_processors_none'));
  });

  it('is available in all three locales', () => {
    for (const locale of LOCALES) {
      const html = render({}, locale);
      expect(html).toContain(`<html lang="${locale}">`);
      expect(html).toContain(t(locale, 'privacy_rights_body'));
    }
  });

  it('links the footer of every page to the notice, defaulting to <issuer>/privacy', () => {
    const config = loadConfig(MINIMAL);
    expect(emailPage({ config, locale: 'en' }, '/x')).toContain(
      'href="https://id.example.org/privacy"',
    );
    const custom = loadConfig({ ...MINIMAL, PRIVACY_NOTICE_URL: 'https://example.org/notice' });
    expect(emailPage({ config: custom, locale: 'fi' }, '/x')).toContain(
      'href="https://example.org/notice"',
    );
    expect(render()).toContain(t('en', 'footer_privacy'));
  });
});

describe('privacy translations', () => {
  const keys = [
    'mail_inactive_subject',
    'mail_inactive_body',
    'mail_privacy_link',
    'footer_privacy',
    'privacy_title',
    'privacy_controller',
    'privacy_dpo',
    'privacy_contact',
    'privacy_stored',
    'privacy_stored_body',
    'privacy_why',
    'privacy_why_body',
    'privacy_retention',
    'privacy_inactive',
    'privacy_admins',
    'privacy_audit',
    'privacy_audit_ip',
    'privacy_processors',
    'privacy_processors_none',
    'privacy_processor_name',
    'privacy_processor_purpose',
    'privacy_processor_location',
    'privacy_rights',
    'privacy_rights_body',
  ];

  it('has a translation in every locale, not the English fallback', () => {
    for (const key of keys) {
      for (const locale of /** @type {const} */ (['fi', 'sv'])) {
        expect(t(locale, key), `${locale}.${key}`).not.toBe(t('en', key));
      }
    }
  });

  it('fills the placeholders of the inactive-warning mail', () => {
    for (const locale of LOCALES) {
      const subject = t(locale, 'mail_inactive_subject', { brand: 'Tunnus' });
      const body = t(locale, 'mail_inactive_body', { brand: 'Tunnus', date: '2030-01-31' });
      expect(subject).toContain('Tunnus');
      expect(body).toContain('2030-01-31');
      expect(body).not.toMatch(/\{\w+\}/);
      expect(t(locale, 'mail_privacy_link', { url: 'https://id.example.org/privacy' })).toContain(
        'https://id.example.org/privacy',
      );
    }
  });
});

describe('privacy router', () => {
  /** @type {http.Server} */
  let server;
  /** @type {string} */
  let base;

  /** @param {Record<string, string>} extra */
  async function start(extra) {
    const config = loadConfig({ ...MINIMAL, ...extra });
    const app = express();
    app.use(createPrivacyRouter({ config }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
    base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  }

  afterAll(() => {
    server?.close();
  });

  beforeAll(async () => {
    await start({});
  });

  it('serves the notice as HTML, not cached', async () => {
    const res = await fetch(`${base}/privacy`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain(t('en', 'privacy_title'));
  });

  it('picks the locale from ?lang, then Accept-Language, then DEFAULT_LOCALE', async () => {
    const byQuery = await (await fetch(`${base}/privacy?lang=sv`)).text();
    expect(byQuery).toContain('<html lang="sv">');
    const byHeader = await (
      await fetch(`${base}/privacy`, { headers: { 'accept-language': 'fi' } })
    ).text();
    expect(byHeader).toContain('<html lang="fi">');
    const unknown = await (await fetch(`${base}/privacy?lang=de`)).text();
    expect(unknown).toContain('<html lang="en">');
  });

  it('redirects with 302 when PRIVACY_NOTICE_URL is set', async () => {
    await new Promise((r) => server.close(r));
    await start({ PRIVACY_NOTICE_URL: 'https://example.org/notice' });
    const res = await fetch(`${base}/privacy`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.org/notice');
  });
});
