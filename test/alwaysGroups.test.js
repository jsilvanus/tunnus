import { describe, expect, it } from 'vitest';
import { alwaysGroupsOf, scopeWithGroups } from '../src/oidc/alwaysGroups.js';

describe('scopeWithGroups', () => {
  const flagged = new Set(['rp']);

  it('adds groups for a flagged client', () => {
    expect(scopeWithGroups('openid email', 'rp', flagged)).toBe('openid email groups');
  });

  it('leaves other clients and existing groups alone', () => {
    expect(scopeWithGroups('openid email', 'other', flagged)).toBeUndefined();
    expect(scopeWithGroups('openid groups', 'rp', flagged)).toBeUndefined();
  });

  it('ignores a missing scope or client id', () => {
    expect(scopeWithGroups(undefined, 'rp', flagged)).toBeUndefined();
    expect(scopeWithGroups('openid', undefined, flagged)).toBeUndefined();
    expect(scopeWithGroups(['openid', 'email'], 'rp', flagged)).toBeUndefined();
  });

  it('collects the flagged client ids', () => {
    expect([
      ...alwaysGroupsOf([{ client_id: 'a', always_include_groups: true }, { client_id: 'b' }]),
    ]).toEqual(['a']);
  });
});
