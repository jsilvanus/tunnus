# @tunnus/push

Frontend Web Push notification helper utilities and Service Worker for Tunnus.

## Installation
```bash
npm install @tunnus/push
```

## Usage
```javascript
import { isPushSupported, subscribeToPush, serializePushSubscription } from '@tunnus/push';

if (isPushSupported()) {
  const subscription = await subscribeToPush({
    vapidPublicKey: 'BK3_...',
    swPath: '/sw.js',
  });
  const data = serializePushSubscription(subscription);
  // Send data to Tunnus /api/push/subscribe
}
```

Copy `node_modules/@tunnus/push/src/sw.js` to your public root as `sw.js`.
