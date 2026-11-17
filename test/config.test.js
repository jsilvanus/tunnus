import { describe, it, expect } from 'vitest';
import { loadConfig, loadRetentionConfig } from '../src/config.js';

const MINIMAL = {
  ISSUER: 'https://id.example.org',
  DATABASE_URL: 'postgres://localhost/tunnus',
  KEY_ENCRYPTION_SECRET: 'secret',
  COOKIE_SECRETS: 'cookie',
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
