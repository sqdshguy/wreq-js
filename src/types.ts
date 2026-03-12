// Import and re-export the auto-generated BrowserProfile and EmulationOS types
import type { BrowserProfile, EmulationOS } from "./generated-types.js";
import type { Session, Transport, WebSocket } from "./wreq-js.js";
export type { BrowserProfile, EmulationOS };

/**
 * Controls how cookies are scoped for a request.
 * - "session": reuse an explicit Session or sessionId across calls.
 * - "ephemeral": create an isolated, single-use session.
 */
export type CookieMode = "session" | "ephemeral";

/**
 * Minimal handle implemented by {@link Session}. Exposed for integrations
 * that only need to carry a session id.
 */
export interface SessionHandle {
  readonly id: string;
}

/**
 * A tuple of [name, value] pairs used for initializing headers.
 * Both name and value must be strings.
 *
 * @example
 * ```typescript
 * const headers: HeaderTuple = ['Content-Type', 'application/json'];
 * ```
 */
export type HeaderTuple = [string, string];

/**
 * Represents various input types accepted when creating or initializing headers.
 * Can be an iterable of header tuples, an array of tuples, or a plain object.
 *
 * @example
 * ```typescript
 * // As an object
 * const headers: HeadersInit = { 'Content-Type': 'application/json' };
 *
 * // As an array of tuples
 * const headers: HeadersInit = [['Content-Type', 'application/json']];
 *
 * // As an iterable
 * const headers: HeadersInit = new Map([['Content-Type', 'application/json']]);
 * ```
 */
export type HeadersInit =
  | Iterable<HeaderTuple>
  | Array<HeaderTuple>
  | Record<string, string | number | boolean | null | undefined>;

export type AlpnProtocol = "HTTP1" | "HTTP2" | "HTTP3";

export type AlpsProtocol = "HTTP1" | "HTTP2" | "HTTP3";

export type TlsVersion = "1.0" | "1.1" | "1.2" | "1.3" | "TLS1.0" | "TLS1.1" | "TLS1.2" | "TLS1.3";

export type Http2PseudoHeaderId = "Method" | "Scheme" | "Authority" | "Path" | "Protocol";

export type Http2SettingId =
  | "HeaderTableSize"
  | "EnablePush"
  | "MaxConcurrentStreams"
  | "InitialWindowSize"
  | "MaxFrameSize"
  | "MaxHeaderListSize"
  | "EnableConnectProtocol"
  | "NoRfc7540Priorities";

export interface Http2StreamDependency {
  dependencyId: number;
  weight: number;
  exclusive?: boolean;
}

export interface Http2Priority {
  streamId: number;
  dependency: Http2StreamDependency;
}

export interface Http2ExperimentalSetting {
  id: number;
  value: number;
}

export interface CustomTlsOptions {
  alpnProtocols?: AlpnProtocol[];
  alpsProtocols?: AlpsProtocol[];
  alpsUseNewCodepoint?: boolean;
  sessionTicket?: boolean;
  minTlsVersion?: TlsVersion;
  maxTlsVersion?: TlsVersion;
  preSharedKey?: boolean;
  enableEchGrease?: boolean;
  permuteExtensions?: boolean;
  greaseEnabled?: boolean;
  enableOcspStapling?: boolean;
  enableSignedCertTimestamps?: boolean;
  recordSizeLimit?: number;
  pskSkipSessionTicket?: boolean;
  keySharesLimit?: number;
  pskDheKe?: boolean;
  renegotiation?: boolean;
  delegatedCredentials?: string;
  curvesList?: string;
  cipherList?: string;
  sigalgsList?: string;
  certificateCompressionAlgorithms?: Array<"zlib" | "brotli" | "zstd">;
  extensionPermutation?: number[];
  aesHwOverride?: boolean;
  preserveTls13CipherList?: boolean;
  randomAesHwOverride?: boolean;
}

export interface CustomHttp1Options {
  http09Responses?: boolean;
  writev?: boolean;
  maxHeaders?: number;
  readBufExactSize?: number;
  maxBufSize?: number;
  ignoreInvalidHeadersInResponses?: boolean;
  allowSpacesAfterHeaderNameInResponses?: boolean;
  allowObsoleteMultilineHeadersInResponses?: boolean;
}

