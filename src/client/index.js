export {
  createDiscoveryClient,
  startServiceDiscovery,
  fetchDiscoveryCatalog,
} from './discovery.js';

export {
  createApiClient,
  ApiError,
  describeApiError,
} from './http.js';

export {
  ConfigError,
  resolveClientConfig,
  defaultConfigPath,
} from './config.js';

export {
  isPushSupported,
  registerPushServiceWorker,
  subscribeToPush,
  unsubscribeFromPush,
  serializePushSubscription,
  urlBase64ToUint8Array,
} from './push.js';

export {
  emitNotificationEvent,
  sendWebPushNotification,
  sendRelayEmail,
} from './notify.js';
