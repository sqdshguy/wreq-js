import { randomBytes } from "node:crypto";
import { STATUS_CODES } from "node:http";
import type {
  BodyInit,
  BrowserProfile,
  CookieMode,
  CreateSessionOptions,
  HeadersInit,
  NativeResponse,
  NativeWebSocketConnection,
  RequestOptions,
  SessionHandle,
  WebSocketOptions,
  RequestInit as WreqRequestInit,
} from "./types";
import { RequestError } from "./types";

interface NativeWebSocketOptions {
  url: string;
  browser: BrowserProfile;
  headers: Record<string, string>;
  proxy?: string;
  onMessage: (data: string | Buffer) => void;
  onClose?: () => void;
  onError?: (error: string) => void;
}

interface NativeSessionOptions {
  sessionId: string;
  browser: BrowserProfile;
  proxy?: string;
}

let nativeBinding: {
  request: (options: RequestOptions) => Promise<NativeResponse>;
  getProfiles: () => string[];
  websocketConnect: (options: NativeWebSocketOptions) => Promise<NativeWebSocketConnection>;
  websocketSend: (ws: NativeWebSocketConnection, data: string | Buffer) => Promise<void>;
  websocketClose: (ws: NativeWebSocketConnection) => Promise<void>;
  createSession: (options: NativeSessionOptions) => string;
  clearSession: (sessionId: string) => void;
  dropSession: (sessionId: string) => void;
};

let cachedProfiles: BrowserProfile[] | undefined;

function loadNativeBinding() {
  const platform = process.platform;
  const arch = process.arch;

  // Map Node.js platform/arch to Rust target triple suffixes
  // napi-rs creates files like: wreq-js.linux-x64-gnu.node
  const platformArchMap: Record<string, Record<string, string>> = {
    darwin: {
      x64: "darwin-x64",
      arm64: "darwin-arm64",
    },
    linux: {
      x64: "linux-x64-gnu",
      arm64: "linux-arm64-gnu",
    },
    win32: {
      x64: "win32-x64-msvc",
    },
  };

  const platformArch = platformArchMap[platform]?.[arch];

  if (!platformArch) {
    throw new Error(
      `Unsupported platform: ${platform}-${arch}. ` +
        `Supported platforms: darwin-x64, darwin-arm64, linux-x64, linux-arm64, win32-x64`,
    );
  }

  // Try to load platform-specific binary
  const binaryName = `wreq-js.${platformArch}.node`;

  try {
    return require(`../rust/${binaryName}`);
  } catch {
    // Fallback to wreq-js.node (for local development)
    try {
      return require("../rust/wreq-js.node");
    } catch {
      throw new Error(
        `Failed to load native module for ${platform}-${arch}. ` +
          `Tried: ../rust/${binaryName} and ../rust/wreq-js.node. ` +
          `Make sure the package is installed correctly and the native module is built for your platform.`,
      );
    }
  }
}

nativeBinding = loadNativeBinding();

const websocketFinalizer =
  typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry<NativeWebSocketConnection>((connection: NativeWebSocketConnection) => {
        void nativeBinding.websocketClose(connection).catch(() => undefined);
      })
    : undefined;

const DEFAULT_BROWSER: BrowserProfile = "chrome_142";

type SessionDefaults = {
  browser: BrowserProfile;
  proxy?: string;
  timeout?: number;
};

type SessionResolution = {
  sessionId: string;
  cookieMode: CookieMode;
  dropAfterRequest: boolean;
};

function generateSessionId(): string {
  const cryptoGlobal = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (cryptoGlobal?.randomUUID) {
    return cryptoGlobal.randomUUID();
  }

  return randomBytes(16).toString("hex");
}

function normalizeSessionOptions(options?: CreateSessionOptions): { sessionId: string; defaults: SessionDefaults } {
  const sessionId = options?.sessionId ?? generateSessionId();
  const defaults: SessionDefaults = {
    browser: options?.browser ?? DEFAULT_BROWSER,
  };

  if (options?.proxy !== undefined) {
    defaults.proxy = options.proxy;
  }

  if (options?.timeout !== undefined) {
    defaults.timeout = options.timeout;
  }

  return { sessionId, defaults };
}

