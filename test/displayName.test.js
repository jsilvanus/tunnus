import { describe, it, expect } from 'vitest';
import { displayNameFromEmail } from '../src/displayName.js';

describe('displayNameFromEmail', () => {
  it('capitalises dotted local parts', () => {
    expect(displayNameFromEmail('anna.virtanen@example.org')).toBe('Anna Virtanen');
    expect(displayNameFromEmail('ANNA_VIRTANEN@example.org')).toBe('Anna Virtanen');
  });
  it('keeps hyphenated names and drops tags and digits', () => {
    expect(displayNameFromEmail('anna-liisa.virtanen+x@example.org')).toBe('Anna-Liisa Virtanen');
    expect(displayNameFromEmail('anna.virtanen2@example.org')).toBe('Anna Virtanen');
  });
  it('falls back to the local part', () => {
    expect(displayNameFromEmail('1234@example.org')).toBe('1234');
  });
});
