import { describe, expect, it } from 'vitest';
import { FAILED_ATTEMPTS_PER_HOUR, refusal } from '../src/codes.js';

const limits = { perEmailPerHour: 5, perIpPerHour: 20, mailPerDay: 10 };
const quiet = { by_email: 0, failed_by_email: 0, by_ip: 0, by_day: 0 };

describe('refusal', () => {
  it('allows a code when no counter is over its limit', () => {
    expect(refusal(quiet, { limits, ip: '1.2.3.4', purpose: 'signup' })).toBeNull();
  });

  it('refuses after the per-email limit', () => {
    expect(refusal({ ...quiet, by_email: 5 }, { limits, ip: null, purpose: 'login' })).toBe(
      'email',
    );
  });

  it('locks an address once its failed attempts reach the threshold', () => {
    const r = { ...quiet, failed_by_email: FAILED_ATTEMPTS_PER_HOUR };
    expect(refusal(r, { limits, ip: null, purpose: 'login' })).toBe('email');
    expect(
      refusal(
        { ...quiet, failed_by_email: FAILED_ATTEMPTS_PER_HOUR - 1 },
        { limits, ip: null, purpose: 'login' },
      ),
    ).toBeNull();
  });

  it('refuses per IP only when an IP is known', () => {
    const r = { ...quiet, by_ip: 20 };
    expect(refusal(r, { limits, ip: '1.2.3.4', purpose: 'login' })).toBe('ip');
    expect(refusal(r, { limits, ip: null, purpose: 'login' })).toBeNull();
  });

  it('stops sign-up codes at the daily cap', () => {
    expect(refusal({ ...quiet, by_day: 10 }, { limits, ip: null, purpose: 'signup' })).toBe(
      'daily',
    );
    expect(refusal({ ...quiet, by_day: 9 }, { limits, ip: null, purpose: 'signup' })).toBeNull();
  });

  it('lets login codes continue to 1.5 times the daily cap', () => {
    expect(refusal({ ...quiet, by_day: 10 }, { limits, ip: null, purpose: 'login' })).toBeNull();
    expect(refusal({ ...quiet, by_day: 14 }, { limits, ip: null, purpose: 'login' })).toBeNull();
    expect(refusal({ ...quiet, by_day: 15 }, { limits, ip: null, purpose: 'login' })).toBe('daily');
  });
});