type HeaderStoreEntry = {
  name: string;
  values: string[];
};

function isIterable<T>(value: unknown): value is Iterable<T> {
  return Boolean(value) && typeof (value as Iterable<T>)[Symbol.iterator] === "function";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function coerceHeaderValue(value: unknown): string {
  return String(value);
}

export class Headers implements Iterable<[string, string]> {
  private readonly store = new Map<string, HeaderStoreEntry>();

  constructor(init?: HeadersInit) {
    if (init) {
      this.applyInit(init);
    }
  }

  private applyInit(init: HeadersInit) {
    if (init instanceof Headers) {
      for (const [name, value] of init) {
        this.append(name, value);
      }
      return;
    }

    if (Array.isArray(init) || isIterable<[string, string]>(init)) {
      for (const tuple of init as Iterable<[string, string]>) {
        if (!tuple) {
          continue;
        }
        const [name, value] = tuple;
        this.append(name, value);
      }
      return;
    }

    if (isPlainObject(init)) {
      for (const [name, value] of Object.entries(init)) {
        if (value === undefined || value === null) {
          continue;
        }
        this.set(name, coerceHeaderValue(value));
      }
    }
  }

  private normalizeName(name: string): { key: string; display: string } {
    if (typeof name !== "string") {
      throw new TypeError("Header name must be a string");
    }
    const trimmed = name.trim();
    if (!trimmed) {
      throw new TypeError("Header name must not be empty");
    }
    return { key: trimmed.toLowerCase(), display: trimmed };
  }

  private assertValue(value: unknown): string {
    if (value === undefined || value === null) {
      throw new TypeError("Header value must not be null or undefined");
    }

    return coerceHeaderValue(value);
  }

  append(name: string, value: unknown): void {
    const normalized = this.normalizeName(name);
    const existing = this.store.get(normalized.key);
    const coercedValue = this.assertValue(value);

    if (existing) {
      existing.values.push(coercedValue);
      return;
    }

    this.store.set(normalized.key, {
      name: normalized.display,
      values: [coercedValue],
    });
  }

  set(name: string, value: unknown): void {
    const normalized = this.normalizeName(name);
    const coercedValue = this.assertValue(value);

    this.store.set(normalized.key, {
      name: normalized.display,
      values: [coercedValue],
    });
  }

  get(name: string): string | null {
    const normalized = this.normalizeName(name);
    const entry = this.store.get(normalized.key);
    return entry ? entry.values.join(", ") : null;
  }

  has(name: string): boolean {
    const normalized = this.normalizeName(name);
    return this.store.has(normalized.key);
  }

  delete(name: string): void {
    const normalized = this.normalizeName(name);
    this.store.delete(normalized.key);
  }

  entries(): IterableIterator<[string, string]> {
    return this[Symbol.iterator]();
  }

  *keys(): IterableIterator<string> {
    for (const [name] of this) {
      yield name;
    }
  }

  *values(): IterableIterator<string> {
    for (const [, value] of this) {
      yield value;
    }
  }

  forEach(callback: (value: string, name: string, parent: Headers) => void, thisArg?: unknown): void {
    for (const [name, value] of this) {
      callback.call(thisArg, value, name, this);
    }
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    const generator = function* (store: Map<string, HeaderStoreEntry>) {
      for (const entry of store.values()) {
        yield [entry.name, entry.values.join(", ")] as [string, string];
      }
    };

    return generator(this.store);
  }

  toObject(): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [name, value] of this) {
      result[name] = value;
    }

    return result;
  }
}

type ResponseType = "basic" | "cors" | "error" | "opaque" | "opaqueredirect";

function cloneNativeResponse(payload: NativeResponse): NativeResponse {
  return {
    status: payload.status,
    headers: { ...payload.headers },
    body: payload.body,
    cookies: { ...payload.cookies },
    url: payload.url,
  };
}

export class Response {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly url: string;
  readonly redirected: boolean;
  readonly type: ResponseType = "basic";
  readonly cookies: Record<string, string>;
  readonly body: string;
  bodyUsed = false;

