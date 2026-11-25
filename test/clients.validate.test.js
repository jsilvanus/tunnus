import { describe, expect, it } from 'vitest';
import {
  ALLOWED_METADATA_KEYS,
  CLIENT_ID_PATTERN,
  ClientError,
  generateClientSecret,
  isAllowedUrl,
  normalizeClientForProvider,
  validateClientId,
  validateMetadata,
  validateSuppliedSecret,
  validateWithOidcProvider,
} from '../src/clients/validate.js';

describe('CLIENT_ID_PATTERN & validateClientId', () => {
  it('accepts valid client IDs', () => {
    for (const id of ['a', 'app1', 'my-app_1.2', 'A'.repeat(100)]) {
      expect(CLIENT_ID_PATTERN.test(id), id).toBe(true);
      expect(validateClientId(id)).toBe(id);
    }
  });

  it('rejects invalid client IDs with ClientError', () => {
    for (const bad of ['', '-lead', '.lead', '_lead', 'a'.repeat(101), 'has space', 'a/b', 'a!b']) {
      expect(CLIENT_ID_PATTERN.test(bad), String(bad)).toBe(false);
      expect(() => validateClientId(bad)).toThrowError(ClientError);
    }
    expect(() => validateClientId(123)).toThrowError(ClientError);
  });
});

describe('isAllowedUrl', () => {
  it('allows https and localhost / 127.0.0.1 http URLs', () => {
    for (const ok of [
      'https://app.example.org/cb',
      'https://app.example.org:8443/auth/callback?x=1',
      'http://localhost/cb',
      'http://localhost:3000/cb',
      'http://127.0.0.1/cb',
      'http://127.0.0.1:8080/cb',
      'https://localhost:3000/cb',
    ]) {
      expect(isAllowedUrl(ok), ok).toBe(true);
    }
  });

  it('rejects non-https non-loopback URLs, relative paths, and whitespace', () => {
    for (const bad of [
      '',
      'http://example.com/cb',
      'http://localhost.evil.com/cb',
      'http://[::1]:3000/cb',
      'ftp://app.example.org/cb',
      'javascript:alert(1)',
      '/relative/path',
      ' https://app.example.org/cb',
      'https://app.example.org/cb ',
      'https://app.example.org/with space',
      null,
      42,
    ]) {
      expect(isAllowedUrl(bad), String(bad)).toBe(false);
    }
  });
});

describe('validateMetadata', () => {
  it('allows exact 12 metadata keys', () => {
    expect(ALLOWED_METADATA_KEYS.size).toBe(12);
    const input = {
      redirect_uris: ['https://app.example.org/cb'],
      post_logout_redirect_uris: ['https://app.example.org/bye'],
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      first_party: true,
      always_include_groups: true,
      allowed_resources: ['https://app.example.org/mcp'],
      backchannel_logout_uri: 'https://app.example.org/backchannel',
      backchannel_logout_session_required: false,
      id_token_signed_response_alg: 'RS256',
      client_name: 'My App',
    };
    expect(validateMetadata(input)).toEqual(input);
  });

  it('rejects unknown keys including client_secret with path and unknown property message', () => {
    for (const key of ['client_secret', 'jwks', 'sector_identifier_uri', 'bogus']) {
      try {
        validateMetadata({ redirect_uris: ['https://app.example.org/cb'], [key]: 'x' });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ClientError);
        const ce = /** @type {ClientError} */ (err);
        expect(ce.code).toBe('invalid_request');
        expect(ce.details).toEqual([{ path: `/${key}`, message: 'unknown property' }]);
      }
    }
  });

  it('validates URL fields, auth method, booleans, and null clearing', () => {
    expect(() => validateMetadata({ redirect_uris: ['http://evil.example.org/cb'] })).toThrowError(
      ClientError,
    );
    expect(() =>
      validateMetadata({ backchannel_logout_uri: 'http://evil.example.org/logout' }),
    ).toThrowError(ClientError);
    expect(() => validateMetadata({ allowed_resources: ['https://ok.example/a b'] })).toThrowError(
      ClientError,
    );
    expect(() =>
      validateMetadata({ token_endpoint_auth_method: 'client_secret_jwt' }),
    ).toThrowError(ClientError);
    expect(() => validateMetadata({ redirect_uris: [] })).toThrowError(ClientError);
    expect(() => validateMetadata({ first_party: 'yes' })).toThrowError(ClientError);
    expect(() => validateMetadata({ client_name: '   ' })).toThrowError(ClientError);

    expect(() =>
      validateMetadata({ backchannel_logout_uri: null }, { allowNullClear: false }),
    ).toThrowError(ClientError);
    expect(
      validateMetadata(
        { backchannel_logout_uri: null, client_name: null },
        { allowNullClear: true },
      ),
    ).toEqual({ backchannel_logout_uri: null, client_name: null });
    expect(() => validateMetadata({ redirect_uris: null }, { allowNullClear: true })).toThrowError(
      ClientError,
    );
  });
});

