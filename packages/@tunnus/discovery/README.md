# @tunnus/discovery

Zero-dependency service discovery and heartbeat client for Tunnus microservices.

## Installation
```bash
npm install @tunnus/discovery
```

## Usage
```javascript
import { createDiscoveryClient, startServiceDiscovery } from '@tunnus/discovery';

const discovery = createDiscoveryClient({
  tunnusUrl: process.env.TUNNUS_URL,
  clientKey: process.env.TUNNUS_CLIENT_ID,
  clientSecret: process.env.TUNNUS_CLIENT_SECRET,
});

await discovery.register({
  serviceName: 'vuorot',
  serviceUrl: 'https://vuorot.riihimaenseurakunta.fi',
});
```