  private readonly payload: NativeResponse;
  private readonly requestUrl: string;

  constructor(payload: NativeResponse, requestUrl: string) {
    this.payload = cloneNativeResponse(payload);
    this.requestUrl = requestUrl;
    this.status = payload.status;
    this.statusText = STATUS_CODES[payload.status] ?? "";
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = new Headers(payload.headers);
    this.url = payload.url;
    this.redirected = this.url !== requestUrl;
    this.cookies = { ...payload.cookies };
    this.body = payload.body;
  }

  async json<T = unknown>(): Promise<T> {
    const text = await this.text();
    return JSON.parse(text) as T;
  }

  async text(): Promise<string> {
    this.assertBodyAvailable();
    this.bodyUsed = true;
    return this.body;
  }

  clone(): Response {
    if (this.bodyUsed) {
      throw new TypeError("Cannot clone a Response whose body is already used");
    }

    return new Response(cloneNativeResponse(this.payload), this.requestUrl);
  }

  private assertBodyAvailable(): void {
    if (this.bodyUsed) {
      throw new TypeError("Response body is already used");
    }
  }
}

export class Session implements SessionHandle {
  readonly id: string;
  private disposed = false;
  private readonly defaults: SessionDefaults;

  constructor(id: string, defaults: SessionDefaults) {
    this.id = id;
    this.defaults = defaults;
  }

  get closed(): boolean {
    return this.disposed;
  }

  private ensureActive(): void {
    if (this.disposed) {
      throw new RequestError("Session has been closed");
    }
  }

  private enforceBrowser(browser?: BrowserProfile): BrowserProfile {
    const resolved = browser ?? this.defaults.browser;

    if (resolved !== this.defaults.browser) {
      throw new RequestError("Session browser cannot be changed after creation");
    }

    return resolved;
  }

  private enforceProxy(proxy?: string): string | undefined {
    if (proxy === undefined) {
      return this.defaults.proxy;
    }

    if ((this.defaults.proxy ?? null) !== (proxy ?? null)) {
      throw new RequestError("Session proxy cannot be changed after creation");
    }

    return proxy;
  }

  async fetch(input: string | URL, init?: WreqRequestInit): Promise<Response> {
    this.ensureActive();

    const config: WreqRequestInit = {
      ...(init ?? {}),
      session: this,
      cookieMode: "session",
    };

    config.browser = this.enforceBrowser(config.browser);

    const proxy = this.enforceProxy(config.proxy);
    if (proxy !== undefined || config.proxy !== undefined) {
      if (proxy === undefined) {
        delete config.proxy;
      } else {
        config.proxy = proxy;
      }
    }

    if (config.timeout === undefined && this.defaults.timeout !== undefined) {
      config.timeout = this.defaults.timeout;
    }

    return fetch(input, config);
  }

  async clearCookies(): Promise<void> {
    this.ensureActive();
    try {
      nativeBinding.clearSession(this.id);
    } catch (error) {
      throw new RequestError(String(error));
    }
  }

  async close(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;

    try {
      nativeBinding.dropSession(this.id);
    } catch (error) {
      throw new RequestError(String(error));
    }
  }
}

function resolveSessionContext(config: WreqRequestInit): SessionResolution {
  const requestedMode = config.cookieMode ?? "ephemeral";
  const sessionCandidate = config.session;
  const providedSessionId = typeof config.sessionId === "string" ? config.sessionId.trim() : undefined;

  if (sessionCandidate && providedSessionId) {
    throw new RequestError("Provide either `session` or `sessionId`, not both.");
  }

  if (sessionCandidate) {
    if (!(sessionCandidate instanceof Session)) {
      throw new RequestError("`session` must be created via createSession()");
    }

    if (sessionCandidate.closed) {
      throw new RequestError("Session has been closed");
    }

    return {
      sessionId: sessionCandidate.id,
      cookieMode: "session",
      dropAfterRequest: false,
    };
  }

  if (providedSessionId) {
    if (!providedSessionId) {
      throw new RequestError("sessionId must not be empty");
    }

    if (requestedMode === "ephemeral") {
      throw new RequestError("cookieMode 'ephemeral' cannot be combined with sessionId");
    }

    return {
      sessionId: providedSessionId,
      cookieMode: "session",
      dropAfterRequest: false,
    };
  }

  if (requestedMode === "session") {
    throw new RequestError("cookieMode 'session' requires a session or sessionId");
  }

  return {
    sessionId: generateSessionId(),
    cookieMode: "ephemeral",
    dropAfterRequest: true,
  };
}

