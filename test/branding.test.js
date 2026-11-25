import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { getMimeType, findLocalLogoFile, findLocalFaviconFile } from '../src/branding.js';
import { loadConfig } from '../src/config.js';
import { layout } from '../src/web/pages.js';
import { buildCodeMail } from '../src/mail.js';
import { t, LOCALES } from '../src/i18n.js';

const MINIMAL = {
  ISSUER: 'https://id.example.org',
  DATABASE_URL: 'postgres://localhost/tunnus',
  KEY_ENCRYPTION_SECRET: 'test-key-encryption-secret-0123456789',
  COOKIE_SECRETS: 'cookie-secret-0123',
  ALLOW_CONSOLE_MAIL: 'true',
};

describe('branding helpers', () => {
  it('detects MIME types correctly', () => {
    expect(getMimeType('logo.png')).toBe('image/png');
    expect(getMimeType('logo.svg')).toBe('image/svg+xml');
    expect(getMimeType('image.jpg')).toBe('image/jpeg');
    expect(getMimeType('image.jpeg')).toBe('image/jpeg');
    expect(getMimeType('image.webp')).toBe('image/webp');
    expect(getMimeType('favicon.ico')).toBe('image/x-icon');
    expect(getMimeType('unknown.xyz')).toBe('application/octet-stream');
  });

  it('finds local logo file with customPath', () => {
    const io = { existsSync: (/** @type {string} */ p) => p === '/custom/logo.png' };
    expect(findLocalLogoFile('/custom/logo.png', io)).toBe('/custom/logo.png');
  });

  it('finds local logo file by candidate fallback', () => {
    const expected = path.resolve(process.cwd(), 'logo.png');
    const io = { existsSync: (/** @type {string} */ p) => p === expected };
    expect(findLocalLogoFile(undefined, io)).toBe(expected);
  });

  it('returns null when no logo file exists', () => {
    const io = { existsSync: () => false };
    expect(findLocalLogoFile(undefined, io)).toBeNull();
  });

  it('finds local favicon file', () => {
    const expected = path.resolve(process.cwd(), 'favicon.ico');
    const io = { existsSync: (/** @type {string} */ p) => p === expected };
    expect(findLocalFaviconFile(undefined, io)).toBe(expected);
  });
});

describe('branding configuration in loadConfig', () => {
  it('provides default branding values', () => {
    const config = loadConfig(MINIMAL, { existsSync: () => false });
    expect(config.brand.name).toBe('Tunnus');
    expect(config.brand.color).toBe('#1f4e79');
    expect(config.brand.copyright).toBe('');
    expect(config.brand.tagline).toBe('');
    expect(config.brand.termsUrl).toBe('');
    expect(config.brand.supportUrl).toBe('');
    expect(config.brand.faviconUrl).toBe('');
    expect(config.mailFrom).toBe('Tunnus <no-reply@localhost>');
  });

  it('reads custom brand name and updates default mailFrom', () => {
    const config = loadConfig(
      { ...MINIMAL, BRAND_NAME: 'CustomAuth' },
      { existsSync: () => false },
    );
    expect(config.brand.name).toBe('CustomAuth');
    expect(config.mailFrom).toBe('CustomAuth <no-reply@localhost>');
  });

  it('preserves explicit MAIL_FROM when BRAND_NAME is set', () => {
    const config = loadConfig(
      { ...MINIMAL, BRAND_NAME: 'CustomAuth', MAIL_FROM: 'Explicit <admin@example.org>' },
      { existsSync: () => false },
    );
    expect(config.brand.name).toBe('CustomAuth');
    expect(config.mailFrom).toBe('Explicit <admin@example.org>');
  });

  it('reads copyright, tagline, termsUrl, supportUrl and color overrides', () => {
    const config = loadConfig(
      {
        ...MINIMAL,
        BRAND_NAME: 'MyOrg',
        BRAND_COLOR: '#7e003e',
        BRAND_COPYRIGHT: '© 2026 MyOrg Inc',
        BRAND_TAGLINE: 'Secure Organization Sign-In',
        BRAND_TERMS_URL: 'https://example.org/terms',
        BRAND_SUPPORT_URL: 'https://example.org/support',
        BRAND_FAVICON_URL: 'https://example.org/favicon.ico',
      },
      { existsSync: () => false },
    );
    expect(config.brand.color).toBe('#7e003e');
    expect(config.brand.copyright).toBe('© 2026 MyOrg Inc');
    expect(config.brand.tagline).toBe('Secure Organization Sign-In');
    expect(config.brand.termsUrl).toBe('https://example.org/terms');
    expect(config.brand.supportUrl).toBe('https://example.org/support');
    expect(config.brand.faviconUrl).toBe('https://example.org/favicon.ico');
  });

  it('supports BRAND_COPYRIGHT_NOTICE as alias for BRAND_COPYRIGHT', () => {
    const config = loadConfig(
      { ...MINIMAL, BRAND_COPYRIGHT_NOTICE: '© 2026 Alias Corp' },
      { existsSync: () => false },
    );
    expect(config.brand.copyright).toBe('© 2026 Alias Corp');
  });

  it('auto-resolves local logo and favicon when URLs are not provided', () => {
    const svgLogo = path.resolve(process.cwd(), 'logo.svg');
    const icoFavicon = path.resolve(process.cwd(), 'favicon.ico');
    const io = {
      existsSync: (/** @type {string} */ p) => p === svgLogo || p === icoFavicon,
    };
    const config = loadConfig(MINIMAL, io);
    expect(config.brand.logoUrl).toBe('/logo.svg');
    expect(config.brand.faviconUrl).toBe('/favicon.ico');
  });

  it('auto-resolves logo with non-root issuer basePath', () => {
    const pngLogo = path.resolve(process.cwd(), 'logo.png');
    const io = { existsSync: (/** @type {string} */ p) => p === pngLogo };
    const config = loadConfig({ ...MINIMAL, ISSUER: 'https://id.example.org/identity' }, io);
    expect(config.brand.logoUrl).toBe('/identity/logo.png');
  });
});

