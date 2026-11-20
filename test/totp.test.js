import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  buildOtpAuthUri,
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  isTotpEligible,
  totpCode,
  verifyTotpToken,
} from '../src/totp.js';

// RFC 6238 Appendix B SHA-1 test secret ("12345678901234567890")
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const KEY_SECRET = '0123456789abcdef0123456789abcdef';

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    const raw = Buffer.from('hello-tunnus-totp');
    const encoded = base32Encode(raw);
    expect(encoded).toMatch(/^[A-Z2-7]+$/);
    expect(base32Decode(encoded)).toEqual(raw);
  });

  it('rejects invalid characters', () => {
    expect(() => base32Decode('INVALID!01')).toThrow();
  });
});

describe('totp generation and verification', () => {
  it('matches RFC 6238 SHA-1 test vectors (6 digits)', () => {
    // At t = 59s, RFC 6238 8-digit SHA-1 value is 94287082 -> 6-digit is 287082
    expect(totpCode(RFC_SECRET, 59 * 1000)).toBe('287082');
    // At t = 1111111109s, RFC 6238 8-digit SHA-1 value is 07081804 -> 6-digit is 081804
    expect(totpCode(RFC_SECRET, 1111111109 * 1000)).toBe('081804');
  });

  it('accepts current step and +/-1 step clock skew, rejects +/-2 steps', () => {
    const nowMs = 1_700_000_010_000;
    const prevCode = totpCode(RFC_SECRET, nowMs - 30_000);
    const currCode = totpCode(RFC_SECRET, nowMs);
    const nextCode = totpCode(RFC_SECRET, nowMs + 30_000);
    const oldCode = totpCode(RFC_SECRET, nowMs - 60_000);

    expect(verifyTotpToken(RFC_SECRET, prevCode, { nowMs }).ok).toBe(true);
    expect(verifyTotpToken(RFC_SECRET, currCode, { nowMs }).ok).toBe(true);
    expect(verifyTotpToken(RFC_SECRET, nextCode, { nowMs }).ok).toBe(true);
    expect(verifyTotpToken(RFC_SECRET, oldCode, { nowMs })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('rejects replayed codes for the same or earlier step', () => {
    const nowMs = 1_700_000_010_000;
    const code = totpCode(RFC_SECRET, nowMs);
    const first = verifyTotpToken(RFC_SECRET, code, { nowMs });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(verifyTotpToken(RFC_SECRET, code, { nowMs, lastStep: first.step })).toEqual({
      ok: false,
      reason: 'replayed',
    });
    expect(verifyTotpToken(RFC_SECRET, code, { nowMs, lastStep: first.step + 1 })).toEqual({
      ok: false,
      reason: 'replayed',
    });
  });

  it('rejects malformed tokens', () => {
    expect(verifyTotpToken(RFC_SECRET, '12345')).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyTotpToken(RFC_SECRET, 'abcdef')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('secret encryption and otpauth URI', () => {
  it('encrypts and decrypts a generated secret', () => {
    const { base32 } = generateTotpSecret();
    const enc = encryptTotpSecret(base32, KEY_SECRET);
    expect(enc).not.toContain(base32);
    expect(decryptTotpSecret(enc, KEY_SECRET)).toBe(base32);
  });

  it('builds a valid otpauth URI', () => {
    const uri = buildOtpAuthUri({
      secretBase32: 'JBSWY3DPEHPK3PXP',
      email: 'ada@example.org',
      issuer: 'Example',
    });
    expect(uri).toMatch(/^otpauth:\/\/totp\/Example:ada%40example\.org\?/);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=Example');
  });
});

describe('isTotpEligible', () => {
  const nowMs = Date.UTC(2026, 10, 20, 12, 0, 0);
  const baseUser = {
    status: 'active',
    totp_secret_enc: 'enc',
    totp_enabled_at: new Date(nowMs - 86_400_000),
    totp_locked_until: null,
    last_email_verified_at: new Date(nowMs - 2 * 86_400_000),
  };

  it('allows active user with recent email verification', () => {
    expect(isTotpEligible(baseUser, { reverifyDays: 7, nowMs })).toBe(true);
  });

  it('requires email re-verification once reverifyDays has elapsed', () => {
    const stale = {
      ...baseUser,
      last_email_verified_at: new Date(nowMs - 7 * 86_400_000),
    };
    expect(isTotpEligible(stale, { reverifyDays: 7, nowMs })).toBe(false);
    expect(isTotpEligible(stale, { reverifyDays: 0, nowMs })).toBe(true);
  });

  it('rejects locked, disabled, or unverified users', () => {
    expect(
      isTotpEligible(
        { ...baseUser, totp_locked_until: new Date(nowMs + 60_000) },
        { reverifyDays: 7, nowMs },
      ),
    ).toBe(false);
    expect(isTotpEligible({ ...baseUser, status: 'disabled' }, { reverifyDays: 7, nowMs })).toBe(
      false,
    );
    expect(
      isTotpEligible({ ...baseUser, last_email_verified_at: null }, { reverifyDays: 7, nowMs }),
    ).toBe(false);
  });
});
