import { describe, expect, it } from 'vitest';
import { BootstrapInputError, validateBootstrapInput } from '../src/bootstrap.js';

describe('validateBootstrapInput', () => {
  it('accepts a plain address', () => {
    expect(validateBootstrapInput({ email: 'Admin@Example.org' }).email).toBe('admin@example.org');
  });

  it.each(['admin@example.org,other@example.org', 'admin@example', 'admin example@x.org'])(
    'rejects %j as an address',
    (email) => {
      expect(() => validateBootstrapInput({ email })).toThrow(BootstrapInputError);
    },
  );
});