interface AbortHandler {
  promise: Promise<never>;
  cleanup: () => void;
}

function createAbortError(reason?: unknown): Error {
  const fallbackMessage = typeof reason === "string" ? reason : "The operation was aborted";

  if (typeof DOMException !== "undefined" && reason instanceof DOMException) {
    return reason.name === "AbortError" ? reason : new DOMException(reason.message || fallbackMessage, "AbortError");
  }

  if (reason instanceof Error) {
    reason.name = "AbortError";
    return reason;
  }

  if (typeof DOMException !== "undefined") {
    return new DOMException(fallbackMessage, "AbortError");
  }

  const error = new Error(fallbackMessage);
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): error is Error {
  return Boolean(error) && typeof (error as Error).name === "string" && (error as Error).name === "AbortError";
}

function setupAbort(signal?: AbortSignal | null): AbortHandler | null {
  if (!signal) {
    return null;
  }

  if (signal.aborted) {
    throw createAbortError(signal.reason);
  }

  let onAbort: (() => void) | undefined;

  const promise = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(createAbortError(signal.reason));
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });

  const cleanup = () => {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
      onAbort = undefined;
    }
  };

  return { promise, cleanup };
}

function normalizeUrlInput(input: string | URL): string {
  const value = typeof input === "string" ? input : input.toString();

  if (!value) {
    throw new RequestError("URL is required");
  }

  try {
    return new URL(value).toString();
  } catch {
    throw new RequestError(`Invalid URL: ${value}`);
  }
}

function validateRedirectMode(mode?: WreqRequestInit["redirect"]): void {
  if (!mode || mode === "follow") {
    return;
  }

  throw new RequestError(`Redirect mode '${mode}' is not supported`);
}

function serializeBody(body?: BodyInit | null): string | undefined {
  if (body === null || body === undefined) {
    return undefined;
  }

  if (typeof body === "string") {
    return body;
  }

  if (Buffer.isBuffer(body)) {
    return body.toString();
  }

  if (body instanceof URLSearchParams) {
    return body.toString();
  }

  if (body instanceof ArrayBuffer) {
    return Buffer.from(body).toString();
  }

  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString();
  }

  throw new TypeError("Unsupported body type; expected string, Buffer, ArrayBuffer, or URLSearchParams");
}

const SUPPORTED_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"] as const;
type SupportedMethod = (typeof SUPPORTED_METHODS)[number];

function ensureMethod(method?: string): string {
  const normalized = method?.trim().toUpperCase();
  return normalized && normalized.length > 0 ? normalized : "GET";
}

function assertSupportedMethod(method: string): asserts method is SupportedMethod {
  if (!SUPPORTED_METHODS.includes(method as SupportedMethod)) {
    throw new RequestError(`Unsupported HTTP method: ${method}`);
  }
}

function ensureBodyAllowed(method: string, body?: string): void {
  if (!body) {
    return;
  }

  if (method === "GET" || method === "HEAD") {
    throw new RequestError(`Request with ${method} method cannot have a body`);
  }
}

function validateBrowserProfile(browser?: BrowserProfile): void {
  if (!browser) {
    return;
  }

  const profiles = getProfiles();

  if (!profiles.includes(browser)) {
    throw new RequestError(`Invalid browser profile: ${browser}. Available profiles: ${profiles.join(", ")}`);
  }
}

async function dispatchRequest(
  options: RequestOptions,
  requestUrl: string,
  signal?: AbortSignal | null,
): Promise<Response> {
  const abortHandler = setupAbort(signal);
  const nativePromise = nativeBinding.request(options);
  const pending = abortHandler ? Promise.race([nativePromise, abortHandler.promise]) : nativePromise;

  let payload: NativeResponse;

  try {
    payload = (await pending) as NativeResponse;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    if (error instanceof RequestError) {
      throw error;
    }

    throw new RequestError(String(error));
  } finally {
    abortHandler?.cleanup();
  }

  return new Response(payload, requestUrl);
}

