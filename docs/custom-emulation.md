# Custom Emulation API

## Overview

wreq-js ships with built-in browser profiles that replicate the TLS, HTTP/2, and header fingerprints of real browsers. The custom emulation API lets you go beyond those presets in three ways:

| Mode | When it activates | What happens |
|---|---|---|
| **Preset only** | `browser` and/or `os` is set, no `emulation` | The built-in profile for that browser+OS pair is used as-is. |
| **Preset + overlay** | `browser` and/or `os` is set **and** `emulation` is provided | The built-in profile is resolved first, then every field in `emulation` is layered on top. Headers are merged (matching names replaced, new names appended). TLS/HTTP options are fully replaced at the sub-object level. |
| **Standalone custom** | Neither `browser` nor `os` is set, only `emulation` | No preset is loaded. You supply the entire fingerprint yourself. At least one of `tlsOptions`, `http1Options`, `http2Options`, `headers`, or `origHeaders` must be present. |

The `emulation` option is accepted by `fetch()`, `createSession()`, `createTransport()`, and `websocket()`.

---

## Usage Examples

### Preset only (browser + OS)

```typescript
import { fetch } from "wreq-js";

const response = await fetch("https://example.com", {
  browser: "chrome_145",
  os: "windows",
});
```

### Preset + overlay

Start from a real browser profile, then override specific TLS or HTTP/2 settings, or add extra headers:

```typescript
import { fetch, createSession, createTransport } from "wreq-js";

// With fetch()
const response = await fetch("https://example.com", {
  browser: "chrome_145",
  os: "macos",
  emulation: {
    tlsOptions: {
      permuteExtensions: false,  // disable random extension shuffling
    },
    headers: {
      "X-Custom": "overlay-value",
    },
  },
});

// With createSession()
const session = createSession({
  browser: "firefox_146",
  os: "linux",
  emulation: {
    http2Options: {
      initialWindowSize: 131072,
    },
  },
});

// With createTransport()
const transport = createTransport({
  browser: "chrome_145",
  emulation: {
    tlsOptions: {
      sessionTicket: false,
    },
  },
});

const response2 = await fetch("https://example.com", { transport });
```

### Standalone custom (emulation only)

No browser or OS is set. You control the entire fingerprint:

```typescript
import { fetch, createSession, createTransport } from "wreq-js";

// With fetch()
const response = await fetch("https://example.com", {
  emulation: {
    tlsOptions: {
      alpnProtocols: ["HTTP2"],
      minTlsVersion: "1.2",
      sessionTicket: true,
    },
    http2Options: {
      initialWindowSize: 65535,
      headersPseudoOrder: ["Method", "Authority", "Scheme", "Path"],
    },
    headers: {
      "User-Agent": "MyCustomAgent/1.0",
      "Accept": "text/html",
    },
    origHeaders: ["User-Agent", "Accept"],
  },
});

// With createSession()
const session = createSession({
  emulation: {
    headers: {
      "User-Agent": "Standalone Agent/1.0",
    },
  },
});

// With createTransport()
const transport = createTransport({
  emulation: {
    tlsOptions: {
      alpnProtocols: ["HTTP2"],
      cipherList: "TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384",
    },
    http2Options: {
      settingsOrder: ["HeaderTableSize", "EnablePush", "InitialWindowSize", "MaxFrameSize"],
    },
  },
});
```

---

## Full API Reference

### `CustomEmulationOptions`

Top-level emulation configuration passed via the `emulation` field.

| Field | Type | Description |
|---|---|---|
| `tlsOptions` | `CustomTlsOptions` | TLS fingerprint configuration. |
| `http1Options` | `CustomHttp1Options` | HTTP/1.1 client tuning. |
| `http2Options` | `CustomHttp2Options` | HTTP/2 framing, settings, and priority configuration. |
| `headers` | `HeadersInit` | Default headers for this emulation. In preset+overlay mode, matching header names in the preset are replaced; new names are appended. In standalone mode, these are the only default headers. |
| `origHeaders` | `string[]` | Controls the wire-order and original casing of header names. Each entry is a header name with the exact casing you want on the wire. Entries are deduplicated case-insensitively; duplicates are rejected. |

