import { describe, it, expect } from 'vitest';
import express from 'express';
import { loadConfig, loadRetentionConfig } from '../src/config.js';

const KEY = 'test-key-encryption-secret-0123456789';

const COOKIE = 'cookie-secret-0123';

const MINIMAL = {
  ISSUER: 'https://id.example.org',
  DATABASE_URL: 'postgres://localhost/tunnus',
  KEY_ENCRYPTION_SECRET: KEY,
  COOKIE_SECRETS: COOKIE,
  ALLOW_CONSOLE_MAIL: 'true',
};

describe('loadRetentionConfig', () => {
  it('uses documented defaults', () => {
    expect(loadRetentionConfig({})).toEqual({
      inactiveUserDeleteDays: 730,
      inactiveUserWarnDays: 30,
      auditRetentionDays: 365,
      auditIpRetentionDays: 30,
    });
  });
  it('reads overrides and rejects bad values', () => {
    expect(loadRetentionConfig({ AUDIT_IP_RETENTION_DAYS: '7' }).auditIpRetentionDays).toBe(7);
    expect(() => loadRetentionConfig({ AUDIT_RETENTION_DAYS: 'x' })).toThrow();
  });
});

describe('loadConfig admin and key settings', () => {
  it('uses documented defaults', () => {
    const config = loadConfig(MINIMAL);
    expect(config.keyRetiredGraceDays).toBe(7);
    expect(config.keyReloadIntervalSeconds).toBe(60);
    expect(config.adminValidateResponses).toBe(false);
  });
  it('reads overrides, and accepts 0 for the reload interval', () => {
    const config = loadConfig({
      ...MINIMAL,
      KEY_RETIRED_GRACE_DAYS: '30',
      KEY_RELOAD_INTERVAL_SECONDS: '0',
      ADMIN_VALIDATE_RESPONSES: 'true',
    });
    expect(config.keyRetiredGraceDays).toBe(30);
    expect(config.keyReloadIntervalSeconds).toBe(0);
    expect(config.adminValidateResponses).toBe(true);
  });
  it('rejects negative values', () => {
    expect(() => loadConfig({ ...MINIMAL, KEY_RETIRED_GRACE_DAYS: '-1' })).toThrow();
  });
});

describe('loadConfig metrics, cleanup and privacy settings', () => {
  it('uses documented defaults', () => {
    const config = loadConfig(MINIMAL);
    expect(config.metricsBearerToken).toBe('');
    expect(config.cleanup).toEqual({ disabled: false, startDelaySeconds: 60, intervalHours: 24 });
    expect(config.privacy).toEqual({ dpoContact: '', processors: [] });
  });
  it('reads metrics token and cleanup overrides', () => {
    const config = loadConfig({
      ...MINIMAL,
      METRICS_BEARER_TOKEN: 'metrics-token',
      CLEANUP_DISABLED: 'true',
      CLEANUP_START_DELAY_SECONDS: '0',
      CLEANUP_INTERVAL_HOURS: '6',
    });
    expect(config.metricsBearerToken).toBe('metrics-token');
    expect(config.cleanup).toEqual({ disabled: true, startDelaySeconds: 0, intervalHours: 6 });
  });
  it('only treats the exact string true as disabling cleanup', () => {
    expect(loadConfig({ ...MINIMAL, CLEANUP_DISABLED: '1' }).cleanup.disabled).toBe(false);
  });
  it('rejects an interval below one hour and non-integers', () => {
    expect(() => loadConfig({ ...MINIMAL, CLEANUP_INTERVAL_HOURS: '0' })).toThrow(
      'CLEANUP_INTERVAL_HOURS must be at least 1',
    );
    expect(() => loadConfig({ ...MINIMAL, CLEANUP_INTERVAL_HOURS: '1.5' })).toThrow();
    expect(() => loadConfig({ ...MINIMAL, CLEANUP_START_DELAY_SECONDS: '-5' })).toThrow();
  });
});

