import { describe, it, expect, vi } from 'vitest';

vi.mock('node:crypto', async (importOriginal) => {
  /** @type {any} */
  const actual = await importOriginal();
  return { ...actual, scryptSync: vi.fn(actual.scryptSync) };
});

const crypto = await import('node:crypto');
const { decrypt, deriveSubkey, encrypt, decryptWithKey, encryptWithKey } =
  await import('../src/oidc/keys.js');

const SECRET = 'test-key-encryption-secret-0123456789';

describe('signing key encryption', () => {
  it('derives the scrypt key once per secret, not per call', () => {
    const secret = 'per-secret-cache-check-0123456789abcdef';
    vi.mocked(crypto.scryptSync).mockClear();
    const first = encrypt('{"d":"private"}', secret);
    const second = encrypt('{"d":"private"}', secret);
    expect(decrypt(first, secret)).toBe('{"d":"private"}');
    expect(decrypt(second, secret)).toBe('{"d":"private"}');
    expect(crypto.scryptSync).toHaveBeenCalledTimes(1);
  });

  it('does not decrypt with a different secret', () => {
    const data = encrypt('plain', SECRET);
    expect(() => decrypt(data, 'wrong-key-encryption-secret-0123456789')).toThrow();
  });
});

describe('email code subkeys (HKDF)', () => {
  it('is deterministic per secret and purpose', () => {
    expect(deriveSubkey(SECRET, 'email-code-hmac')).toEqual(
      deriveSubkey(SECRET, 'email-code-hmac'),
    );
    expect(deriveSubkey(SECRET, 'email-code-hmac')).toHaveLength(32);
  });

  it('gives a different key for each purpose and each secret', () => {
    const hmac = deriveSubkey(SECRET, 'email-code-hmac');
    expect(deriveSubkey(SECRET, 'email-code-encrypt').equals(hmac)).toBe(false);
    expect(
      deriveSubkey('other-key-encryption-secret-0123456789', 'email-code-hmac').equals(hmac),
    ).toBe(false);
  });

  it('round-trips with encryptWithKey and decryptWithKey', () => {
    const key = deriveSubkey(SECRET, 'email-code-encrypt');
    expect(decryptWithKey(encryptWithKey('123456', key), key)).toBe('123456');
    const wrong = deriveSubkey(SECRET, 'email-code-hmac');
    expect(() => decryptWithKey(encryptWithKey('123456', key), wrong)).toThrow();
  });
});