export interface CustomHttp2Options {
  adaptiveWindow?: boolean;
  initialStreamId?: number;
  initialConnectionWindowSize?: number;
  initialWindowSize?: number;
  initialMaxSendStreams?: number;
  maxFrameSize?: number;
  keepAliveInterval?: number;
  keepAliveTimeout?: number;
  keepAliveWhileIdle?: boolean;
  maxConcurrentResetStreams?: number;
  maxSendBufferSize?: number;
  maxConcurrentStreams?: number;
  maxHeaderListSize?: number;
  maxPendingAcceptResetStreams?: number;
  enablePush?: boolean;
  headerTableSize?: number;
  enableConnectProtocol?: boolean;
  noRfc7540Priorities?: boolean;
  settingsOrder?: Http2SettingId[];
  headersPseudoOrder?: Http2PseudoHeaderId[];
  headersStreamDependency?: Http2StreamDependency;
  priorities?: Http2Priority[];
  experimentalSettings?: Http2ExperimentalSetting[];
}

export interface CustomEmulationOptions {
  tlsOptions?: CustomTlsOptions;
  http1Options?: CustomHttp1Options;
  http2Options?: CustomHttp2Options;
  headers?: HeadersInit;
  origHeaders?: string[];
}

/**
 * Represents the various types of data that can be used as a request body.
 * Supports strings, binary payloads, URL-encoded parameters, multipart forms, and blobs.
 *
 * @example
 * ```typescript
 * // String body
 * const body: BodyInit = JSON.stringify({ key: 'value' });
 *
 * // URLSearchParams
 * const body: BodyInit = new URLSearchParams({ key: 'value' });
 *
 * // Buffer
 * const body: BodyInit = Buffer.from('data');
 *
 * // FormData
 * const body: BodyInit = new FormData();
 * ```
 */
export type BodyInit = string | ArrayBuffer | ArrayBufferView | URLSearchParams | Buffer | Blob | FormData;

/**
 * Details about why a WebSocket connection closed.
 */
export type WebSocketBinaryType = "nodebuffer" | "arraybuffer" | "blob";

export type WebSocketEventType = "open" | "message" | "close" | "error";

export interface WebSocketOpenEvent {
  type: "open";
  isTrusted: false;
  timeStamp: number;
  target: WebSocket;
  currentTarget: WebSocket;
}

export interface WebSocketMessageEvent {
  type: "message";
  isTrusted: false;
  timeStamp: number;
  data: string | Buffer | ArrayBuffer | Blob;
  target: WebSocket;
  currentTarget: WebSocket;
}

export interface WebSocketErrorEvent {
  type: "error";
  isTrusted: false;
  timeStamp: number;
  message?: string;
  target: WebSocket;
  currentTarget: WebSocket;
}

export interface WebSocketCloseEvent {
  type: "close";
  isTrusted: false;
  timeStamp: number;

  /**
   * WebSocket close status code (RFC 6455).
   */
  code: number;

  /**
   * UTF-8 close reason sent by the peer.
   */
  reason: string;

  wasClean: boolean;
  target: WebSocket;
  currentTarget: WebSocket;
}

/**
 * Options for configuring a fetch style request with wreq-specific extensions
 * for browser impersonation, proxies, sessions, and timeouts.
 *
 * @example
 * ```typescript
 * const options: RequestInit = {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ key: 'value' }),
 *   browser: 'chrome_142',
 *   proxy: 'http://proxy.example.com:8080',
 *   timeout: 5000
 * };
 * ```
 */
export interface RequestInit {
  /**
   * A string to set request's method.
   * @default 'GET'
   */
  method?: string;

  /**
   * A Headers object, an object literal, or an array of two-item arrays to set request's headers.
   */
  headers?: HeadersInit;

  /**
   * A BodyInit object or null to set request's body.
   */
  body?: BodyInit | null;

  /**
   * An AbortSignal to set request's signal.
   */
  signal?: AbortSignal | null;

  /**
   * A string indicating whether request follows redirects, results in an error upon
   * encountering a redirect, or returns the redirect (in an opaque fashion).
   * @default 'follow'
   */
  redirect?: "follow" | "manual" | "error";

  /**
   * Transport instance to use for this request. When provided, transport-level
   * options such as `browser`, `os`, `proxy`, and `insecure` must not be set.
   */
  transport?: Transport;

  /**
   * Browser profile to impersonate for this request.
   * Applies browser profile behavior handled by the native layer.
   * Ignored when `transport` is provided.
   * @default 'chrome_142'
   */
  browser?: BrowserProfile;

  /**
   * Operating system to emulate for this request.
   * Influences platform-specific behavior handled by the native layer.
   * Ignored when `transport` is provided.
   * @default 'macos'
   */
  os?: EmulationOS;

