# wreq-js

High-performance HTTP client for Node.JS with real-browser TLS and HTTP/2 fingerprints, powered by Rust.

- ⚡️ A modern, actively maintained alternative to outdated browser-impersonating clients and legacy wrappers.  
- When it comes to web scraping and automation, keeping up with the latest developments is NOT optional. Detection systems like Akamai and Cloudflare change every day using machine learning, old fingerprints are quickly detected.
- `wreq-js` builds upon the Rust-based [`wreq`](https://github.com/0x676e67/wreq) engine to deliver drop-in Node.js bindings that feel like `fetch()` but behave like a real browser.

> This is my maintained fork of [will-work-for-meal/node-wreq](https://github.com/will-work-for-meal/node-wreq), originally named `node-wreq`, with ongoing updates and dependency refreshes for compatibility and speed.

## Features

- **Native performance** — no process spawning or browser overhead  
- **Real browser TLS fingerprints** (JA3/JA4)  
- **HTTP/2 impersonation** — replicates SETTINGS, PRIORITY, and header ordering  
- **Multiple browser profiles** — Chrome, Firefox, Safari, Edge, Opera, OkHttp  
- **WebSocket support** with browser fingerprint consistency  
- **Prebuilt native binaries** for macOS, Linux, and Windows  
- **TypeScript-ready** with generated definitions

## Installation

```bash
npm install wreq-js
# or
yarn add wreq-js
pnpm add wreq-js
bun add wreq-js
```

Prebuilt binaries are provided for:
- macOS (Intel & Apple Silicon)
- Linux (x64 & ARM64)
- Windows (x64)

> ⚠️ If a prebuilt binary for your platform or commit is unavailable, the package will build from source.  
> Make sure a Rust toolchain and required build dependencies are installed.

## Why It Exists

HTTP clients like `axios`, `fetch`, `got`, `curl`  do not behave like browsers on the network layer.  
They differ in:

- **TLS handshake** - unique cipher suite order and extension sets  
- **HTTP/2 frames** - different SETTINGS and PRIORITY sequences  
- **Header ordering** - deterministic but non-browser-compliant  

These subtle differences are enough for modern detection systems to identify automation.  
`wreq-js` reproduces browser networking behavior using the `wreq` Rust engine underneath.  
Your job is to write scripts, ours is to make them undetectable, yet effortless.

## Architecture Overview

`wreq-js` provides Node.js bindings over [`wreq`](https://github.com/0x676e67/wreq), a Rust HTTP client built on **BoringSSL** to emulate browser TLS and HTTP/2 stacks.  
Browser profiles are defined in the upstream [`wreq-util`](https://github.com/0x676e67/wreq-util) project and automatically synchronized here for faster updates.

To query supported profiles:

```typescript
import { getProfiles } from 'wreq-js';
console.log(getProfiles());
// ['chrome_142', 'firefox_139', 'edge_120', 'safari_18', ...]
```

## Quick Start

```typescript
import { fetch } from 'wreq-js';

const response = await fetch('https://example.com/api', {
  browser: 'chrome_142',
});

console.log(await response.json());
```

That’s it, you now have full browser impersonation, drop-in compatibility with the `fetch()` API.

## Advanced Usage

### Custom Headers

```typescript
import { fetch, Headers } from 'wreq-js';

const response = await fetch('https://api.example.com/data', {
  browser: 'firefox_139',
  headers: new Headers({
    Authorization: 'Bearer token123',
    'Custom-Header': 'value',
  }),
});
```

By default, browser emulation headers (like `Accept`, `Accept-Language`, `User-Agent`, etc.) are automatically added and may be appended to your custom headers. To prevent this and use **only** your custom headers:

```typescript
const response = await fetch('https://api.example.com/data', {
  browser: 'chrome_142',
  headers: {
    'Accept': '*/*',
    'User-Agent': 'CustomBot/1.0',
  },
  disableDefaultHeaders: true, // Disable emulation headers
});
```

### POST Request

```typescript
const res = await fetch('https://api.example.com/submit', {
  method: 'POST',
  browser: 'chrome_142',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ foo: 'bar' }),
});
```

## Session & Cookie Isolation

Each `fetch()` call runs in **ephemeral mode** so that TLS caches, cookies, and session data never leak across requests.
To persist state, use `createSession()` or `withSession()`:

```typescript
import { createSession, withSession } from 'wreq-js';

const session = await createSession({ browser: 'chrome_142' });
await session.fetch('https://example.com/login', { method: 'POST', body: '...' });
await session.fetch('https://example.com/dashboard');
await session.close();

// Auto-disposing helper
await withSession(async (s) => {
  await s.fetch('https://example.com/a');
  await s.fetch('https://example.com/b');
});

For finer control:

```typescript
await fetch('https://example.com', {
  sessionId: 'user-42',
  cookieMode: 'session',
});
```

## WebSocket Example

```typescript
import { websocket } from 'wreq-js';

const ws = await websocket({
  url: 'wss://echo.websocket.org',
  browser: 'chrome_142',
  onMessage: (data) => console.log('Received:', data),
});

await ws.send('Hello!');
await ws.close();
```

## API Reference

The API is aiming to be `fetch`-compatible, with a few `wreq`-specific extensions.  
See inline TypeScript definitions for complete typings.

```typescript
interface RequestInit {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  signal?: AbortSignal | null;
  redirect?: 'follow';
  browser?: BrowserProfile;
  proxy?: string;
  timeout?: number;
  cookieMode?: 'session' | 'ephemeral';
  session?: Session;
  sessionId?: string;
  disableDefaultHeaders?: boolean; // Prevent emulation headers from being appended
}
```

## Documentation

- **[Architecture Guide](docs/ARCHITECTURE.md)** - How fingerprinting and impersonation work  
- **[Build Instructions](docs/BUILD.md)** - Build from source  
- **[Publishing Guide](docs/PUBLISHING.md)** - Releasing new versions

## Contributing

Please read the [Contributing Guide](CONTRIBUTING.md).

## Origins
This project began as a fork of [will-work-for-meal/node-wreq](https://github.com/will-work-for-meal/node-wreq) but has since evolved into an independent implementation with extensive rewrites, new APIs, and active maintenance. It is not affiliated with the original project.

## Acknowledgments

- [wreq](https://github.com/0x676e67/wreq) - Rust HTTP client with browser impersonation  
- [wreq-util](https://github.com/0x676e67/wreq-util) - Source of up-to-date browser profiles  
- [Neon](https://neon-bindings.com/) - Rust ↔ Node.js bindings  
- [will-work-for-meal/node-wreq](https://github.com/will-work-for-meal/node-wreq) - Original Node.js wrapper foundation