/**
 * Fetch-compatible entry point that adds browser impersonation controls.
 *
 * @param input - Request URL (string or URL instance)
 * @param init - Fetch-compatible init options
 */
export async function fetch(input: string | URL, init?: WreqRequestInit): Promise<Response> {
  const url = normalizeUrlInput(input);
  const config = init ?? {};
  const sessionContext = resolveSessionContext(config);

  validateRedirectMode(config.redirect);
  validateBrowserProfile(config.browser);

  const headers = new Headers(config.headers);
  const method = ensureMethod(config.method);
  assertSupportedMethod(method);
  const body = serializeBody(config.body ?? null);

  ensureBodyAllowed(method, body);

  const headerRecord = headers.toObject();
  const hasHeaders = Object.keys(headerRecord).length > 0;

  const requestOptions: RequestOptions = {
    url,
    method,
    ...(config.browser && { browser: config.browser }),
    ...(hasHeaders && { headers: headerRecord }),
    ...(body !== undefined && { body }),
    ...(config.proxy !== undefined && { proxy: config.proxy }),
    ...(config.timeout !== undefined && { timeout: config.timeout }),
    ...(config.disableDefaultHeaders !== undefined && { disableDefaultHeaders: config.disableDefaultHeaders }),
    sessionId: sessionContext.sessionId,
    ephemeral: sessionContext.dropAfterRequest,
  };

  try {
    return await dispatchRequest(requestOptions, url, config.signal ?? null);
  } finally {
    if (sessionContext.dropAfterRequest) {
      try {
        nativeBinding.dropSession(sessionContext.sessionId);
      } catch {
        // ignore cleanup errors for ephemeral sessions
      }
    }
  }
}

export async function createSession(options?: CreateSessionOptions): Promise<Session> {
  const { sessionId, defaults } = normalizeSessionOptions(options);

  validateBrowserProfile(defaults.browser);

  let createdId: string;

  try {
    createdId = nativeBinding.createSession({
      sessionId,
      browser: defaults.browser,
      ...(defaults.proxy !== undefined && { proxy: defaults.proxy }),
    });
  } catch (error) {
    throw new RequestError(String(error));
  }

  return new Session(createdId, defaults);
}

