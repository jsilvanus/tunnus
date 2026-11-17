import { describe, expect, it } from 'vitest';
import { LOCALES, t } from '../src/i18n.js';

const KEYS = [
  'error_title',
  'error_body',
  'logout_title',
  'logout_question',
  'logout_yes',
  'logout_no',
  'logout_done_title',
  'logout_done_body',
];

describe('translations', () => {
  it.each(LOCALES)('has the browser and error pages in %s', (locale) => {
    for (const key of KEYS) {
      const text = t(locale, key);
      expect(text, `${locale}.${key}`).not.toBe(key);
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('translates the logout page into Finnish and Swedish, not English', () => {
    expect(t('fi', 'logout_yes')).not.toBe(t('en', 'logout_yes'));
    expect(t('sv', 'logout_yes')).not.toBe(t('en', 'logout_yes'));
  });
});