  /**
   * Custom emulation overrides. When `browser` or `os` is present, these fields
   * layer on top of the resolved preset profile. When both are omitted, this
   * switches the request into standalone custom emulation mode.
   */
  emulation?: CustomEmulationOptions;

  /**
   * Proxy URL to route the request through (e.g., 'http://proxy.example.com:8080').
   * Proxy support depends on the native layer and proxy scheme.
   * Ignored when `transport` is provided.
   */
  proxy?: string;

  /**
   * Request timeout in milliseconds. If the request takes longer than this value,
   * it will be aborted.
   * @default 30000
   */
  timeout?: number;

  /**
   * Controls how cookies are managed for this call.
   * - "ephemeral": default when no session/sessionId is provided. Creates an isolated session per request.
   * - "session": requires an explicit session or sessionId and reuses its cookie jar.
   */
  cookieMode?: CookieMode;

  /**
   * Session instance to bind this request to. When provided, {@link cookieMode}
   * automatically behaves like `"session"`.
   */
  session?: Session;

  /**
   * Identifier of an existing session created elsewhere (e.g., via {@link createSession}).
   */
  sessionId?: string;

  /**
   * Disable default headers from browser emulation. When enabled, only explicitly
   * provided headers will be sent with the request, preventing emulation headers
   * from being automatically added or appended.
   * @default false
   */
  disableDefaultHeaders?: boolean;

  /**
   * Disable HTTPS certificate verification. When enabled, self-signed and invalid
   * certificates will be accepted.
   * Ignored when `transport` is provided.
   *
   * # Warning
   *
   * You should think very carefully before using this method. If invalid
   * certificates are trusted, *any* certificate for *any* site will be
   * trusted for use. This includes expired certificates. This introduces
   * significant vulnerabilities, and should only be used as a last resort.
   *
   * @default false
   */
  insecure?: boolean;

  /**
   * Whether to automatically decompress response bodies. When set to `false`,
   * the raw compressed response body is returned as-is and the `Content-Encoding`
   * header is preserved. Useful for proxy scenarios where the downstream client
   * handles decompression.
   * @default true
   */
  compress?: boolean;
}

/**
 * Configuration for {@link createSession}.
 */
export interface CreateSessionOptions {
  /**
   * Provide a custom identifier instead of an auto-generated random ID.
   */
  sessionId?: string;

  /**
   * Default headers applied to every request made through this session.
   */
  defaultHeaders?: HeadersInit;

  /**
   * Browser profile to bind to this session. Defaults to 'chrome_142'.
   */
  browser?: BrowserProfile;

  /**
   * Operating system to bind to this session. Defaults to 'macos'.
   */
  os?: EmulationOS;

  /**
   * Custom emulation overrides or a standalone custom emulation for the session transport.
   */
  emulation?: CustomEmulationOptions;
  /**
   * Optional proxy for every request made through the session.
   */
  proxy?: string;
  /**
   * Default timeout applied when {@link Session.fetch} is called without
   * overriding `timeout`.
   */
  timeout?: number;

  /**
   * Disable HTTPS certificate verification. When enabled, self-signed and invalid
   * certificates will be accepted for all requests made through this session.
   *
   * # Warning
   *
   * You should think very carefully before using this method. If invalid
   * certificates are trusted, *any* certificate for *any* site will be
   * trusted for use. This includes expired certificates. This introduces
   * significant vulnerabilities, and should only be used as a last resort.
   *
   * @default false
   */
  insecure?: boolean;
}

/**
 * Configuration for {@link createTransport}.
 */
export interface CreateTransportOptions {
  /**
   * Proxy URL to route requests through (e.g., 'http://proxy.example.com:8080').
   */
  proxy?: string;

  /**
   * Browser profile to impersonate for this transport.
   */
  browser?: BrowserProfile;

  /**
   * Operating system to emulate for this transport.
   */
  os?: EmulationOS;

  /**
   * Custom emulation overrides or a standalone custom emulation for this transport.
   */
  emulation?: CustomEmulationOptions;

  /**
   * Disable HTTPS certificate verification for this transport.
   */
  insecure?: boolean;

  /**
   * Idle timeout for pooled connections (ms).
   */
  poolIdleTimeout?: number;

  /**
   * Maximum number of idle connections per host.
   */
  poolMaxIdlePerHost?: number;

  /**
   * Maximum total connections in the pool.
   */
  poolMaxSize?: number;

  /**
   * TCP connect timeout (ms).
   */
  connectTimeout?: number;