export async function withSession<T>(
  fn: (session: Session) => Promise<T> | T,
  options?: CreateSessionOptions,
): Promise<T> {
  const session = await createSession(options);

  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

/**
 * @deprecated Use {@link fetch} instead.
 */
export async function request(options: RequestOptions): Promise<Response> {
  if (!options.url) {
    throw new RequestError("URL is required");
  }

  const { url, ...rest } = options;
  const init: WreqRequestInit = {};

  if (rest.method !== undefined) {
    init.method = rest.method;
  }

  if (rest.headers !== undefined) {
    init.headers = rest.headers;
  }

  if (rest.body !== undefined) {
    init.body = rest.body;
  }

  if (rest.browser !== undefined) {
    init.browser = rest.browser;
  }

  if (rest.proxy !== undefined) {
    init.proxy = rest.proxy;
  }

  if (rest.timeout !== undefined) {
    init.timeout = rest.timeout;
  }

  if (rest.sessionId !== undefined) {
    init.sessionId = rest.sessionId;
  }

  if (rest.disableDefaultHeaders !== undefined) {
    init.disableDefaultHeaders = rest.disableDefaultHeaders;
  }

  return fetch(url, init);
}

/**
 * Get list of available browser profiles
 *
 * @returns Array of browser profile names
 *
 * @example
 * ```typescript
 * import { getProfiles } from 'wreq-js';
 *
 * const profiles = getProfiles();
 * console.log(profiles); // ['chrome_120', 'chrome_131', 'firefox', ...]
 * ```
 */
export function getProfiles(): BrowserProfile[] {
  if (!cachedProfiles) {
    cachedProfiles = nativeBinding.getProfiles() as BrowserProfile[];
  }

  return cachedProfiles;
}

/**
 * Convenience helper for GET requests using {@link fetch}.
 */
export async function get(url: string, init?: Omit<WreqRequestInit, "method">): Promise<Response> {
  return fetch(url, { ...(init ?? {}), method: "GET" });
}

/**
 * Convenience helper for POST requests using {@link fetch}.
 */
export async function post(
  url: string,
  body?: BodyInit | null,
  init?: Omit<WreqRequestInit, "method" | "body">,
): Promise<Response> {
  const config: WreqRequestInit = {
    ...(init ?? {}),
    method: "POST",
    ...(body !== undefined ? { body } : {}),
  };

  return fetch(url, config);
}

/**
 * WebSocket connection class
 *
 * @example
 * ```typescript
 * import { websocket } from 'wreq-js';
 *
 * const ws = await websocket({
 *   url: 'wss://echo.websocket.org',
 *   browser: 'chrome_142',
 *   onMessage: (data) => {
 *     console.log('Received:', data);
 *   },
 *   onClose: () => {
 *     console.log('Connection closed');
 *   },
 *   onError: (error) => {
 *     console.error('Error:', error);
 *   }
 * });
 *
 * // Send text message
 * await ws.send('Hello World');
 *
 * // Send binary message
 * await ws.send(Buffer.from([1, 2, 3]));
 *
 * // Close connection
 * await ws.close();
 * ```
 */
export class WebSocket {
  private _connection: NativeWebSocketConnection;
  private _finalizerToken: NativeWebSocketConnection | undefined;
  private _closed = false;

  constructor(connection: NativeWebSocketConnection) {
    this._connection = connection;

    if (websocketFinalizer) {
      this._finalizerToken = connection;
      websocketFinalizer.register(this, connection, connection);
    }
  }

  /**
   * Send a message (text or binary)
   */
  async send(data: string | Buffer): Promise<void> {
    try {
      await nativeBinding.websocketSend(this._connection, data);
    } catch (error) {
      throw new RequestError(String(error));
    }
  }

  /**
   * Close the WebSocket connection
   */
  async close(): Promise<void> {
    if (this._closed) {
      return;
    }

    this._closed = true;

    if (this._finalizerToken && websocketFinalizer) {
      websocketFinalizer.unregister(this._finalizerToken);
      this._finalizerToken = undefined;
    }

    try {
      await nativeBinding.websocketClose(this._connection);
    } catch (error) {
      throw new RequestError(String(error));
    }
  }
}

/**
 * Create a WebSocket connection with browser impersonation
 *
 * @param options - WebSocket options
 * @returns Promise that resolves to the WebSocket instance
 */
export async function websocket(options: WebSocketOptions): Promise<WebSocket> {
  if (!options.url) {
    throw new RequestError("URL is required");
  }

  if (!options.onMessage) {
    throw new RequestError("onMessage callback is required");
  }

  if (options.browser) {
    const profiles = getProfiles();

    if (!profiles.includes(options.browser)) {
      throw new RequestError(`Invalid browser profile: ${options.browser}. Available profiles: ${profiles.join(", ")}`);
    }
  }

  try {
    const connection = await nativeBinding.websocketConnect({
      url: options.url,
      browser: options.browser || DEFAULT_BROWSER,
      headers: options.headers || {},
      ...(options.proxy !== undefined && { proxy: options.proxy }),
      onMessage: options.onMessage,
      ...(options.onClose !== undefined && { onClose: options.onClose }),
      ...(options.onError !== undefined && { onError: options.onError }),
    });

    return new WebSocket(connection);
  } catch (error) {
    throw new RequestError(String(error));
  }
}

export type {
  BodyInit,
  BrowserProfile,
  CookieMode,
  CreateSessionOptions,
  HeadersInit,
  HttpMethod,
  RequestInit,
  RequestOptions,
  SessionHandle,
  WebSocketOptions,
} from "./types";

export { RequestError };

export default {
  fetch,
  request,
  get,
  post,
  getProfiles,
  createSession,
  withSession,
  websocket,
  WebSocket,
  Headers,
  Response,
  Session,
};
