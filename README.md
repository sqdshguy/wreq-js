# wreq-js

High-performance Node.js bindings for the Rust-based wreq HTTP client with native TLS and HTTP/2 browser impersonation.

Note: This is a personal fork of [will-work-for-meal/node-wreq](https://github.com/will-work-for-meal/node-wreq) (originally named node-wreq) with ongoing maintenance and faster dependency updates.

## Features

- Native performance (no process spawning)
- TLS fingerprinting (JA3/JA4) aligned with real browsers
- HTTP/2 fingerprinting: SETTINGS, PRIORITY, and header ordering
- Multiple browser profiles (Chrome, Firefox, Safari, Edge, Opera, OkHttp)
- WebSocket support
- TypeScript definitions included

## How It Works

The library provides Node.js bindings over [wreq](https://github.com/0x676e67/wreq), a Rust HTTP client that uses BoringSSL to replicate browser network behavior at the TLS and HTTP/2 layers.

### Why It Works

Traditional HTTP clients (axios, fetch, curl) have differences in:
- **TLS handshake signatures** — Different cipher suites and extensions
- **HTTP/2 frame ordering** — Different SETTINGS and PRIORITY patterns
- **Header ordering** — Different sequence and values

This library reproduces browser network behavior with high fidelity.

### Browser Profiles and wreq-util

- Browser profiles are generally tracked in the upstream `wreq-util` project; we depend on it for compatibility and support.
- Profiles in this package are available in `src/generated-types.ts` and are automatically generated from the `wreq-util` codebase to improve update speed and reduce maintenance overhead.
- Use `getProfiles()` to query the current set of supported profiles programmatically.

## Installation

```bash
# From GitHub (this fork)
# Latest master branch
npm install wreq-js
yarn add wreq-js
pnpm add wreq-js
bun add wreq-js

# From npm registry (original repo as node-wreq)
npm install node-wreq
yarn add node-wreq
pnpm add node-wreq
bun add node-wreq
```

Pre-built native modules are included for major platforms:
- macOS (Intel and Apple Silicon)
- Linux (x64 and ARM64)
- Windows (x64)

Note on GitHub installs: if a matching prebuilt binary is not available for the referenced tag/commit, installation may build from source. Ensure a Rust toolchain and platform build prerequisites are installed.

## Usage

### Basic Request

```typescript
import { request } from 'wreq-js';

const response = await request({
  url: 'https://example.com/api',
  browser: 'chrome_137',
});

console.log(response.status);  // 200
console.log(response.body);    // Response body
console.log(response.headers); // Response headers
console.log(response.cookies); // Cookies
```

### With Custom Headers

```typescript
import { request } from 'wreq-js';

const response = await request({
  url: 'https://api.example.com/data',
  browser: 'firefox_139',
  headers: {
    'Authorization': 'Bearer token123',
    'Custom-Header': 'value',
  },
});
```

### POST Request

```typescript
import { post } from 'wreq-js';

const response = await post(
  'https://api.example.com/submit',
  JSON.stringify({ foo: 'bar' }),
  {
    browser: 'chrome_137',
    headers: {
      'Content-Type': 'application/json',
    },
  }
);
```

### Convenience Methods

```typescript
import { get, post } from 'wreq-js';

// GET request
const data = await get('https://api.example.com/users');

// POST request
const result = await post(
  'https://api.example.com/users',
  JSON.stringify({ name: 'John' })
);
```

### With Proxy

```typescript
import { request } from 'wreq-js';

const response = await request({
  url: 'https://example.com',
  browser: 'chrome_137',
  // proxy: 'http://proxy.example.com:8080',
  // proxy: 'http://username:password@proxy.example.com:8080',
  // proxy: 'socks5://proxy.example.com:1080',
});
```

### WebSocket Connection

```typescript
import { websocket } from 'wreq-js';

const ws = await websocket({
  url: 'wss://echo.websocket.org',
  browser: 'chrome_137',
  onMessage: (data) => {
    console.log('Received:', data);
  },
  onClose: () => {
    console.log('Connection closed');
  },
  onError: (error) => {
    console.error('Error:', error);
  },
});

// Send text message
await ws.send('Hello!');

// Send binary message
await ws.send(Buffer.from([1, 2, 3]));

// Close connection
await ws.close();
```

## API Reference

### `request(options:` [`RequestOptions`](#requestoptions)`): Promise<`[`Response`](#response)`>`

Main function for making HTTP requests with browser impersonation.

**Options:**
<a name="requestoptions"></a>

```typescript
interface RequestOptions {
  url: string;                    // Required: URL to request
  browser?: BrowserProfile;       // Default: 'chrome_137'
  method?: HttpMethod;            // Default: 'GET'
  headers?: Record<string, string>;
  body?: string;
  proxy?: string;                 // HTTP/HTTPS/SOCKS5 proxy URL
  timeout?: number;               // Default: 30000ms
}
```

**Response:**
<a name="response"></a>

```typescript
interface Response {
  status: number;
  headers: Record<string, string>;
  body: string;
  cookies: Record<string, string>;
  url: string;  // Final URL after redirects
}
```

### `get(url: string, options?): Promise<`[`Response`](#response)`>`

### `post(url: string, body?: string, options?): Promise<`[`Response`](#response)`>`

### `websocket(options:` [`WebSocketOptions`](#websocketoptions)`): Promise<WebSocket>`


**Options:**
<a name="websocketoptions"></a>

```typescript
interface WebSocketOptions {
  url: string;                                  // Required: WebSocket URL (ws:// or wss://)
  browser?: BrowserProfile;                     // Default: 'chrome_137'
  headers?: Record<string, string>;
  proxy?: string;                               // HTTP/HTTPS/SOCKS5 proxy URL
  onMessage: (data: string | Buffer) => void;   // Required: Message callback
  onClose?: () => void;                         // Optional: Close callback
  onError?: (error: string) => void;            // Optional: Error callback
}
```

**WebSocket Methods:**

```typescript
class WebSocket {
  send(data: string | Buffer): Promise<void>;
  close(): Promise<void>;
}
```

### `getProfiles():` [`BrowserProfile[]`](#browser-profiles)

Get list of available browser profiles.

```typescript
import { getProfiles } from 'wreq-js';

const profiles = getProfiles();

console.log(profiles);
// ['chrome_100', 'chrome_101', ..., 'chrome_137', 'edge_101', ..., 'safari_18', ...]
```

## Documentation

- **[Architecture Guide](docs/ARCHITECTURE.md)** — Technical details about TLS/HTTP2 fingerprinting, how browser impersonation works
- **[Build Instructions](docs/BUILD.md)** — Developer guide for building from source
- **[Publishing Guide](docs/PUBLISHING.md)** — How to publish the package

## Contributing

Please read the [Contributing Guide](CONTRIBUTING.md).

## Acknowledgments

- [wreq](https://github.com/0x676e67/wreq) — Rust HTTP client with browser impersonation
- [wreq-util](https://github.com/0x676e67/wreq-util) — Upstream utility project that tracks and ships browser fingerprint updates rapidly
- [Neon](https://neon-bindings.com/) — Rust ↔ Node.js bindings
- Original Node.js wrapper: [will-work-for-meal/node-wreq](https://github.com/will-work-for-meal/node-wreq) (named node-wreq) — clean, well-written baseline this fork builds on