describe('secrets and oidc-provider validation', () => {
  it('generates 32-byte base64url secrets and validates supplied secrets', () => {
    const s1 = generateClientSecret();
    const s2 = generateClientSecret();
    expect(s1).not.toBe(s2);
    expect(Buffer.from(s1, 'base64url')).toHaveLength(32);
    expect(validateSuppliedSecret(s1)).toBe(s1);
    expect(() => validateSuppliedSecret('too-short')).toThrowError(ClientError);
    expect(() => validateSuppliedSecret('a'.repeat(32) + '\n')).toThrowError(ClientError);
    expect(() => validateSuppliedSecret('a'.repeat(32) + '\r')).toThrowError(ClientError);
  });

  it('normalizes client metadata for oidc-provider', () => {
    expect(
      normalizeClientForProvider({
        client_id: 'app',
        redirect_uris: ['https://app.example.org/cb'],
        backchannel_logout_uri: null,
        client_name: undefined,
      }),
    ).toEqual({
      id_token_signed_response_alg: 'RS256',
      client_id: 'app',
      redirect_uris: ['https://app.example.org/cb'],
      always_include_groups: false,
      first_party: false,
      disabled: false,
    });
  });

  it('validates confidential and public clients with oidc-provider', async () => {
    await expect(
      validateWithOidcProvider({
        client_id: 'app',
        client_secret: 'a'.repeat(32),
        redirect_uris: ['https://app.example.org/cb'],
        grant_types: ['authorization_code', 'refresh_token'],
      }),
    ).resolves.toBeUndefined();

    await expect(
      validateWithOidcProvider({
        client_id: 'pub',
        token_endpoint_auth_method: 'none',
        redirect_uris: ['http://127.0.0.1:4200/cb'],
      }),
    ).resolves.toBeUndefined();

    await expect(
      validateWithOidcProvider({
        client_id: 'missing-sec',
        redirect_uris: ['https://app.example.org/cb'],
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    await expect(
      validateWithOidcProvider({
        client_id: 'bad-grant',
        client_secret: 'a'.repeat(32),
        redirect_uris: ['https://app.example.org/cb'],
        grant_types: ['client_credentials'],
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    await expect(
      validateWithOidcProvider({
        client_id: 'frag-uri',
        client_secret: 'a'.repeat(32),
        redirect_uris: ['https://app.example.org/cb#frag'],
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('allowed_resources bare identifiers', () => {
  it('accepts resource identifiers such as pigateway alongside https URLs', () => {
    expect(
      validateMetadata({
        allowed_resources: ['pigateway', 'https://kehitys.riihimaenseurakunta.fi/sissi'],
      }),
    ).toEqual({
      allowed_resources: ['pigateway', 'https://kehitys.riihimaenseurakunta.fi/sissi'],
    });
    expect(() => validateMetadata({ allowed_resources: ['bad space'] })).toThrowError(ClientError);
  });
});
