import { describe, expect, it } from 'vitest';
import {
  SERVICE_ID_PATTERN,
  SERVICE_TYPE_PATTERN,
  VENUE_PATTERN,
  ServiceError,
  validateServiceAuth,
  validateServiceId,
  validateServiceInput,
} from '../src/services/validate.js';

describe('SERVICE_ID_PATTERN & validateServiceId', () => {
  it('accepts valid service IDs', () => {
    for (const id of [
      'keskuskirkko-piprogram',
      'sissi-signage',
      'anno-api',
      'pigateway_1',
      'cam-3.sali',
      'a',
      'service-123',
    ]) {
      expect(SERVICE_ID_PATTERN.test(id), id).toBe(true);
      expect(validateServiceId(id)).toBe(id);
    }
  });

  it('rejects invalid service IDs', () => {
    for (const bad of [
      '',
      '-leading',
      '.leading',
      '_leading',
      'HAS-UPPERCASE',
      'has space',
      'bad/slash',
      'a'.repeat(65),
    ]) {
      expect(SERVICE_ID_PATTERN.test(bad), String(bad)).toBe(false);
      expect(() => validateServiceId(bad)).toThrowError(ServiceError);
    }
    expect(() => validateServiceId(123)).toThrowError(ServiceError);
    expect(() => validateServiceId(null)).toThrowError(ServiceError);
  });
});

describe('SERVICE_TYPE_PATTERN & VENUE_PATTERN', () => {
  it('matches valid types and venues', () => {
    for (const val of ['piprogram', 'pigateway', 'signage', 'anno', 'parish-wide', 'keskuskirkko', 'kappeli_1']) {
      expect(SERVICE_TYPE_PATTERN.test(val)).toBe(true);
      expect(VENUE_PATTERN.test(val)).toBe(true);
    }
  });

  it('rejects invalid types and venues', () => {
    for (const bad of ['', 'has space', 'Upper', 'tool!', 'a'.repeat(33)]) {
      expect(SERVICE_TYPE_PATTERN.test(bad)).toBe(false);
      expect(VENUE_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe('validateServiceAuth', () => {
  it('defaults to type none when null or undefined', () => {
    expect(validateServiceAuth(undefined)).toEqual({ type: 'none' });
    expect(validateServiceAuth(null)).toEqual({ type: 'none' });
  });

  it('accepts valid auth configs', () => {
    expect(validateServiceAuth({ type: 'none' })).toEqual({ type: 'none' });
    expect(
      validateServiceAuth({
        type: 'api_key',
        header_name: 'X-API-Key',
      }),
    ).toEqual({
      type: 'api_key',
      header_name: 'X-API-Key',
    });
    expect(
      validateServiceAuth({
        type: 'oidc',
        client_id: 'canva-app',
        scopes: ['program:write', 'slides:push'],
        audience: 'https://keskuskirkko.local',
      }),
    ).toEqual({
      type: 'oidc',
      client_id: 'canva-app',
      scopes: ['program:write', 'slides:push'],
      audience: 'https://keskuskirkko.local',
    });
  });

  it('rejects invalid auth configs', () => {
    expect(() => validateServiceAuth('bad')).toThrowError(ServiceError);
    expect(() => validateServiceAuth({ type: 'unknown' })).toThrowError(ServiceError);
    expect(() => validateServiceAuth({ type: 'oidc', scopes: 'not-array' })).toThrowError(ServiceError);
    expect(() => validateServiceAuth({ type: 'oidc', client_id: 123 })).toThrowError(ServiceError);
  });
});

describe('validateServiceInput', () => {
  const validService = {
    id: 'keskuskirkko-piprogram',
    name: 'Keskuskirkko — Sali (Pi Program)',
    type: 'piprogram',
    venue: 'keskuskirkko',
    endpoint_url: 'https://gateway.keskuskirkko.riihimaenseurakunta.fi:8443/program',
    auth: { type: 'api_key', header_name: 'X-API-Key' },
    capabilities: ['slides', 'shutter'],
    metadata: { pipeline: 'primary' },
    disabled: false,
  };

  it('validates a complete service input on create', () => {
    const validated = validateServiceInput(validService);
    expect(validated).toMatchObject({
      id: 'keskuskirkko-piprogram',
      name: 'Keskuskirkko — Sali (Pi Program)',
      type: 'piprogram',
      venue: 'keskuskirkko',
      endpoint_url: 'https://gateway.keskuskirkko.riihimaenseurakunta.fi:8443/program',
      auth: { type: 'api_key', header_name: 'X-API-Key' },
      capabilities: ['slides', 'shutter'],
      metadata: { pipeline: 'primary' },
      disabled: false,
    });
  });

  it('accepts url as an alias for endpoint_url', () => {
    const input = {
      ...validService,
      endpoint_url: undefined,
      url: 'https://gateway.keskuskirkko.riihimaenseurakunta.fi:8443/program',
    };
    const validated = validateServiceInput(input);
    expect(validated.endpoint_url).toBe('https://gateway.keskuskirkko.riihimaenseurakunta.fi:8443/program');
  });

  it('rejects missing required fields on create', () => {
    expect(() => validateServiceInput({})).toThrowError(ServiceError);
    expect(() => validateServiceInput({ id: 'valid-id' })).toThrowError(ServiceError);
  });

  it('validates partial update payloads', () => {
    const patch = validateServiceInput({ name: 'New Name', disabled: true }, { isUpdate: true });
    expect(patch).toEqual({ name: 'New Name', disabled: true });
  });

  it('rejects invalid urls', () => {
    expect(() =>
      validateServiceInput({ ...validService, endpoint_url: 'ftp://not-allowed.org' }),
    ).toThrowError(ServiceError);
    expect(() =>
      validateServiceInput({ ...validService, endpoint_url: 'not-a-url' }),
    ).toThrowError(ServiceError);
  });
});