  /**
   * Read timeout (ms).
   */
  readTimeout?: number;
}

/**
 * Legacy request options interface. This interface is deprecated and will be removed in a future version.
 *
 * @deprecated Use {@link RequestInit} with the standard `fetch()` API instead.
 *
 * @example
 * ```typescript
 * // Old (deprecated):
 * const options: RequestOptions = {
 *   url: 'https://api.example.com',
 *   method: 'POST',
 *   body: JSON.stringify({ data: 'value' })
 * };
 *
 * // New (recommended):
 * const response = await fetch('https://api.example.com', {
 *   method: 'POST',
 *   body: JSON.stringify({ data: 'value' })
 * });
 * ```
 */
export interface RequestOptions {
  /**
   * The URL to request.
   */
  url: string;

  /**
   * Browser profile to impersonate.
   * Applies browser profile behavior handled by the native layer.
   * @default 'chrome_142'
   */
  browser?: BrowserProfile;

  /**
   * Operating system to emulate.
   * @default 'macos'
   */
  os?: EmulationOS;

  /**
   * Custom emulation overrides. When `browser` or `os` is present, these fields
   * layer on top of the resolved preset profile. When both are omitted, this
   * switches the request into standalone custom emulation mode.
   */
  emulation?: CustomEmulationOptions;

  /**
   * HTTP method to use for the request.
   * @default 'GET'
   */
  method?: string;

  /**
   * Additional headers to send with the request.
   * Browser-specific headers will be automatically added based on the selected browser profile.
   */
  headers?: Record<string, string> | HeaderTuple[];

  /**
   * Request body data (for POST, PUT, PATCH requests).
   */
  body?: BodyInit | null;

  /**
   * Transport instance to use for this request. When provided, transport-level
   * options such as `browser`, `os`, `proxy`, and `insecure` must not be set.
   */
  transport?: Transport;

  /**
   * Proxy URL to route the request through (e.g., 'http://proxy.example.com:8080').
   * Proxy support depends on the native layer and proxy scheme.
   */
  proxy?: string;

  /**
   * Redirect policy applied to this request. Matches the `redirect` option accepted by {@link fetch}.
   * @default "follow"
   */
  redirect?: "follow" | "manual" | "error";

  /**
   * Request timeout in milliseconds. If the request takes longer than this value,
   * it will be aborted.
   * @default 30000
   */
  timeout?: number;

  /**
   * Signal used to abort the request.
   */
  signal?: AbortSignal | null;

  /**
   * Session instance to bind this request to.
   */
  session?: Session;

  /**
   * Controls cookie scoping behavior for this request.
   */
  cookieMode?: CookieMode;

  /**
   * Identifier for the session that should handle this request.
   * @internal
   */
  sessionId?: string;

  /**
   * Internal flag indicating whether the session should be discarded once the
   * request finishes.
   * @internal
   */
  ephemeral?: boolean;

  /**
   * Disable default headers from browser emulation. When enabled, only explicitly
   * provided headers will be sent with the request, preventing emulation headers
   * from being automatically added or appended.
   * @default false
   */
  disableDefaultHeaders?: boolean;

  /**
   * Disable HTTPS certificate verification. When enabled, self-signed and invalid
   * certificates will be accepted.
   *
   * # Warning
   *
   * You should think very carefully before using this method. If invalid
   * certificates are trusted, *any* certificate for *any* site will be
   * trusted for use. This includes expired certificates. This introduces
   * significant vulnerabilities, and should only be used as a last resort.
   *
   * @default false
   */
  insecure?: boolean;
}

/**
 * Internal response payload returned from the native Rust binding.
 * This interface represents the raw response data before it's converted
 * to a standard Response object.
 *
 * @internal
 */
export interface NativeResponse {
  /**
   * HTTP status code (e.g., 200, 404, 500).
   */
  status: number;

  /**
   * Response headers as [name, value] tuples.
   * Header names are normalized to lowercase.
   */
  headers: HeaderTuple[];

  /**
   * Handle for streaming response body chunks from the native layer.
   * When `null`, the response does not have a body (e.g., HEAD/204/304).
   */
  bodyHandle: number | null;

  /**
   * Inline body buffer returned for small payloads. When present, `bodyHandle`
   * will be `null` to avoid a second native round-trip to read the body.
   */
  bodyBytes: Buffer | null;

  /**
   * Optional Content-Length hint reported by the server after decompression.
   */
  contentLength: number | null;

  /**
   * Cookies set by the server as [name, value] tuples.
   */
  cookies: HeaderTuple[];

