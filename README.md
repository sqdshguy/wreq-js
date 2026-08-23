# wreq-js

[![npm](https://img.shields.io/npm/v/wreq-js.svg)](https://www.npmjs.com/package/wreq-js)
[![downloads](https://img.shields.io/npm/dm/wreq-js.svg)](https://www.npmjs.com/package/wreq-js)
[![CI](https://github.com/sqdshguy/wreq-js/actions/workflows/test.yml/badge.svg)](https://github.com/sqdshguy/wreq-js/actions/workflows/test.yml)
[![node](https://img.shields.io/node/v/wreq-js.svg)](https://www.npmjs.com/package/wreq-js)
[![license](https://img.shields.io/npm/l/wreq-js.svg)](./LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/sqdshguy/wreq-js)

`wreq-js` is an HTTP client for Node.js and TypeScript that makes your requests look like they came from a real browser, all the way down to the TLS handshake. It is built on native Rust bindings to [wreq](https://github.com/0x676e67/wreq), which uses BoringSSL under the hood.

If your code works in the browser but gets a 403 from Node, the usual reason is that your network fingerprint gives you away. Services like Cloudflare, DataDome, Akamai and PerimeterX look at your JA3 and JA4 TLS fingerprints and your HTTP/2 SETTINGS frame, and no amount of setting a `User-Agent` header will fix a mismatch there. Node's `tls` module does not expose the knobs you would need. This library does it at the native layer, so you get Cloudflare bypass and DataDome bypass behaviour at the transport level while keeping a normal `fetch` style API.

It stops at the transport layer. It does not run JavaScript, solve CAPTCHAs or handle behavioural analysis, so Turnstile, Akamai sensor data and Kasada need something like Playwright instead. If a target serves an interstitial that requires script execution, no TLS-level client gets past it, this one included.

```ts
import { fetch } from 'wreq-js';

const res = await fetch('https://example.com/api', {
  browser: 'chrome_149',
  os: 'windows',
});

console.log(await res.json());
```

## Install

```bash
npm install wreq-js
# or: yarn add wreq-js / pnpm add wreq-js / bun add wreq-js
```

Prebuilt native binaries ship for macOS (Intel and Apple Silicon), Linux (x64 and arm64, glibc and musl), Windows (x64 and arm64), and Android arm64 under Termux. Each one lives in its own `@wreq-js/binding-*` package listed under `optionalDependencies`, so an install downloads only the addon your platform actually loads. Platforms outside that list are not supported; build from source with a Rust toolchain instead (see [docs/BUILD.md](docs/BUILD.md)).

Node.js 20 or newer.

## Features

- Browser TLS and HTTP fingerprint profiles for Chrome, Firefox, Safari, Edge, Opera and OkHttp, currently up to Chrome 149 and Firefox 151
- JA3, JA4 and Akamai HTTP/2 fingerprints that match what the real browser sends, verified against live capture (see [Alternatives](#alternatives))
- Native Rust engine running in-process, no subprocess and no browser
- `fetch` style API, plus sessions with a persistent cookie jar
- WebSockets, both a one-await helper and a WHATWG style constructor, able to reuse session cookies and transport settings
- Streaming request and response bodies with backpressure
- Proxy support including SOCKS, per-request transport overrides, and connection pool tuning
- Custom emulation if a preset gets you close but not all the way, with control over cipher order, extensions, ALPN, ALPS, GREASE, HTTP/2 SETTINGS and pseudo-header order
- Written in TypeScript with generated definitions

## Alternatives

Measured 2026-08-06 on an M-series Mac. "H2 correct" means the Akamai HTTP/2 fingerprint is byte identical to what real Chrome sends. Throughput is 300 sequential requests against a local server, so it reflects the JavaScript to native boundary rather than the network. Reproduce with `npm run bench`.

| Library | Engine | Newest Chrome | H2 correct | req/s | Cold start |
|---|---|---|---|---|---|
| **wreq-js** | Rust `wreq` + BoringSSL, in-process | **149** | **Yes** | **12842** | **7 ms** |
| [node-wreq](https://github.com/StopMakingThatBigFace/node-wreq) | Same Rust core | 149 | Yes | 6500 | 10 ms |
| [impers](https://github.com/lexiforest/impers) | curl-impersonate, in-process | 146 | Yes | 8439 | 16 ms |
| [impit](https://github.com/apify/impit) | Rust `reqwest` + patched `rustls` | 124 | **No** ([#385](https://github.com/apify/impit/issues/385)) | 6710 | 37 ms |
| [node-tls-client](https://github.com/Sahil1337/node-tls-client) | Go shared library over FFI | 131 | Yes | not tested | downloads its native library at runtime |
| [CycleTLS](https://github.com/Danny-Dasilva/CycleTLS) | Go subprocess with IPC | not tested | not tested | not tested | per-request IPC overhead |
| [got-scraping](https://github.com/apify/got-scraping) | Pure JS, headers only | n/a | no TLS control | n/a | end of life |

impit's HTTP/2 SETTINGS are its underlying Rust HTTP library's defaults rather than Chrome's, so it omits `HEADER_TABLE_SIZE` and sends a `MAX_FRAME_SIZE` that Chrome never sends. Anything hashing that frame sees a client claiming to be Chrome while speaking HTTP/2 like a Rust program.

If you are migrating off `got-scraping`, note that it only ever rewrote headers. It never touched the TLS handshake, so anything that was blocking you on JA3 or JA4 was never something it could fix.

## Use sessions

A session keeps the connection pool and the TLS session cache alive across requests. Standalone `fetch()` opens a new connection every call, so you pay a full TLS handshake each time: roughly 53 ms against a typical host versus 15 ms on a session. Cookies persist too. Use a session for anything past a single request.

```ts
import { createSession } from 'wreq-js';

const session = await createSession({ browser: 'chrome_149', os: 'windows' });

try {
  await session.fetch('https://example.com/login', {
    method: 'POST',
    body: new URLSearchParams({ user: 'name', pass: 'secret' }),
  });

  const profile = await session.fetch('https://example.com/profile');
  console.log(await profile.json());
} finally {
  await session.close();
}
```

`withSession` does the cleanup for you:

```ts
import { withSession } from 'wreq-js';

const data = await withSession(async (session) => {
  const res = await session.fetch('https://example.com/api');
  return res.json();
}, { browser: 'chrome_149' });
```

If you want pooled connections without a shared cookie jar, use a transport instead:

```ts
import { createTransport, fetch } from 'wreq-js';

const transport = await createTransport({
  browser: 'chrome_149',
  proxy: 'http://user:pass@proxy.example.com:8080',
  poolMaxIdlePerHost: 8,
});

const res = await fetch('https://example.com', { transport });
```

## Proxies

Pass a proxy per request, or set one on the session or transport so it applies to everything.

```ts
const res = await fetch('https://example.com', {
  browser: 'chrome_149',
  proxy: 'http://user:pass@proxy.example.com:8080',
});
```

`socks5://` and `socks5h://` work as well. Inside a session the `proxy` field is session-scoped, so to override it for one call, pass a `transport` on that specific `session.fetch(...)`.

## Streaming

Response bodies stream, so you can process large downloads without buffering them.

```ts
const res = await fetch('https://example.com/large.json', { browser: 'chrome_149' });

for await (const chunk of res.body) {
  process.stdout.write(`got ${chunk.length} bytes\n`);
}
```

Set `compress: false` if you want the raw compressed bytes and the `Content-Encoding` header left intact, which is what you want when you are proxying the response onward.

## WebSockets

One await gets you a connected socket:

```ts
import { websocket } from 'wreq-js';

const ws = await websocket('wss://example.com/ws', {
  browser: 'chrome_149',
  headers: { Authorization: 'Bearer token' },
});

ws.onmessage = (event) => console.log(event.data);
ws.send('hello');
ws.close(1000, 'done');
```

Or use the constructor if you want browser-like `CONNECTING` behaviour:

```ts
import { WebSocket } from 'wreq-js';

const ws = new WebSocket('wss://example.com/ws', { browser: 'chrome_149' });
ws.onopen = () => ws.send('connected');
```

`session.websocket(...)` reuses the cookies and transport settings from the session's HTTP calls, which is what you usually want after logging in.

## Custom emulation

When a preset gets you close but a specific target is still picky, layer overrides on top of it. Anything you do not specify keeps the profile's value.

```ts
const res = await fetch('https://example.com', {
  browser: 'chrome_149',
  emulation: {
    http2Options: {
      headerTableSize: 65536,
      initialWindowSize: 6291456,
      headersPseudoOrder: ['Method', 'Authority', 'Scheme', 'Path'],
    },
  },
});
```

Header order and casing are preserved when you pass tuples, which matters for HTTP/1 against WAFs that check it:

```ts
await fetch('https://example.com', {
  headers: [
    ['Accept', 'text/html'],
    ['X-Request-Id', 'abc'],
  ],
});
```

The full surface, including cipher lists, curves, ALPN, ALPS, GREASE and certificate compression, is documented in the [custom emulation guide](https://wreq.sqdsh.win).


## FAQ

**How do I see what fingerprint I am actually sending?**

```ts
const r = await fetch('https://tls.peet.ws/api/all', { browser: 'chrome_149' });
const d = await r.json();

console.log(d.tls.ja4, d.http2.akamai_fingerprint);
```

Chrome should come back as `t13d1516h2_8daaf6152771_d8a2da3f94cd` and `1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p`. Node's built-in `fetch` reports `t13d5212h1_...` for comparison, which is 52 ciphers over HTTP/1.1 and matches no browser that has ever shipped.

**Why am I still blocked?**
Check the fingerprint first with the snippet above. If it matches and you are still blocked, the target is almost certainly gating on something above the transport layer. Worth knowing: matching a browser is not always what a site rewards. Some targets block a well-formed Chrome fingerprint while happily serving plain undici, presumably because a browser with no cookie history looks stranger than an obvious script. Test your actual target rather than assuming.

**Why does install sometimes compile from source?**
Because there is no prebuilt binary matching your platform and libc. You need a Rust toolchain for that path. Open an issue if your platform should be covered and is not.

**Can I override the proxy for one request inside a session?**
Yes, pass a `transport` on that specific `session.fetch(...)` call. The session's own `proxy` field stays session-scoped.

**Do I need to close sessions?**
Close them when you are done if the process is long-lived. Pooled resources are released on garbage collection too, but explicit is better.

**Which profile should I pick?**
Default to a recent Chrome on the OS you are claiming in your headers. Pick `os` to match, since a Chrome-on-Windows TLS fingerprint paired with a macOS `sec-ch-ua-platform` header is its own tell.

## Documentation

Full guides and API reference: [wreq.sqdsh.win](https://wreq.sqdsh.win)

- [Quickstart](https://wreq.sqdsh.win/quickstart)
- [API reference](https://wreq.sqdsh.win/api-reference/overview)
- [Sessions](https://wreq.sqdsh.win/concepts/sessions)
- [Browser profiles](https://wreq.sqdsh.win/concepts/browser-profiles)
- [WebSockets](https://wreq.sqdsh.win/guides/websockets)
- [Compatibility matrix](https://wreq.sqdsh.win/concepts/compatibility-matrix)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports that include the target, the profile you used, and the fingerprint output from the [FAQ](#faq) snippet are the most useful kind.

## Acknowledgments

Originally forked from [node-wreq](https://github.com/will-work-for-meal/node-wreq), since diverged with its own build matrix, session and transport model, and release cadence.

- [wreq](https://github.com/0x676e67/wreq), the Rust HTTP client this is built on
- [wreq-util](https://github.com/0x676e67/wreq-util), which maintains the emulation profiles
- [NAPI-RS](https://napi.rs/) for the Rust and Node bindings

## License

MIT