---

### `CustomTlsOptions`

All 26 fields that control the TLS ClientHello fingerprint.

| Field | Type | Description |
|---|---|---|
| `alpnProtocols` | `AlpnProtocol[]` | ALPN protocol list advertised in the ClientHello. Values: `"HTTP1"`, `"HTTP2"`, `"HTTP3"`. |
| `alpsProtocols` | `AlpsProtocol[]` | ALPS (Application-Layer Protocol Settings) protocol list. Values: `"HTTP1"`, `"HTTP2"`, `"HTTP3"`. |
| `alpsUseNewCodepoint` | `boolean` | Use the new ALPS codepoint (required for modern Chrome profiles). |
| `sessionTicket` | `boolean` | Enable TLS session ticket support. |
| `minTlsVersion` | `TlsVersion` | Minimum TLS version. Accepts `"1.0"`, `"1.1"`, `"1.2"`, `"1.3"` (and prefixed forms like `"TLS1.2"`). |
| `maxTlsVersion` | `TlsVersion` | Maximum TLS version. Same format as `minTlsVersion`. |
| `preSharedKey` | `boolean` | Enable TLS pre-shared key extension. |
| `enableEchGrease` | `boolean` | Enable ECH (Encrypted Client Hello) GREASE. |
| `permuteExtensions` | `boolean` | Randomly shuffle TLS extensions on each connection. This is what Chrome does natively, causing JA3 to vary per request while JA4 remains stable (JA4 sorts extensions before hashing). |
| `greaseEnabled` | `boolean` | Enable GREASE values in the ClientHello (cipher suites, extensions, etc.). |
| `enableOcspStapling` | `boolean` | Advertise OCSP stapling support. |
| `enableSignedCertTimestamps` | `boolean` | Advertise SCT (Signed Certificate Timestamps) support. |
| `recordSizeLimit` | `number` | TLS record size limit extension value. Integer in range 0--65535. |
| `pskSkipSessionTicket` | `boolean` | Skip session ticket when using PSK. |
| `keySharesLimit` | `number` | Maximum number of key shares to send. Integer in range 0--255. |
| `pskDheKe` | `boolean` | Enable PSK with (EC)DHE key exchange mode. |
| `renegotiation` | `boolean` | Enable TLS renegotiation support. |
| `delegatedCredentials` | `string` | Delegated credentials signature algorithms string (e.g., `"ecdsa_secp256r1_sha256,ecdsa_secp384r1_sha384,ecdsa_secp521r1_sha512,ecdsa_sha1"`). Used by Firefox. |
| `curvesList` | `string` | Colon-separated list of supported elliptic curves / named groups (e.g., `"X25519MLKEM768:X25519:P-256:P-384"`). The name `X25519MLKEM768` maps to wire ID 4588. |
| `cipherList` | `string` | OpenSSL-style cipher suite string (e.g., `"TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256"`). |
| `sigalgsList` | `string` | Colon-separated list of signature algorithms (e.g., `"ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256"`). |
| `certificateCompressionAlgorithms` | `Array<"zlib" \| "brotli" \| "zstd">` | Certificate compression algorithms to advertise. Duplicates are rejected. |
| `extensionPermutation` | `number[]` | Fixed ordering of TLS extension type IDs. Each entry is an extension type ID (0--65535). Unlike `permuteExtensions` (random), this sets a deterministic order. Duplicates are rejected. |
| `aesHwOverride` | `boolean` | Override AES hardware acceleration detection. When `false`, the cipher list is reordered as if AES-NI is unavailable (ChaCha20 preferred). |
| `preserveTls13CipherList` | `boolean` | When `true`, the TLS 1.3 cipher order from `cipherList` is preserved exactly as specified rather than being reordered by the library. |
| `randomAesHwOverride` | `boolean` | Randomly decide whether to emulate AES hardware support on each connection. |

---

### `CustomHttp1Options`

All 8 fields for HTTP/1.1 client configuration.