describe('branded page rendering', () => {
  it('renders title, theme-color, alt text, tagline, copyright and extra footer links', () => {
    const config = loadConfig(
      {
        ...MINIMAL,
        BRAND_NAME: 'CustomBrand',
        BRAND_COLOR: '#123456',
        BRAND_LOGO_URL: 'https://example.org/logo.png',
        BRAND_TAGLINE: 'Sign in to access services',
        BRAND_COPYRIGHT: '© 2026 CustomBrand',
        BRAND_TERMS_URL: 'https://example.org/terms',
        BRAND_SUPPORT_URL: 'https://example.org/help',
      },
      { existsSync: () => false },
    );

    const html = layout({ config, locale: 'en' }, 'Sign In', '<p>Form</p>');
    expect(html).toContain('<title>Sign In · CustomBrand</title>');
    expect(html).toContain('<meta name="theme-color" content="#123456">');
    expect(html).toContain(
      '<img src="https://example.org/logo.png" alt="CustomBrand" height="56">',
    );
    expect(html).toContain('<p class="tagline">Sign in to access services</p>');
    expect(html).toContain('<p class="copyright">© 2026 CustomBrand</p>');
    expect(html).toContain('<a href="https://example.org/terms">Terms of service</a>');
    expect(html).toContain('<a href="https://example.org/help">Support</a>');
    expect(html).toContain('<a href="https://id.example.org/privacy">Privacy notice</a>');
  });

  it('renders localized terms and support links in fi and sv', () => {
    const config = loadConfig(
      {
        ...MINIMAL,
        BRAND_TERMS_URL: 'https://example.org/terms',
        BRAND_SUPPORT_URL: 'https://example.org/help',
      },
      { existsSync: () => false },
    );

    const htmlFi = layout({ config, locale: 'fi' }, 'Kirjaudu', '<p>Form</p>');
    expect(htmlFi).toContain('Käyttöehdot');
    expect(htmlFi).toContain('Tuki');

    const htmlSv = layout({ config, locale: 'sv' }, 'Logga in', '<p>Form</p>');
    expect(htmlSv).toContain('Användarvillkor');
    expect(htmlSv).toContain('Support');
  });
});

describe('branded email footer', () => {
  it('includes copyright notice in email text when configured', () => {
    const config = loadConfig(
      {
        ...MINIMAL,
        BRAND_COPYRIGHT: '© 2026 Riihimäen seurakunta',
        CONTROLLER_NAME: 'Riihimäen seurakunta',
      },
      { existsSync: () => false },
    );
    const mail = buildCodeMail(config, '123456', 'https://id.example.org/link', 'fi');
    expect(mail.text).toContain('© 2026 Riihimäen seurakunta');
    expect(mail.text).toContain('Rekisterinpitäjä: Riihimäen seurakunta');
  });
});

describe('branding translation keys', () => {
  it('has footer_terms and footer_support in all locales', () => {
    for (const locale of LOCALES) {
      expect(t(locale, 'footer_terms')).toBeTruthy();
      expect(t(locale, 'footer_support')).toBeTruthy();
    }
  });
});
