import { describe, it, expect, vi } from 'vitest';
import { urlBase64ToUint8Array, serializePushSubscription } from '../src/client/push.js';

describe('Web Push Client Helpers', () => {
  it('converts base64 and base64url strings to Uint8Array', () => {
    // Valid standard base64 test
    const inputBase64 = 'AQAB';
    const result = urlBase64ToUint8Array(inputBase64);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(3);

    // Valid base64url test with - and _
    const inputBase64Url = 'AQ-_';
    const resultUrl = urlBase64ToUint8Array(inputBase64Url);
    expect(resultUrl).toBeInstanceOf(Uint8Array);
    expect(resultUrl.length).toBe(3);
  });

  it('serializes a PushSubscription to clean JSON', () => {
    const mockSubscription = {
      toJSON: () => ({
        endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint',
        keys: {
          p256dh: 'BNcRdreALRFdj',
          auth: 'tBHItDaMG',
        },
      }),
    };

    const serialized = serializePushSubscription(/** @type {any} */ (mockSubscription));
    expect(serialized).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint',
      keys: {
        p256dh: 'BNcRdreALRFdj',
        auth: 'tBHItDaMG',
      },
    });
  });

  it('throws on invalid PushSubscription object during serialization', () => {
    const invalidSubscription = {
      toJSON: () => ({
        endpoint: '',
        keys: null,
      }),
    };

    expect(() => serializePushSubscription(/** @type {any} */ (invalidSubscription))).toThrow(
      'Invalid PushSubscription object'
    );
  });
});