| Field | Type | Description |
|---|---|---|
| `http09Responses` | `boolean` | Accept HTTP/0.9 responses. |
| `writev` | `boolean` | Use vectored writes for HTTP/1.1 requests. |
| `maxHeaders` | `number` | Maximum number of headers to accept in a response. Non-negative integer. |
| `readBufExactSize` | `number` | Exact read buffer size. Non-negative integer. **Cannot be set together with `maxBufSize`.** |
| `maxBufSize` | `number` | Maximum read buffer size. Must be at least 8192. **Cannot be set together with `readBufExactSize`.** |
| `ignoreInvalidHeadersInResponses` | `boolean` | Silently ignore invalid headers in responses instead of erroring. |
| `allowSpacesAfterHeaderNameInResponses` | `boolean` | Allow spaces after the header name (before the colon) in responses. |
| `allowObsoleteMultilineHeadersInResponses` | `boolean` | Allow obsolete multi-line (folded) headers in responses. |

---

### `CustomHttp2Options`

All 23 fields for HTTP/2 framing and settings configuration.

| Field | Type | Description |
|---|---|---|
| `adaptiveWindow` | `boolean` | Enable adaptive flow control window sizing. |
| `initialStreamId` | `number` | First stream ID to use (e.g., `1` or `3`). |
| `initialConnectionWindowSize` | `number` | Initial connection-level flow control window size. See the [WINDOW_UPDATE mapping](#how-initialconnectionwindowsize-maps-to-window_update) section for details on how this translates to the wire. |
| `initialWindowSize` | `number` | Initial stream-level flow control window size. Sent in the SETTINGS frame as `SETTINGS_INITIAL_WINDOW_SIZE`. |
| `initialMaxSendStreams` | `number` | Maximum number of concurrent streams the client will initiate. |
| `maxFrameSize` | `number` | Maximum HTTP/2 frame size. Sent in the SETTINGS frame as `SETTINGS_MAX_FRAME_SIZE`. |
| `keepAliveInterval` | `number` | Interval between HTTP/2 PING frames in milliseconds. |
| `keepAliveTimeout` | `number` | Timeout for HTTP/2 PING acknowledgements in milliseconds. |
| `keepAliveWhileIdle` | `boolean` | Send keep-alive PINGs even when no streams are active. |
| `maxConcurrentResetStreams` | `number` | Maximum number of locally reset streams tracked at once. |
| `maxSendBufferSize` | `number` | Maximum size of the send buffer per stream. |
| `maxConcurrentStreams` | `number` | `SETTINGS_MAX_CONCURRENT_STREAMS` value to send. |
| `maxHeaderListSize` | `number` | `SETTINGS_MAX_HEADER_LIST_SIZE` value to send. |
| `maxPendingAcceptResetStreams` | `number` | Maximum number of pending accept-reset streams. |
| `enablePush` | `boolean` | `SETTINGS_ENABLE_PUSH` value (usually `false` for clients). |
| `headerTableSize` | `number` | `SETTINGS_HEADER_TABLE_SIZE` value for HPACK. |
| `enableConnectProtocol` | `boolean` | `SETTINGS_ENABLE_CONNECT_PROTOCOL` (RFC 8441). |
| `noRfc7540Priorities` | `boolean` | Disable RFC 7540 stream priorities. Chrome sets this to `true` since it uses RFC 9218 extensible priorities. |
| `settingsOrder` | `Http2SettingId[]` | Explicit ordering of settings in the SETTINGS frame. Each entry appears at most once. See [Http2SettingId](#http2settingid). |
| `headersPseudoOrder` | `Http2PseudoHeaderId[]` | Ordering of HTTP/2 pseudo-headers (`:method`, `:scheme`, etc.) in HEADERS frames. See [Http2PseudoHeaderId](#http2pseudoheaderid). |
| `headersStreamDependency` | `Http2StreamDependency` | Stream dependency for HEADERS frames (RFC 7540 priority). |
| `priorities` | `Http2Priority[]` | Explicit PRIORITY frames to send after connection setup. Each `streamId` must be unique and greater than 0. |
| `experimentalSettings` | `Http2ExperimentalSetting[]` | Non-standard SETTINGS entries. Each `id` must be in range 1--15 and must NOT be a standard HTTP/2 setting ID. Duplicates are rejected. |

---

### Supporting Types

#### `Http2StreamDependency`

```typescript
interface Http2StreamDependency {
  dependencyId: number;  // Stream ID this stream depends on (0 = root)
  weight: number;        // Priority weight (1-256 on wire, 0-255 in this API)
  exclusive?: boolean;   // Exclusive dependency flag (default: false)
}
```

#### `Http2Priority`

```typescript
interface Http2Priority {
  streamId: number;               // Stream ID to set priority for (must be > 0, must be unique)
  dependency: Http2StreamDependency;  // Dependency and weight for this stream
}
```

#### `Http2ExperimentalSetting`

```typescript
interface Http2ExperimentalSetting {
  id: number;     // Setting ID (1-15, must NOT be a standard HTTP/2 setting)
  value: number;  // Setting value (unsigned 32-bit integer)
}
```

Standard setting IDs that are **not allowed** in `experimentalSettings`: 1 (`HeaderTableSize`), 2 (`EnablePush`), 3 (`MaxConcurrentStreams`), 4 (`InitialWindowSize`), 5 (`MaxFrameSize`), 6 (`MaxHeaderListSize`), 8 (`EnableConnectProtocol`), 9 (`NoRfc7540Priorities`).

#### `Http2SettingId`

Union of valid setting identifiers for `settingsOrder`:

```typescript
type Http2SettingId =
  | "HeaderTableSize"
  | "EnablePush"
  | "MaxConcurrentStreams"
  | "InitialWindowSize"
  | "MaxFrameSize"
  | "MaxHeaderListSize"
  | "EnableConnectProtocol"
  | "NoRfc7540Priorities";
```

#### `Http2PseudoHeaderId`

Union of HTTP/2 pseudo-header identifiers for `headersPseudoOrder`:

```typescript
type Http2PseudoHeaderId =
  | "Method"      // :method
  | "Scheme"      // :scheme
  | "Authority"   // :authority
  | "Path"        // :path
  | "Protocol";   // :protocol (RFC 8441)
```

#### `TlsVersion`

```typescript
type TlsVersion = "1.0" | "1.1" | "1.2" | "1.3" | "TLS1.0" | "TLS1.1" | "TLS1.2" | "TLS1.3";
```

Both short and prefixed forms are accepted and normalized internally (e.g., `"TLS1.2"` and `"1.2"` are equivalent).

#### `AlpnProtocol`

```typescript
type AlpnProtocol = "HTTP1" | "HTTP2" | "HTTP3";
```

#### `AlpsProtocol`

```typescript
type AlpsProtocol = "HTTP1" | "HTTP2" | "HTTP3";
```

---

## Real Browser Replication Guide

### Chrome 145

Chrome 145 uses permuted TLS extensions, ALPS with the new codepoint, ECH GREASE, and the post-quantum `X25519MLKEM768` key exchange. It disables RFC 7540 priorities in favor of RFC 9218.

```typescript
import { fetch } from "wreq-js";

const response = await fetch("https://example.com", {
  emulation: {
    tlsOptions: {
      alpnProtocols: ["HTTP2", "HTTP1"],
      alpsProtocols: ["HTTP2"],
      alpsUseNewCodepoint: true,
      sessionTicket: true,
      minTlsVersion: "1.2",
      maxTlsVersion: "1.3",
      preSharedKey: true,
      enableEchGrease: true,
      permuteExtensions: true,
      greaseEnabled: true,
      enableOcspStapling: true,
      enableSignedCertTimestamps: true,
      pskSkipSessionTicket: true,
      keySharesLimit: 2,
      pskDheKe: true,
      curvesList: "X25519MLKEM768:X25519:P-256:P-384",
      cipherList:
        "TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-RSA-AES128-SHA:ECDHE-RSA-AES256-SHA:AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA",
      sigalgsList:
        "ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512",
      certificateCompressionAlgorithms: ["brotli"],
    },
    http2Options: {
      headerTableSize: 65536,
      initialWindowSize: 6291456,
      maxHeaderListSize: 262144,
      initialConnectionWindowSize: 15728640,
      enablePush: false,
      noRfc7540Priorities: true,
      settingsOrder: [
        "HeaderTableSize",
        "EnablePush",
        "InitialWindowSize",
        "MaxHeaderListSize",
        "NoRfc7540Priorities",
      ],
      headersPseudoOrder: ["Method", "Authority", "Scheme", "Path"],
    },
    headers: [
      ["sec-ch-ua", '"Chromium";v="145", "Google Chrome";v="145", "Not:A-Brand";v="24"'],
      ["sec-ch-ua-mobile", "?0"],
      ["sec-ch-ua-platform", '"macOS"'],
      ["upgrade-insecure-requests", "1"],
      [
        "user-agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      ],
      [
        "accept",
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      ],
      ["sec-fetch-site", "none"],
      ["sec-fetch-mode", "navigate"],
      ["sec-fetch-user", "?1"],
      ["sec-fetch-dest", "document"],
      ["accept-encoding", "gzip, deflate, br, zstd"],
      ["accept-language", "en-US,en;q=0.9"],
    ],
    origHeaders: [
      "sec-ch-ua",
      "sec-ch-ua-mobile",
      "sec-ch-ua-platform",
      "Upgrade-Insecure-Requests",
      "User-Agent",
      "Accept",
      "Sec-Fetch-Site",
      "Sec-Fetch-Mode",
      "Sec-Fetch-User",
      "Sec-Fetch-Dest",
      "Accept-Encoding",
      "Accept-Language",
    ],
  },
});
```

**Verified fingerprints:**

| Fingerprint | Value |
|---|---|
| JA3 | Varies per request (due to `permuteExtensions: true`) |
| JA4 | `t13d1517h2_8daaf6152771_02713d6af862` (stable, because JA4 sorts extensions) |
| Akamai | `1:65536,2:0,4:6291456,6:262144,9:1\|15663105\|0\|m,a,s,p` |

### Firefox 146

Firefox 146 uses a fixed extension permutation (deterministic order), delegated credentials, and keeps RFC 7540 priorities enabled. It advertises `zlib` for certificate compression alongside `brotli`.

```typescript
import { fetch } from "wreq-js";

const response = await fetch("https://example.com", {
  emulation: {
    tlsOptions: {
      alpnProtocols: ["HTTP2", "HTTP1"],
      sessionTicket: true,
      minTlsVersion: "1.2",
      maxTlsVersion: "1.3",
      preSharedKey: true,
      enableEchGrease: true,
      greaseEnabled: false,
      enableOcspStapling: true,
      enableSignedCertTimestamps: true,
      pskSkipSessionTicket: false,
      pskDheKe: true,
      renegotiation: true,
      delegatedCredentials:
        "ecdsa_secp256r1_sha256,ecdsa_secp384r1_sha384,ecdsa_secp521r1_sha512,ecdsa_sha1",
      curvesList: "X25519MLKEM768:X25519:P-256:P-384:P-521",
      cipherList:
        "TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_256_GCM_SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-SHA:ECDHE-ECDSA-AES128-SHA:ECDHE-RSA-AES128-SHA:ECDHE-RSA-AES256-SHA:AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA",
      sigalgsList:
        "ecdsa_secp256r1_sha256:ecdsa_secp384r1_sha384:ecdsa_secp521r1_sha512:rsa_pss_rsae_sha256:rsa_pss_rsae_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha256:rsa_pkcs1_sha384:rsa_pkcs1_sha512:ecdsa_sha1:rsa_pkcs1_sha1",
      certificateCompressionAlgorithms: ["zlib", "brotli", "zstd"],
      recordSizeLimit: 16385,
      extensionPermutation: [
        28, 27, 43, 0, 65281, 10, 35, 16, 5, 51, 13, 11, 45, 23, 65037, 17513, 18, 41,
      ],
    },
    http2Options: {
      headerTableSize: 65536,
      initialWindowSize: 131072,
      maxFrameSize: 16384,
      initialConnectionWindowSize: 12517377,
      settingsOrder: [
        "HeaderTableSize",
        "InitialWindowSize",
        "MaxFrameSize",
      ],
      headersPseudoOrder: ["Method", "Path", "Authority", "Scheme"],
      headersStreamDependency: {
        dependencyId: 13,
        weight: 41,
        exclusive: false,
      },
      priorities: [
        { streamId: 3, dependency: { dependencyId: 0, weight: 200, exclusive: false } },
        { streamId: 5, dependency: { dependencyId: 0, weight: 100, exclusive: false } },
        { streamId: 7, dependency: { dependencyId: 0, weight: 0, exclusive: false } },
        { streamId: 9, dependency: { dependencyId: 7, weight: 0, exclusive: false } },
        { streamId: 11, dependency: { dependencyId: 3, weight: 0, exclusive: false } },
        { streamId: 13, dependency: { dependencyId: 0, weight: 240, exclusive: false } },
      ],
    },
    headers: [
      [
        "user-agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:146.0) Gecko/20100101 Firefox/146.0",
      ],
      [
        "accept",
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      ],
      ["accept-language", "en-US,en;q=0.5"],
      ["accept-encoding", "gzip, deflate, br, zstd"],
      ["upgrade-insecure-requests", "1"],
      ["sec-fetch-dest", "document"],
      ["sec-fetch-mode", "navigate"],
      ["sec-fetch-site", "none"],
      ["sec-fetch-user", "?1"],
      ["te", "trailers"],
      ["priority", "u=0, i"],
    ],
    origHeaders: [
      "User-Agent",
      "Accept",
      "Accept-Language",
      "Accept-Encoding",
      "Upgrade-Insecure-Requests",
      "Sec-Fetch-Dest",
      "Sec-Fetch-Mode",
      "Sec-Fetch-Site",
      "Sec-Fetch-User",
      "TE",
      "Priority",
    ],
  },
});
```

**Verified fingerprints:**

| Fingerprint | Value |
|---|---|
| JA3 | `456523fc94726331a8a66098277ba328` (stable, because `extensionPermutation` is fixed) |
| JA4 | `t13d1715h2_5b57614c22b0_3d5424432f57` |
| Akamai | `1:65536,4:131072,5:16384\|12451842\|3:0:0:200,5:0:0:100,7:0:0:0,9:7:0:0,11:3:0:0,13:0:0:240\|m,p,a,s` |

---

## Key Concepts

### `extensionPermutation` vs `permuteExtensions`

These two TLS options both control the ordering of TLS extensions in the ClientHello, but they work differently:

- **`permuteExtensions: true`** -- Randomly shuffles the TLS extensions on every new connection. This is what real Chrome does starting from Chrome 110+. The order changes each time, so any fingerprint based on raw extension order (like JA3) will vary per connection.

- **`extensionPermutation: [28, 27, 43, ...]`** -- Sets a fixed, deterministic ordering of extensions by their TLS extension type IDs. The array specifies exactly which order the extensions should appear in. This is how Firefox-like behavior is replicated, where the extension order is non-standard but consistent.

You should use one or the other, not both. If you need a stable fingerprint with a specific extension order, use `extensionPermutation`. If you want to mimic Chrome's randomization, use `permuteExtensions: true`.

### How `initialConnectionWindowSize` maps to WINDOW_UPDATE

HTTP/2 connections start with a default connection-level flow control window of 65,535 bytes (per RFC 9113). To increase the window, the client sends a `WINDOW_UPDATE` frame immediately after the connection preface.

The `initialConnectionWindowSize` value you set is the **target window size**. The library sends a `WINDOW_UPDATE` increment of `target - 65535` on the wire. For example:

| `initialConnectionWindowSize` | WINDOW_UPDATE increment |
|---|---|
| 15,728,640 (Chrome) | 15,663,105 |
| 12,517,377 (Firefox) | 12,451,842 |

This is why Akamai fingerprints show the increment (e.g., `15663105`), not the configured value.

### How `headersPseudoOrder` controls HTTP/2 pseudo-header ordering

HTTP/2 requests begin with pseudo-headers (`:method`, `:scheme`, `:authority`, `:path`). The order of these pseudo-headers in the HEADERS frame is part of the browser fingerprint:

- **Chrome**: `["Method", "Authority", "Scheme", "Path"]` -- produces `:method, :authority, :scheme, :path`
- **Firefox**: `["Method", "Path", "Authority", "Scheme"]` -- produces `:method, :path, :authority, :scheme`

This ordering appears in the Akamai fingerprint as the last section (e.g., `m,a,s,p` for Chrome, `m,p,a,s` for Firefox).

### How `settingsOrder` controls the HTTP/2 SETTINGS frame

The `settingsOrder` array dictates the exact order of parameters in the initial SETTINGS frame. Different browsers emit settings in different orders, and this order is fingerprinted by tools like Akamai.

Chrome typically sends: `HeaderTableSize, EnablePush, InitialWindowSize, MaxHeaderListSize, NoRfc7540Priorities`

Firefox typically sends: `HeaderTableSize, InitialWindowSize, MaxFrameSize`

### How `preserveTls13CipherList` affects cipher ordering

By default, the library may reorder TLS 1.3 cipher suites internally. When `preserveTls13CipherList` is set to `true`, the exact order specified in `cipherList` is preserved for TLS 1.3 ciphers. This is important for fingerprint accuracy because the cipher order is part of the JA3/JA4 hash.

### How headers overlay works in preset+overlay mode

When `browser` or `os` is set alongside `emulation.headers`, the overlay follows a replace-then-append strategy:

1. The preset profile's full header map is loaded first.
2. For each header name in your `emulation.headers`:
   - If that name already exists in the preset, **all existing values for that name are removed**, then your new value is appended.
   - If the name does not exist in the preset, your value is **appended** to the end.
3. This means you can override specific preset headers (like `User-Agent`) without losing the rest.

The same merge logic applies to `origHeaders` in overlay mode: your entries are appended to the preset's existing `origHeaders` list.

### How `origHeaders` controls header name ordering

The `origHeaders` array serves two purposes:

1. **Wire-order casing**: Each string preserves the exact casing you want on the wire (e.g., `"User-Agent"` instead of the normalized `"user-agent"`).
2. **Header ordering**: The position of each entry in the array determines the order headers appear in the HTTP request. Headers listed earlier appear first on the wire.

Entries are deduplicated case-insensitively. Providing `["X-Test", "x-test"]` will be rejected as a duplicate.

### The curve name mapping (X25519MLKEM768)

The `curvesList` string accepts human-readable curve names. The name `X25519MLKEM768` refers to the post-quantum hybrid key exchange that combines X25519 with ML-KEM-768. This maps to **wire ID 4588** (`0x11EC`) in the TLS `supported_groups` extension. Both Chrome and Firefox have adopted this curve in recent versions.

Other commonly used names and their wire IDs:

| Name | Wire ID |
|---|---|
| `X25519` | 29 |
| `P-256` | 23 |
| `P-384` | 24 |
| `P-521` | 25 |
| `X25519MLKEM768` | 4588 |

### Why Chrome JA3 varies but JA4 stays stable

Chrome 110+ enables `permuteExtensions` by default, which randomly shuffles TLS extensions on every connection. This directly affects **JA3** because JA3 hashes the extensions in their wire order, producing a different hash each time.

**JA4**, however, sorts extensions numerically before hashing, so the randomized order does not affect the output. This makes JA4 a more reliable fingerprint for identifying Chrome, since it produces the same hash regardless of extension permutation.

If you are using `permuteExtensions: true` in your custom emulation:
- Expect JA3 to change on every connection (this is correct Chrome behavior).
- Expect JA4 to remain constant across connections.
- If you need a fixed JA3, use `extensionPermutation` with a specific order instead.
