import { describe, it, expect } from 'vitest';
import { loadRetentionConfig } from '../src/config.js';

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
