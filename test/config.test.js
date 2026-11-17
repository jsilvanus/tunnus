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
