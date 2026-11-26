/**
 * Web Push Client Helper
 *
 * Utilities for registering the Service Worker, subscribing to Web Push with
 * a VAPID public key, and unsubscribing.
 *
 * Designed to work directly in modern browsers and easily packable as an npm module.
 */

/**
 * Convert a base64 / base64url string to Uint8Array (required for pushManager.subscribe applicationServerKey).
 * @param {string} base64String
 * @returns {Uint8Array}
 */
export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const decode =
    typeof atob === 'function'
      ? atob
      : (str) => Buffer.from(str, 'base64').toString('binary');
  const rawData = decode(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Check whether Web Push and Service Workers are supported in the current browser.
 * @returns {boolean}
 */
export function isPushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * Register the Service Worker script if not already registered.
 * @param {string} [swPath='/sw.js'] Path to the service worker file
 * @param {RegistrationOptions} [options]
 * @returns {Promise<ServiceWorkerRegistration>}
 */
export async function registerPushServiceWorker(swPath = '/sw.js', options) {
  if (!isPushSupported()) {
    throw new Error('Push notifications are not supported in this browser.');
  }
  return await navigator.serviceWorker.register(swPath, options);
}

/**
 * Request notification permission from the user and subscribe to PushManager using the VAPID public key.
 *
 * @param {object} params
 * @param {string} params.vapidPublicKey The VAPID applicationServerKey (base64 or base64url encoded)
 * @param {string} [params.swPath='/sw.js'] Path to the Service Worker script
 * @returns {Promise<PushSubscription>}
 */
export async function subscribeToPush({ vapidPublicKey, swPath = '/sw.js' }) {
  if (!isPushSupported()) {
    throw new Error('Push notifications are not supported in this browser.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(`Notification permission denied: ${permission}`);
  }

  const registration = await registerPushServiceWorker(swPath);
  await navigator.serviceWorker.ready;

  let subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    return subscription;
  }

  const convertedKey = urlBase64ToUint8Array(vapidPublicKey);
  subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: convertedKey,
  });

  return subscription;
}

/**
 * Unsubscribe the current device from PushManager.
 * @returns {Promise<boolean>} True if unsubscribed successfully
 */
export async function unsubscribeFromPush() {
  if (!isPushSupported()) return false;

  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return false;

  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return false;

  return await subscription.unsubscribe();
}

/**
 * Serializes the PushSubscription object to a clean JSON object ready to be sent to Tunnus.
 * @param {PushSubscription} subscription
 * @returns {{ endpoint: string, keys: { p256dh: string, auth: string } }}
 */
export function serializePushSubscription(subscription) {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('Invalid PushSubscription object');
  }
  return {
    endpoint: json.endpoint,
    keys: {
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    },
  };
}