  /**
   * Final URL after following any redirects.
   * If no redirects occurred, this will match the original request URL.
   */
  url: string;
}

/**
 * Configuration options for creating a WebSocket connection.
 * Supports browser impersonation and proxies, similar to HTTP requests.
 *
 * @example
 * ```typescript
 * const ws = await websocket('wss://example.com/socket', {
 *   browser: 'chrome_142',
 *   headers: { 'Authorization': 'Bearer token' },
 * });
 *
 * ws.onmessage = (event) => {
 *   console.log('Received:', event.data);
 * };
 * ```
 */
export interface WebSocketOptions {
  /**
   * Browser profile to impersonate for the WebSocket upgrade request.
   * Automatically applies browser-specific headers and TLS fingerprints.
   * @default 'chrome_142'
   */
  browser?: BrowserProfile;

  /**
   * Operating system to emulate for the WebSocket handshake.
   * @default 'macos'
   */
  os?: EmulationOS;

  /**
   * Custom emulation overrides. When `browser` or `os` is present, these fields
   * layer on top of the resolved preset profile. When both are omitted, this
   * switches the handshake into standalone custom emulation mode.
   */
  emulation?: CustomEmulationOptions;

  /**
   * Additional headers to send with the WebSocket upgrade request.
   * Common headers include Authorization, Origin, or custom application headers.
   */
  headers?: HeadersInit;

  /**
   * Proxy URL to route the connection through (e.g., 'http://proxy.example.com:8080').
   * Proxy support depends on the native layer and proxy scheme.
   */
  proxy?: string;

  /**
   * Optional subprotocols for compatibility with the WHATWG WebSocket constructor.
   * Values are validated for non-empty, unique entries and sent in
   * the `Sec-WebSocket-Protocol` handshake header.
   */
  protocols?: string | string[];

  /**
   * Controls the binary payload type exposed via `MessageEvent.data`.
   * - "nodebuffer": delivers Node.js Buffer instances (default)
   * - "arraybuffer": delivers ArrayBuffer instances
   * - "blob": delivers Blob instances
   */
  binaryType?: WebSocketBinaryType;
}

export interface LegacyWebSocketOptions extends WebSocketOptions {
  /**
   * @deprecated Use `websocket(url, options)` or `new WebSocket(...)`.
   */
  url: string;
  /**
   * @deprecated Use `onmessage` or `addEventListener("message", ...)`.
   */
  onMessage?: (data: string | Buffer) => void;
  /**
   * @deprecated Use `onclose` or `addEventListener("close", ...)`.
   */
  onClose?: (event: WebSocketCloseEvent) => void;
  /**
   * @deprecated Use `onerror` or `addEventListener("error", ...)`.
   */
  onError?: (error: string) => void;
}

export type SessionWebSocketOptions = Omit<WebSocketOptions, "browser" | "os" | "proxy" | "emulation">;

export interface LegacySessionWebSocketOptions extends SessionWebSocketOptions {
  /**
   * @deprecated Use `session.websocket(url, options)`.
   */
  url: string;
  /**
   * @deprecated Use `onmessage` or `addEventListener("message", ...)`.
   */
  onMessage?: (data: string | Buffer) => void;
  /**
   * @deprecated Use `onclose` or `addEventListener("close", ...)`.
   */
  onClose?: (event: WebSocketCloseEvent) => void;
  /**
   * @deprecated Use `onerror` or `addEventListener("error", ...)`.
   */
  onError?: (error: string) => void;
}

/**
 * Internal WebSocket connection object returned from the native Rust binding.
 * This interface contains the connection ID used to reference the WebSocket
 * in subsequent operations like sending messages or closing the connection.
 *
 * @internal
 */
export interface NativeWebSocketConnection {
  /**
   * Unique identifier for this WebSocket connection.
   * Used internally to track and manage the connection.
   * @internal
   */
  _id: number;

  /**
   * Selected subprotocol returned by the server, when present.
   * @internal
   */
  protocol?: string;

  /**
   * Negotiated extension string returned by the server, when present.
   * @internal
   */
  extensions?: string;
}

/**
 * Error thrown when a request fails. This can occur due to network errors,
 * timeouts, invalid URLs, or other request-related issues.
 *
 * @example
 * ```typescript
 * try {
 *   const response = await fetch('https://api.example.com');
 * } catch (error) {
 *   if (error instanceof RequestError) {
 *     console.error('Request failed:', error.message);
 *   }
 * }
 * ```
 */
export class RequestError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "RequestError";
  }
}
