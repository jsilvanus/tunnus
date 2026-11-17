import { describe, expect, it } from 'vitest';
import { isValidEmail } from '../src/emailAddress.js';

describe('isValidEmail', () => {
  it.each(['anna@example.org', 'first.last+tag@sub.example.fi', 'a@b.co'])('accepts %s', (v) => {
    expect(isValidEmail(v)).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['no-at-sign.example.org', 'no @'],
    ['a@b@example.org', 'two @'],
    ['@example.org', 'empty local part'],
    ['anna@', 'empty domain'],
    ['anna@localhost', 'domain without a dot'],
    ['anna@example.', 'empty trailing label'],
    ['anna@.example.org', 'empty leading label'],
    ['anna@example..org', 'empty middle label'],
    ['anna @example.org', 'space in local part'],
    ['anna@exa mple.org', 'space in domain'],
    ['anna\t@example.org', 'tab'],
    ['a,b@example.org', 'comma in local part'],
    ['anna@example.org,evil@example.org', 'address list'],
    ['anna;x@example.org', 'semicolon'],
    ['<anna>@example.org', 'angle brackets'],
    ['anna@example.org>', 'angle bracket in domain'],
    ['"anna"@example.org', 'quotes'],
    ['(anna)@example.org', 'parentheses'],
    ['an\\na@example.org', 'backslash'],
  ])('rejects %j (%s)', (v) => {
    expect(isValidEmail(v)).toBe(false);
  });

  it('rejects an address longer than 254 characters', () => {
    const local = 'a'.repeat(64);
    const domain = `${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.example`;
    const address = `${local}@${domain}`;
    expect(address.length).toBe(255);
    expect(isValidEmail(address)).toBe(false);
    expect(isValidEmail(address.slice(0, 254))).toBe(true);
    expect(isValidEmail(`a@${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.fi`)).toBe(true);
  });

  it('rejects values that are not strings', () => {
    expect(isValidEmail(undefined)).toBe(false);
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(42)).toBe(false);
  });
});
