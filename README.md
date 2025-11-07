# node-wreq

🚀 High-performance browser fingerprint bypass library using Rust for native TLS/HTTP2 impersonation.

> **Node.js wrapper for [wreq](https://github.com/0x676e67/wreq)** — A powerful Rust HTTP client with browser impersonation capabilities.

> **Note:** This is a fork of [will-work-for-meal/node-wreq](https://github.com/will-work-for-meal/node-wreq) with personal updates and more frequent dependency updates (wreq-util, etc.).

## ✨ Features

- ⚡ **Native Performance** — 50-100x faster than curl-impersonate (no process spawning)
- 🔒 **TLS Fingerprinting** — Perfect JA3/JA4 signatures matching real browsers
- 🌐 **HTTP/2 Fingerprinting** — Authentic SETTINGS frames, PRIORITY, and header ordering
- 🎭 **Multiple Browser Profiles** — Chrome, Firefox, Safari, Edge, Opera, OkHttp (78+ profiles)
- 🔌 **WebSocket Support**
- 📦 **Zero Dependencies** — Pure Rust with BoringSSL under the hood
- 💎 **TypeScript Support** — Full type definitions included
- 🛡️ **Protection Bypass** — Cloudflare, Akamai, and other anti-bot systems

## 🔧 How It Works

The library is a Node.js wrapper for **[wreq](https://github.com/0x676e67/wreq)** (Rust HTTP client) with **BoringSSL** (Google's TLS library — the same one used in Chrome) to create requests that are indistinguishable from real browsers at the network level.

### Why It Works

Traditional HTTP clients (axios, fetch, curl) have differences in:
- **TLS handshake signatures** — Different cipher suites and extensions
- **HTTP/2 frame ordering** — Different SETTINGS and PRIORITY patterns
- **Header ordering** — Different sequence and values

This library precisely replicates the network behavior of real browsers.

## 📦 Installation

```bash
# npm
npm install node-wreq

# yarn
yarn add node-wreq

# pnpm
pnpm add node-wreq
```

That's it! 🎉 Pre-built native modules are included for all major platforms:
- 🍎 macOS (Intel & Apple Silicon)
- 🐧 Linux (x64 & ARM64)
- 🪟 Windows (x64)

## 💻 Usage

### Basic Request

```typescript
import { request } from 'node-wreq';

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
import { request } from 'node-wreq';

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
import { post } from 'node-wreq';

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
import { get, post } from 'node-wreq';

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
import { request } from 'node-wreq';

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
import { websocket } from 'node-wreq';

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

## 📚 API Reference

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
import { getProfiles } from 'node-wreq';

const profiles = getProfiles();

console.log(profiles);
// ['chrome_100', 'chrome_101', ..., 'chrome_137', 'edge_101', ..., 'safari_18', ...]
```

## 🎭 Browser Profiles
<a name="browser-profiles"></a>

Available browser profiles (78+ profiles):

### Chrome
29 versions from Chrome 100 to Chrome 137:
- `chrome_100`, `chrome_101`, `chrome_104`, `chrome_105`, `chrome_106`, `chrome_107`, `chrome_108`, `chrome_109`, `chrome_110`
- `chrome_114`, `chrome_116`, `chrome_117`, `chrome_118`, `chrome_119`, `chrome_120`, `chrome_123`, `chrome_124`, `chrome_126`
- `chrome_127`, `chrome_128`, `chrome_129`, `chrome_130`, `chrome_131`, `chrome_132`, `chrome_133`, `chrome_134`, `chrome_135`, `chrome_136`, `chrome_137`

### Edge
5 versions: `edge_101`, `edge_122`, `edge_127`, `edge_131`, `edge_134`

### Safari
19 versions including iOS and iPad:
- Desktop: `safari_15_3`, `safari_15_5`, `safari_15_6_1`, `safari_16`, `safari_16_5`, `safari_17_0`, `safari_17_2_1`, `safari_17_4_1`, `safari_17_5`, `safari_18`, `safari_18_2`, `safari_18_3`, `safari_18_3_1`, `safari_18_5`
- iOS: `safari_ios_16_5`, `safari_ios_17_2`, `safari_ios_17_4_1`, `safari_ios_18_1_1`
- iPad: `safari_ipad_18`

### Firefox
10 versions including private and Android:
- `firefox_109`, `firefox_117`, `firefox_128`, `firefox_133`, `firefox_135`, `firefox_136`, `firefox_139`
- Private: `firefox_private_135`, `firefox_private_136`
- Android: `firefox_android_135`

### Opera
4 versions: `opera_116`, `opera_117`, `opera_118`, `opera_119`

### OkHttp (Android HTTP client)
8 versions: `okhttp_3_9`, `okhttp_3_11`, `okhttp_3_13`, `okhttp_3_14`, `okhttp_4_9`, `okhttp_4_10`, `okhttp_4_12`, `okhttp_5`

> Use `getProfiles()` to get the complete list programmatically.

## 📖 Documentation

- **[Architecture Guide](docs/ARCHITECTURE.md)** — Technical details about TLS/HTTP2 fingerprinting, how browser impersonation works
- **[Build Instructions](docs/BUILD.md)** — Developer guide for building from source
- **[Publishing Guide](docs/PUBLISHING.md)** — How to publish the package

## 🤝 Contributions are welcome!

Please read [Contributing Guide](CONTRIBUTING.md).

## 🙏 Acknowledgments

Built with:
- [wreq](https://github.com/0x676e67/wreq) — Rust HTTP client with browser impersonation
- [Neon](https://neon-bindings.com/) — Rust ↔ Node.js bindings
