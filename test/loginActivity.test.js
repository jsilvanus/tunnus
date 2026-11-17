import { describe, expect, it } from 'vitest';
import { accountIdOf } from '../src/oidc/loginActivity.js';

describe('accountIdOf', () => {
  it('reads the session for an authorization', () => {
    expect(accountIdOf({ oidc: { session: { accountId: 'u-1' } } })).toBe('u-1');
  });

  it('reads the account of a code or a refresh token for a token request', () => {
    expect(accountIdOf({ oidc: { entities: { AuthorizationCode: { accountId: 'u-2' } } } })).toBe(
      'u-2',
    );
    expect(accountIdOf({ oidc: { entities: { RefreshToken: { accountId: 'u-3' } } } })).toBe('u-3');
  });

  it('is undefined for a grant without an account', () => {
    expect(accountIdOf({ oidc: { entities: {} } })).toBeUndefined();
    expect(accountIdOf({})).toBeUndefined();
  });
});
