import { describe, it, expect } from 'vitest';
import { createSignupRule } from '../src/emailRules.js';

describe('createSignupRule', () => {
  const rule = createSignupRule({ allow: '*@example.org', deny: 'ext-*@example.org' });

  it('allows matching addresses, case-insensitively', () => {
    expect(rule('anna.virtanen@example.org')).toBe(true);
    expect(rule('Anna@EXAMPLE.ORG')).toBe(true);
  });
  it('lets deny win over allow', () => {
    expect(rule('ext-guest@example.org')).toBe(false);
  });
  it('refuses other domains and lookalikes', () => {
    expect(rule('a@other.org')).toBe(false);
    expect(rule('a@example.org.evil.com')).toBe(false);
    expect(rule('a@sub.example.org')).toBe(false);
  });
  it('closes sign-up with an empty allow list', () => {
    expect(createSignupRule({})('a@example.org')).toBe(false);
  });
  it('treats regex characters literally', () => {
    expect(createSignupRule({ allow: 'a.b@example.org' })('axb@example.org')).toBe(false);
  });
});
