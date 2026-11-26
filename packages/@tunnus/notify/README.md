# @tunnus/notify

Client library for sending outbound notifications via central Tunnus notification relay endpoints (Webhooks, Web Push, and Email).

## Installation
```bash
npm install @tunnus/notify
```

## Usage

```javascript
import {
  emitNotificationEvent,
  sendWebPushNotification,
  sendRelayEmail,
} from '@tunnus/notify';

// 1. Emit domain event to central webhook bus
await emitNotificationEvent({
  tunnusUrl: 'https://tunnus.riihimaenseurakunta.fi',
  token: process.env.TUNNUS_RELAY_TOKEN,
  event: 'shift.assigned',
  tenant: 'riihimaki',
  data: { shiftId: '123' },
});

// 2. Send Web Push to user
await sendWebPushNotification({
  tunnusUrl: 'https://tunnus.riihimaenseurakunta.fi',
  token: process.env.TUNNUS_RELAY_TOKEN,
  userId: 'user-uuid',
  notification: {
    title: 'Uusi työvuoro',
    body: 'Sinulle on merkitty vuoro.',
  },
});

// 3. Send Transactional Email
await sendRelayEmail({
  tunnusUrl: 'https://tunnus.riihimaenseurakunta.fi',
  token: process.env.TUNNUS_RELAY_TOKEN,
  from: 'App <no-reply@example.fi>',
  to: 'user@example.fi',
  subject: 'Ilmoitus',
  text: 'Hei!',
  templateId: 20,
  params: { name: 'Matti' },
});
```