describe('loadConfig TRUST_PROXY', () => {
  it('turns an all-digit value into a hop count', () => {
    expect(loadConfig({ ...MINIMAL, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadConfig({ ...MINIMAL, TRUST_PROXY: '2' }).trustProxy).toBe(2);
    expect(loadConfig({ ...MINIMAL, TRUST_PROXY: '0' }).trustProxy).toBe(0);
  });
  it('keeps true, false and address lists as they were', () => {
    expect(loadConfig({ ...MINIMAL, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig(MINIMAL).trustProxy).toBe(false);
    expect(loadConfig({ ...MINIMAL, TRUST_PROXY: '10.0.0.0/8' }).trustProxy).toBe('10.0.0.0/8');
  });
  it('makes Express trust exactly one hop for "1"', () => {
    const app = express();
    app.set('trust proxy', loadConfig({ ...MINIMAL, TRUST_PROXY: '1' }).trustProxy);
    const trusts = app.get('trust proxy fn');
    expect(trusts('127.0.0.1', 0)).toBe(true);
    expect(trusts('127.0.0.1', 1)).toBe(false);
  });
});

describe('loadConfig mail provider guard', () => {
  const PROD = {
    ISSUER: 'https://id.example.org',
    DATABASE_URL: 'postgres://localhost/tunnus',
    KEY_ENCRYPTION_SECRET: KEY,
    COOKIE_SECRETS: COOKIE,
  };
  it('refuses the default console provider on an https issuer', () => {
    expect(() => loadConfig(PROD)).toThrow('MAIL_PROVIDER must be smtp or brevo');
    expect(() => loadConfig({ ...PROD, MAIL_PROVIDER: 'console' })).toThrow('ALLOW_CONSOLE_MAIL');
  });
  it('allows console on https only with ALLOW_CONSOLE_MAIL=true', () => {
    expect(loadConfig({ ...PROD, ALLOW_CONSOLE_MAIL: 'true' }).mailProvider).toBe('console');
    expect(() => loadConfig({ ...PROD, ALLOW_CONSOLE_MAIL: 'yes' })).toThrow();
  });
  it('allows console on http, and smtp or brevo on https', () => {
    const http = { ...PROD, ISSUER: 'http://localhost:3000' };
    expect(loadConfig(http).mailProvider).toBe('console');
    expect(
      loadConfig({ ...PROD, MAIL_PROVIDER: 'smtp', SMTP_URL: 'smtp://mail:25' }),
    ).toMatchObject({ mailProvider: 'smtp' });
    expect(loadConfig({ ...PROD, MAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'k' }).mailProvider).toBe(
      'brevo',
    );
  });
});

describe('loadConfig secret validation', () => {
  it('rejects a short or placeholder KEY_ENCRYPTION_SECRET', () => {
    expect(() => loadConfig({ ...MINIMAL, KEY_ENCRYPTION_SECRET: 'x'.repeat(31) })).toThrow(
      'at least 32 characters',
    );
    expect(() => loadConfig({ ...MINIMAL, KEY_ENCRYPTION_SECRET: 'change-me' })).toThrow(
      'example placeholder',
    );
    expect(
      loadConfig({ ...MINIMAL, KEY_ENCRYPTION_SECRET: 'x'.repeat(32) }).keyEncryptionSecret,
    ).toBe('x'.repeat(32));
  });
  it('rejects a short COOKIE_SECRETS item or one starting with change-me', () => {
    expect(() => loadConfig({ ...MINIMAL, COOKIE_SECRETS: 'short-value-15' })).toThrow(
      'at least 16 characters',
    );
    expect(() =>
      loadConfig({ ...MINIMAL, COOKIE_SECRETS: `${COOKIE},change-me-0123456789` }),
    ).toThrow('example placeholder');
    expect(
      loadConfig({ ...MINIMAL, COOKIE_SECRETS: `${COOKIE},${COOKIE}-old` }).cookieSecrets,
    ).toHaveLength(2);
  });
});
