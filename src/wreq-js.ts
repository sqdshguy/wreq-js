import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { ReadableStream } from "node:stream/web";
import type {
  AlpnProtocol,
  AlpsProtocol,
  BodyInit,
  BrowserProfile,
  CookieMode,
  CreateSessionOptions,
  CreateTransportOptions,
  CustomEmulationOptions,
  CustomHttp1Options,
  CustomHttp2Options,
  CustomTlsOptions,
  EmulationOS,
  HeadersInit,
  HeaderTuple,
  Http2ExperimentalSetting,
  Http2Priority,
  Http2PseudoHeaderId,
  Http2SettingId,
  Http2StreamDependency,
  LegacySessionWebSocketOptions,
  LegacyWebSocketOptions,
  NativeResponse,
  NativeWebSocketConnection,
  RequestOptions,
  SessionHandle,
  SessionWebSocketOptions,
  TlsVersion,
  WebSocketBinaryType,
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketMessageEvent,
  WebSocketOpenEvent,
  WebSocketOptions,
  RequestInit as WreqRequestInit,
} from "./types.js";
import { RequestError } from "./types.js";

interface NativeWebSocketCloseEvent {
  code: number;
  reason: string;
}

interface NativeWebSocketCloseOptions {
  code?: number;
  reason?: string;
}

interface NativeWebSocketOptions {
  url: string;
  browser?: BrowserProfile;
  os?: EmulationOS;
  emulationJson?: string;
  headers: HeaderTuple[];
  protocols?: string[];
  proxy?: string;
  onMessage: (data: string | Buffer) => void;
  onClose?: (event: NativeWebSocketCloseEvent) => void;
  onError?: (error: string) => void;
}

interface NativeWebSocketSessionOptions {
  url: string;
  sessionId: string;
  transportId: string;
  headers: HeaderTuple[];
  protocols?: string[];
  onMessage: (data: string | Buffer) => void;
  onClose?: (event: NativeWebSocketCloseEvent) => void;
  onError?: (error: string) => void;
}

interface NativeSessionOptions {
  sessionId: string;
}

interface NativeTransportOptions {
  browser?: BrowserProfile;
  os?: EmulationOS;
  emulationJson?: string;
  proxy?: string;
  insecure?: boolean;
  poolIdleTimeout?: number;
  poolMaxIdlePerHost?: number;
  poolMaxSize?: number;
  connectTimeout?: number;
  readTimeout?: number;
}

interface NativeRequestOptions {
  url: string;
  method: string;
  browser?: BrowserProfile;
  os?: EmulationOS;
  emulationJson?: string;
  headers?: HeaderTuple[];
  body?: Buffer;
  proxy?: string;
  timeout?: number;
  redirect?: "follow" | "manual" | "error";
  sessionId: string;
  ephemeral: boolean;
  disableDefaultHeaders?: boolean;
  insecure?: boolean;
  transportId?: string;
  compress?: boolean;
}

let nativeBinding: {
  request: (options: NativeRequestOptions, requestId: number, enableCancellation?: boolean) => Promise<NativeResponse>;
  cancelRequest: (requestId: number) => void;
  readBodyChunk: (handleId: number) => Promise<Buffer | null>;
  readBodyAll: (handleId: number) => Promise<Buffer>;
  cancelBody: (handleId: number) => void;
  getProfiles: () => string[];
  websocketConnect: (options: NativeWebSocketOptions) => Promise<NativeWebSocketConnection>;
  websocketConnectSession: (options: NativeWebSocketSessionOptions) => Promise<NativeWebSocketConnection>;
  websocketSend: (ws: NativeWebSocketConnection, data: string | Buffer) => Promise<void>;
  websocketClose: (ws: NativeWebSocketConnection, options?: NativeWebSocketCloseOptions) => Promise<void>;
  createSession: (options: NativeSessionOptions) => string;
  clearSession: (sessionId: string) => void;
  dropSession: (sessionId: string) => void;
  getCookies: (sessionId: string, url: string) => Record<string, string>;
  setCookie: (sessionId: string, name: string, value: string, url: string) => void;
  createTransport: (options: NativeTransportOptions) => string;
  dropTransport: (transportId: string) => void;
  getOperatingSystems?: () => string[];
};

let cachedProfiles: BrowserProfile[] | undefined;
let cachedProfileSet: Set<string> | undefined;
let cachedOperatingSystems: EmulationOS[] | undefined;
let cachedOperatingSystemSet: Set<string> | undefined;

function detectLibc(): "gnu" | "musl" | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }

  const envLibc = process.env.LIBC ?? process.env.npm_config_libc;
  if (envLibc) {
    return envLibc.toLowerCase().includes("musl") ? "musl" : "gnu";
  }

  try {
    const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
    const glibcVersion = report?.header?.glibcVersionRuntime;

    if (glibcVersion) {
      return "gnu";
    }

    return "musl";
  } catch {
    return "gnu";
  }
}

const require =
  typeof import.meta !== "undefined" && import.meta.url ? createRequire(import.meta.url) : createRequire(__filename);

function loadNativeBinding() {
  const platform = process.platform;
  const arch = process.arch;
  const libc = detectLibc();

  const platformArchMap: Record<string, Record<string, string | Record<"gnu" | "musl", string>>> = {
    darwin: { x64: "darwin-x64", arm64: "darwin-arm64" },
    linux: {
      x64: { gnu: "linux-x64-gnu", musl: "linux-x64-musl" },
      arm64: "linux-arm64-gnu",
    },
    win32: { x64: "win32-x64-msvc" },
  };

  const platformArchMapEntry = platformArchMap[platform]?.[arch];
  const platformArch =
    typeof platformArchMapEntry === "string"
      ? platformArchMapEntry
      : platformArchMapEntry?.[(libc ?? "gnu") as "gnu" | "musl"];

  if (!platformArch) {
    throw new Error(
      `Unsupported platform: ${platform}-${arch}${libc ? `-${libc}` : ""}. ` +
        `Supported platforms: darwin-x64, darwin-arm64, linux-x64-gnu, linux-x64-musl, ` +
        `linux-arm64-gnu, win32-x64-msvc`,
    );
  }

  const binaryName = `wreq-js.${platformArch}.node`;

  try {
    return require(`../rust/${binaryName}`);
  } catch {
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

type NativeBodyHandle = { id: number; released: boolean };

const bodyHandleFinalizer =
  typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry<NativeBodyHandle>((handle: NativeBodyHandle) => {
        if (handle.released) {
          return;
        }

        handle.released = true;
        try {
          nativeBinding.cancelBody(handle.id);
        } catch {
          // Best-effort cleanup; ignore binding-level failures.
        }
      })
    : undefined;

const DEFAULT_BROWSER: BrowserProfile = "chrome_142";
const DEFAULT_OS: EmulationOS = "macos";
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const SUPPORTED_OSES: readonly EmulationOS[] = ["windows", "macos", "linux", "android", "ios"];
const UTF8_DECODER = new TextDecoder("utf-8");

type SessionDefaults = {
  transportMode: ResolvedEmulationMode;
  proxy?: string;
  timeout?: number;
  insecure?: boolean;
  defaultHeaders?: HeaderTuple[];
  transportId?: string;
  ownsTransport?: boolean;
};

type SessionResolution = {
  sessionId: string;
  cookieMode: CookieMode;
  dropAfterRequest: boolean;
  defaults?: SessionDefaults;
};

type TransportResolution = {
  transportId?: string;
  mode?: ResolvedEmulationMode;
  proxy?: string;
  insecure?: boolean;
};

type SerializedCustomEmulation = {
  tlsOptions?: CustomTlsOptions;
  http1Options?: CustomHttp1Options;
  http2Options?: CustomHttp2Options;
  headers?: HeaderTuple[];
  origHeaders?: string[];
};

type PresetEmulationMode = {
  kind: "preset";
  browser: BrowserProfile;
  os: EmulationOS;
  emulationJson?: string;
};

type CustomEmulationMode = {
  kind: "custom";
  emulationJson: string;
};

type ResolvedEmulationMode = PresetEmulationMode | CustomEmulationMode;

type LegacyWebSocketCallbacks = {
  onMessage?: (data: string | Buffer) => void;
  onClose?: (event: WebSocketCloseEvent) => void;
  onError?: (error: string) => void;
};

type WebSocketOpenDispatchMode = "automatic" | "deferred";

type InternalWebSocketInit = {
  readonly _internal: true;
  url: string;
  options: WebSocketOptions;
  openDispatchMode: WebSocketOpenDispatchMode;
  connect: (callbacks: {
    onMessage: (data: string | Buffer) => void;
    onClose: (event: NativeWebSocketCloseEvent) => void;
    onError: (message: string) => void;
  }) => Promise<NativeWebSocketConnection>;
  legacyCallbacks: LegacyWebSocketCallbacks | undefined;
};

// Persistent sessions need globally-unique IDs; ephemeral ones only need a
// placeholder that is never looked up again, so a cheap monotonic counter suffices.
let ephemeralIdCounter = 0;
function generateEphemeralSessionId(): string {
  return `_e${++ephemeralIdCounter}`;
}

function generateSessionId(): string {
  return randomUUID();
}

function normalizeSessionOptions(options?: CreateSessionOptions): { sessionId: string; defaults: SessionDefaults } {
  const sessionId = options?.sessionId ?? generateSessionId();
  const defaults: SessionDefaults = {
    transportMode: resolveEmulationMode(options?.browser, options?.os, options?.emulation),
  };

  if (options?.proxy !== undefined) {
    defaults.proxy = options.proxy;
  }

  if (options?.timeout !== undefined) {
    validateTimeout(options.timeout);
    defaults.timeout = options.timeout;
  }

  if (options?.insecure !== undefined) {
    defaults.insecure = options.insecure;
  }

  if (options?.defaultHeaders !== undefined) {
    defaults.defaultHeaders = headersToTuples(options.defaultHeaders);
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

  toTuples(): HeaderTuple[] {
    const result: HeaderTuple[] = [];

    for (const [name, value] of this) {
      result.push([name, value]);
    }

    return result;
  }
}

function headersToTuples(init: HeadersInit): HeaderTuple[] {
  return new Headers(init).toTuples();
}

function hasHeaderName(tuples: HeaderTuple[] | undefined, name: string): boolean {
  if (!tuples) {
    return false;
  }

  const target = name.toLowerCase();
  for (const [headerName] of tuples) {
    if (headerName.toLowerCase() === target) {
      return true;
    }
  }

  return false;
}

function hasWebSocketProtocolHeader(headers: HeadersInit | undefined): boolean {
  const protocolHeaderName = "Sec-WebSocket-Protocol";
  if (!headers) {
    return false;
  }

  return hasHeaderName(headersToTuples(headers), protocolHeaderName);
}

function assertNoManualWebSocketProtocolHeader(headers: HeadersInit | undefined): void {
  if (hasWebSocketProtocolHeader(headers)) {
    throw new RequestError("Do not set `Sec-WebSocket-Protocol` header manually; use the `protocols` option instead.");
  }
}

function normalizeWebSocketProtocolList(protocols?: string | string[]): string[] | undefined {
  if (protocols === undefined) {
    return undefined;
  }

  return typeof protocols === "string" ? [protocols] : [...protocols];
}

function mergeHeaderTuples(
  defaults: HeaderTuple[] | undefined,
  overrides: HeadersInit | undefined,
): HeaderTuple[] | undefined {
  if (!defaults) {
    return overrides === undefined ? undefined : headersToTuples(overrides);
  }

  if (overrides === undefined) {
    return defaults;
  }

  const overrideTuples = headersToTuples(overrides);
  if (overrideTuples.length === 0) {
    return defaults;
  }

  const overrideKeys = new Set<string>();
  for (const tuple of overrideTuples) {
    overrideKeys.add(tuple[0].toLowerCase());
  }
  const merged: HeaderTuple[] = [];
  for (const tuple of defaults) {
    if (!overrideKeys.has(tuple[0].toLowerCase())) {
      merged.push(tuple);
    }
  }
  for (const tuple of overrideTuples) {
    merged.push(tuple);
  }
  return merged;
}

type ResponseType = "basic" | "cors" | "error" | "opaque" | "opaqueredirect";

function cloneNativeResponse(payload: NativeResponse): NativeResponse {
  return {
    status: payload.status,
    headers: payload.headers.map(([name, value]): HeaderTuple => [name, value]),
    bodyHandle: payload.bodyHandle,
    bodyBytes: payload.bodyBytes,
    contentLength: payload.contentLength,
    cookies: payload.cookies.map(([name, value]): HeaderTuple => [name, value]),
    url: payload.url,
  };
}

function releaseNativeBody(handle: NativeBodyHandle): void {
  if (handle.released) {
    return;
  }

  handle.released = true;

  try {
    nativeBinding.cancelBody(handle.id);
  } catch {
    // Best-effort cleanup; ignore binding errors.
  }

  bodyHandleFinalizer?.unregister(handle);
}

function markNativeBodyReleased(handle: NativeBodyHandle): void {
  if (handle.released) {
    return;
  }

  handle.released = true;
  bodyHandleFinalizer?.unregister(handle);
}

function createNativeBodyStream(handle: NativeBodyHandle): ReadableStream<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await nativeBinding.readBodyChunk(handle.id);

        if (chunk === null) {
          releaseNativeBody(handle);
          controller.close();
          return;
        }

        controller.enqueue(chunk);
      } catch (error) {
        releaseNativeBody(handle);
        controller.error(error);
      }
    },
    cancel() {
      releaseNativeBody(handle);
    },
  });

  bodyHandleFinalizer?.register(stream, handle, handle);

  return stream;
}

function wrapBodyStream(source: ReadableStream<Uint8Array>, onFirstUse: () => void): ReadableStream<Uint8Array> {
  let started = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        onFirstUse();
      }

      if (!reader) {
        reader = source.getReader();
      }

      try {
        const { done, value } = await reader.read();

        if (done) {
          controller.close();
          return;
        }

        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      if (!reader) {
        return source.cancel(reason);
      }
      return reader.cancel(reason);
    },
  });
}

export class Response {
  readonly status: number;
  readonly ok: boolean;
  readonly contentLength: number | null;
  readonly url: string;
  readonly type: ResponseType = "basic";
  bodyUsed = false;

  private readonly payload: NativeResponse;
  private readonly requestUrl: string;
  private redirectedMemo: boolean | undefined;
  private readonly headersInit: HeaderTuple[];
  private headersInstance: Headers | null;
  private readonly cookiesInit: HeaderTuple[];
  private cookiesRecord: Record<string, string | string[]> | null;
  private inlineBody: Buffer | null;
  private bodySource: ReadableStream<Uint8Array> | null;
  private bodyStream: ReadableStream<Uint8Array> | null | undefined;
  // Track if we can use the fast path (native handle not yet wrapped in a stream)
  private nativeHandleAvailable: boolean;
  private nativeHandle: NativeBodyHandle | null;

  constructor(payload: NativeResponse, requestUrl: string, bodySource?: ReadableStream<Uint8Array> | null) {
    this.payload = payload;
    this.requestUrl = requestUrl;
    this.status = this.payload.status;
    this.ok = this.status >= 200 && this.status < 300;
    this.headersInit = this.payload.headers;
    this.headersInstance = null;
    this.url = this.payload.url;
    this.cookiesInit = this.payload.cookies;
    this.cookiesRecord = null;
    this.contentLength = this.payload.contentLength ?? null;
    this.inlineBody = this.payload.bodyBytes ?? null;
    this.nativeHandle = null;

    if (typeof bodySource !== "undefined") {
      // External stream provided (e.g., from clone) - no fast path
      this.bodySource = bodySource;
      this.nativeHandleAvailable = false;
    } else if (this.inlineBody !== null) {
      // Inline body provided by native layer
      this.bodySource = null;
      this.nativeHandleAvailable = false;
    } else if (this.payload.bodyHandle !== null) {
      // Defer stream creation - we might use fast path instead
      this.bodySource = null;
      this.nativeHandleAvailable = true;
      this.nativeHandle = { id: this.payload.bodyHandle, released: false };
      bodyHandleFinalizer?.register(this, this.nativeHandle, this.nativeHandle);
    } else {
      this.bodySource = null;
      this.nativeHandleAvailable = false;
    }

    this.bodyStream = undefined;
  }

  get redirected(): boolean {
    if (this.redirectedMemo !== undefined) {
      return this.redirectedMemo;
    }

    if (this.url === this.requestUrl) {
      this.redirectedMemo = false;
      return false;
    }

    const normalizedRequestUrl = normalizeUrlForComparison(this.requestUrl);
    this.redirectedMemo = normalizedRequestUrl ? this.url !== normalizedRequestUrl : true;
    return this.redirectedMemo;
  }

  get statusText(): string {
    return STATUS_CODES[this.status] ?? "";
  }

  get headers(): Headers {
    if (!this.headersInstance) {
      this.headersInstance = new Headers(this.headersInit);
    }
    return this.headersInstance;
  }

  get cookies(): Record<string, string | string[]> {
    if (!this.cookiesRecord) {
      const record: Record<string, string | string[]> = Object.create(null);
      for (const [name, value] of this.cookiesInit) {
        const existing = record[name];
        if (existing === undefined) {
          record[name] = value;
        } else if (Array.isArray(existing)) {
          existing.push(value);
        } else {
          record[name] = [existing, value];
        }
      }
      this.cookiesRecord = record;
    }

    return this.cookiesRecord;
  }

  get body(): ReadableStream<Uint8Array> | null {
    if (this.inlineBody && this.bodySource === null) {
      const bytes = this.inlineBody;
      this.inlineBody = null;
      this.bodySource = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    }

    if (this.inlineBody === null && this.payload.bodyHandle === null && this.bodySource === null) {
      return null;
    }

    // Lazily create the stream if needed (disables fast path)
    if (this.bodySource === null && this.nativeHandleAvailable && this.payload.bodyHandle !== null) {
      if (this.nativeHandle) {
        bodyHandleFinalizer?.unregister(this.nativeHandle);
      }
      const handle = this.nativeHandle ?? { id: this.payload.bodyHandle, released: false };
      this.nativeHandle = handle;
      this.bodySource = createNativeBodyStream(handle);
      this.nativeHandleAvailable = false;
    }

    if (this.bodySource === null) {
      return null;
    }

    if (this.bodyStream === undefined) {
      this.bodyStream = wrapBodyStream(this.bodySource, () => {
        this.bodyUsed = true;
      });
    }

    return this.bodyStream;
  }

  async json<T = unknown>(): Promise<T> {
    const text = await this.text();
    return JSON.parse(text) as T;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await this.consumeBody();
    const { buffer, byteOffset, byteLength } = bytes;

    if (buffer instanceof ArrayBuffer) {
      // Zero-copy when the Buffer owns the entire ArrayBuffer.
      if (byteOffset === 0 && byteLength === buffer.byteLength) {
        return buffer;
      }
      return buffer.slice(byteOffset, byteOffset + byteLength);
    }

    const view = new Uint8Array(byteLength);
    view.set(bytes);
    return view.buffer;
  }

  async text(): Promise<string> {
    const bytes = await this.consumeBody();
    return UTF8_DECODER.decode(bytes);
  }

  async blob(): Promise<Blob> {
    const bytes = await this.consumeBody();
    const contentType = this.headers.get("content-type") ?? "";
    return new Blob([bytes], contentType ? { type: contentType } : undefined);
  }

  async formData(): Promise<FormData> {
    const bytes = await this.consumeBody();
    const contentType = this.headers.get("content-type");
    const response = new globalThis.Response(
      bytes,
      contentType ? { headers: { "content-type": contentType } } : undefined,
    );
    return response.formData();
  }

  readable(): Readable {
    this.assertBodyAvailable();
    this.bodyUsed = true;

    const stream = this.body;

    if (stream === null) {
      return Readable.from([]);
    }

    return Readable.fromWeb(stream as ReadableStream);
  }

  clone(): Response {
    if (this.bodyUsed) {
      throw new TypeError("Cannot clone a Response whose body is already used");
    }

    // If we still have the native handle (fast path), we need to create the stream first
    if (this.nativeHandleAvailable && this.payload.bodyHandle !== null) {
      if (this.nativeHandle) {
        bodyHandleFinalizer?.unregister(this.nativeHandle);
      }
      const handle = this.nativeHandle ?? { id: this.payload.bodyHandle, released: false };
      this.nativeHandle = handle;
      this.bodySource = createNativeBodyStream(handle);
      this.nativeHandleAvailable = false;
    }

    if (this.bodySource === null) {
      return new Response(cloneNativeResponse(this.payload), this.requestUrl, null);
    }

    const [branchA, branchB] = this.bodySource.tee();

    // Reset cached stream so the original response uses the new branch lazily.
    this.bodySource = branchA;
    this.bodyStream = undefined;

    return new Response(cloneNativeResponse(this.payload), this.requestUrl, branchB);
  }

  private assertBodyAvailable(): void {
    if (this.bodyUsed) {
      throw new TypeError("Response body is already used");
    }
  }

  private async consumeBody(): Promise<Buffer> {
    this.assertBodyAvailable();
    this.bodyUsed = true;

    if (this.inlineBody) {
      const bytes = this.inlineBody;
      this.inlineBody = null;
      return bytes;
    }

    // Fast path: if native handle is still available, read entire body in one Rust call
    if (this.nativeHandleAvailable && this.payload.bodyHandle !== null) {
      this.nativeHandleAvailable = false;
      try {
        return await nativeBinding.readBodyAll(this.payload.bodyHandle);
      } catch (error) {
        // Handle already consumed or error
        if (String(error).includes("Body handle") && String(error).includes("not found")) {
          return Buffer.alloc(0);
        }
        throw error;
      } finally {
        if (this.nativeHandle) {
          markNativeBodyReleased(this.nativeHandle);
        }
      }
    }

    // Slow path: stream was accessed, use streaming consumption
    const stream = this.body;
    if (!stream) {
      return Buffer.alloc(0);
    }

    const reader = stream.getReader();
    const chunks: Buffer[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        if (value && value.byteLength > 0) {
          if (Buffer.isBuffer(value)) {
            chunks.push(value);
          } else {
            chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
          }
        }
      }
    } finally {
      // reader.releaseLock() is unnecessary here; letting the stream close naturally
      // ensures the underlying native handle is released.
    }

    return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks);
  }
}

export class Transport {
  readonly id: string;
  private disposed = false;

  constructor(id: string) {
    this.id = id;
  }

  get closed(): boolean {
    return this.disposed;
  }

  async close(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;

    try {
      nativeBinding.dropTransport(this.id);
    } catch (error) {
      throw new RequestError(String(error));
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

  /** @internal */
  getDefaults(): SessionDefaults {
    const snapshot: SessionDefaults = { ...this.defaults };
    if (this.defaults.defaultHeaders) {
      snapshot.defaultHeaders = [...this.defaults.defaultHeaders];
    }
    return snapshot;
  }

  /** @internal */
  _defaultsRef(): SessionDefaults {
    return this.defaults;
  }

  async fetch(input: string | URL | Request, init?: WreqRequestInit): Promise<Response> {
    this.ensureActive();
    const config: WreqRequestInit = init ? { ...init, session: this } : { session: this };
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

  getCookies(url: string | URL): Record<string, string> {
    this.ensureActive();
    try {
      return nativeBinding.getCookies(this.id, String(url));
    } catch (error) {
      throw new RequestError(String(error));
    }
  }

  setCookie(name: string, value: string, url: string | URL): void {
    this.ensureActive();
    try {
      nativeBinding.setCookie(this.id, name, value, String(url));
    } catch (error) {
      throw new RequestError(String(error));
    }
  }

  /**
   * Create a WebSocket connection that shares this session's cookies and TLS configuration.
   *
   * @param urlOrOptions - WebSocket URL or legacy options object
   * @param options - Session WebSocket options
   * @returns Promise that resolves to the WebSocket instance
   */
  async websocket(url: string | URL, options?: SessionWebSocketOptions): Promise<WebSocket>;
  async websocket(options: LegacySessionWebSocketOptions): Promise<WebSocket>;
  async websocket(
    urlOrOptions: string | URL | LegacySessionWebSocketOptions,
    options?: SessionWebSocketOptions,
  ): Promise<WebSocket> {
    this.ensureActive();

    const normalized = normalizeSessionWebSocketArgs(urlOrOptions, options);
    validateWebSocketProtocols(normalized.options.protocols);
    assertNoManualWebSocketProtocolHeader(normalized.options.headers);
    const protocols = normalizeWebSocketProtocolList(normalized.options.protocols);

    const transportId = this.defaults.transportId;
    if (!transportId) {
      throw new RequestError(
        "Session has no transport. Create the session with browser/os options or pass a transport to use session.websocket().",
      );
    }

    return WebSocket._connectWithInit({
      _internal: true,
      url: normalized.url,
      options: normalized.options,
      openDispatchMode: "deferred",
      connect: (callbacks) =>
        nativeBinding.websocketConnectSession({
          url: normalized.url,
          sessionId: this.id,
          transportId,
          headers: headersToTuples(normalized.options.headers ?? {}),
          ...(protocols && protocols.length > 0 && { protocols }),
          onMessage: callbacks.onMessage,
          onClose: callbacks.onClose,
          onError: callbacks.onError,
        }),
      legacyCallbacks: normalized.legacyCallbacks,
    });
  }

  async close(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    const transportId = this.defaults.transportId;
    const ownsTransport = this.defaults.ownsTransport;

    try {
      nativeBinding.dropSession(this.id);
    } catch (error) {
      if (!ownsTransport || !transportId) {
        throw new RequestError(String(error));
      }
      // Fall through to transport cleanup and surface the original error after.
      const originalError = error;
      try {
        nativeBinding.dropTransport(transportId);
      } catch {
        // Ignore transport cleanup errors when a session drop error already occurred.
      }
      throw new RequestError(String(originalError));
    }

    if (ownsTransport && transportId) {
      try {
        nativeBinding.dropTransport(transportId);
      } catch (error) {
        throw new RequestError(String(error));
      }
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
      defaults: sessionCandidate._defaultsRef(),
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
    sessionId: generateEphemeralSessionId(),
    cookieMode: "ephemeral",
    dropAfterRequest: true,
  };
}

function resolveTransportContext(config: WreqRequestInit, sessionDefaults?: SessionDefaults): TransportResolution {
  if (config.transport !== undefined) {
    if (!(config.transport instanceof Transport)) {
      throw new RequestError("`transport` must be created via createTransport()");
    }

    if (config.transport.closed) {
      throw new RequestError("Transport has been closed");
    }

    const hasProxy = config.proxy !== undefined;
    if (
      config.browser !== undefined ||
      config.os !== undefined ||
      config.emulation !== undefined ||
      hasProxy ||
      config.insecure !== undefined
    ) {
      throw new RequestError("`transport` cannot be combined with browser/os/emulation/proxy/insecure options");
    }

    return { transportId: config.transport.id };
  }

  if (sessionDefaults?.transportId) {
    if (config.emulation !== undefined) {
      throw new RequestError("Session emulation cannot be changed after creation");
    }

    if (config.browser !== undefined) {
      validateBrowserProfile(config.browser);
      const lockedBrowser =
        sessionDefaults.transportMode.kind === "custom" ? undefined : sessionDefaults.transportMode.browser;
      if (config.browser !== lockedBrowser) {
        throw new RequestError("Session browser cannot be changed after creation");
      }
    }

    if (config.os !== undefined) {
      validateOperatingSystem(config.os);
      const lockedOs = sessionDefaults.transportMode.kind === "custom" ? undefined : sessionDefaults.transportMode.os;
      if (config.os !== lockedOs) {
        throw new RequestError("Session operating system cannot be changed after creation");
      }
    }

    const initHasProxy = Object.hasOwn(config as object, "proxy");
    const requestedProxy = initHasProxy ? (config as { proxy?: string | null }).proxy : undefined;
    if (initHasProxy && requestedProxy !== undefined && (sessionDefaults.proxy ?? null) !== (requestedProxy ?? null)) {
      throw new RequestError("Session proxy cannot be changed after creation");
    }

    if (config.insecure !== undefined) {
      const lockedInsecure = sessionDefaults.insecure ?? false;
      if (config.insecure !== lockedInsecure) {
        throw new RequestError("Session insecure setting cannot be changed after creation");
      }
    }

    return { transportId: sessionDefaults.transportId };
  }

  const resolved: TransportResolution = {
    mode: resolveEmulationMode(config.browser, config.os, config.emulation),
  };
  if (config.proxy !== undefined) {
    resolved.proxy = config.proxy;
  }
  if (config.insecure !== undefined) {
    resolved.insecure = config.insecure;
  }
  return resolved;
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
    const error = new Error(reason.message);
    error.name = "AbortError";
    error.cause = reason;
    return error;
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

// Request IDs must stay below 2^48 to preserve integer precision across the bridge.
const REQUEST_ID_MAX = 2 ** 48;
// Seed with a monotonic-ish value derived from hrtime to avoid collisions after reloads.
let requestIdCounter = Math.trunc(Number(process.hrtime.bigint() % BigInt(REQUEST_ID_MAX - 1))) + 1;

function generateRequestId(): number {
  requestIdCounter += 1;
  if (requestIdCounter >= REQUEST_ID_MAX) {
    requestIdCounter = 1;
  }

  return requestIdCounter;
}

function setupAbort(signal: AbortSignal | null | undefined, cancelNative: () => void): AbortHandler | null {
  if (!signal) {
    return null;
  }

  if (signal.aborted) {
    cancelNative();
    throw createAbortError(signal.reason);
  }

  let onAbortListener: (() => void) | undefined;

  const promise = new Promise<never>((_, reject) => {
    onAbortListener = () => {
      cancelNative();
      reject(createAbortError(signal.reason));
    };

    signal.addEventListener("abort", onAbortListener, { once: true });
  });

  const cleanup = () => {
    if (onAbortListener) {
      signal.removeEventListener("abort", onAbortListener);
      onAbortListener = undefined;
    }
  };

  return { promise, cleanup };
}

function coerceUrlInput(input: string | URL): string {
  if (input instanceof URL) {
    return input.href;
  }

  if (input.length === 0) {
    throw new RequestError("URL is required");
  }

  // Fast path: skip trim when the string has no leading/trailing whitespace.
  if (input.charCodeAt(0) > 32 && input.charCodeAt(input.length - 1) > 32) {
    return input;
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new RequestError("URL is required");
  }

  return trimmed;
}

type RequestLike = {
  url: string;
  method: string;
  headers: globalThis.Headers;
  signal: AbortSignal | null;
  redirect: string;
  bodyUsed: boolean;
  body: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
};

function isRequestLike(input: unknown): input is RequestLike {
  if (!input || typeof input !== "object") {
    return false;
  }

  if (typeof Request !== "undefined" && input instanceof Request) {
    return true;
  }

  const candidate = input as Partial<RequestLike>;
  return (
    typeof candidate.url === "string" &&
    typeof candidate.method === "string" &&
    typeof candidate.arrayBuffer === "function" &&
    typeof candidate.redirect === "string"
  );
}

async function resolveFetchArgs(
  input: string | URL | RequestLike,
  init?: WreqRequestInit,
): Promise<{
  url: string;
  init: WreqRequestInit;
}> {
  if (!isRequestLike(input)) {
    return { url: coerceUrlInput(input), init: init ?? {} };
  }

  const mergedInit: WreqRequestInit = init ? { ...init } : {};

  if (mergedInit.method === undefined) {
    mergedInit.method = input.method;
  }
  if (mergedInit.headers === undefined) {
    mergedInit.headers = input.headers as unknown as HeadersInit;
  }
  if (
    mergedInit.redirect === undefined &&
    (input.redirect === "follow" || input.redirect === "manual" || input.redirect === "error")
  ) {
    mergedInit.redirect = input.redirect;
  }
  if (mergedInit.signal === undefined) {
    mergedInit.signal = input.signal;
  }
  if (mergedInit.body === undefined && input.body !== null) {
    if (input.bodyUsed) {
      throw new TypeError("Request body is already used");
    }
    mergedInit.body = Buffer.from(await input.arrayBuffer());
  }

  return { url: coerceUrlInput(input.url), init: mergedInit };
}

function normalizeUrlForComparison(value: string): string | null {
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

function validateRedirectMode(mode?: WreqRequestInit["redirect"]): void {
  if (mode === undefined || mode === "follow" || mode === "manual" || mode === "error") {
    return;
  }

  throw new RequestError(`Redirect mode '${mode}' is not supported`);
}

type SerializedBody = {
  body?: Buffer;
  contentType?: string;
};

async function serializeBody(body?: BodyInit | null): Promise<SerializedBody> {
  if (body === null || body === undefined) {
    return {};
  }

  if (typeof body === "string") {
    return { body: Buffer.from(body, "utf8") };
  }

  if (Buffer.isBuffer(body)) {
    return { body };
  }

  if (body instanceof URLSearchParams) {
    return {
      body: Buffer.from(body.toString(), "utf8"),
      contentType: "application/x-www-form-urlencoded;charset=UTF-8",
    };
  }

  if (body instanceof ArrayBuffer) {
    return { body: Buffer.from(body) };
  }

  if (ArrayBuffer.isView(body)) {
    return { body: Buffer.from(body.buffer, body.byteOffset, body.byteLength) };
  }

  if (typeof Blob !== "undefined" && body instanceof Blob) {
    const buffer = Buffer.from(await body.arrayBuffer());
    return { body: buffer, ...(body.type ? { contentType: body.type } : {}) };
  }

  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const encoded = new globalThis.Response(body);
    const contentType = encoded.headers.get("content-type") ?? undefined;
    const buffer = Buffer.from(await encoded.arrayBuffer());
    return { body: buffer, ...(contentType ? { contentType } : {}) };
  }

  throw new TypeError(
    "Unsupported body type; expected string, Buffer, ArrayBuffer, ArrayBufferView, URLSearchParams, Blob, or FormData",
  );
}

function ensureMethod(method?: string): string {
  if (method === undefined || method.length === 0) {
    return "GET";
  }

  // Fast path: common methods already in canonical form (avoids trim + toUpperCase).
  switch (method) {
    case "GET":
    case "POST":
    case "PUT":
    case "DELETE":
    case "PATCH":
    case "HEAD":
    case "OPTIONS":
      return method;
  }

  const normalized = method.trim().toUpperCase();
  return normalized.length > 0 ? normalized : "GET";
}

function ensureBodyAllowed(method: string, body?: Buffer): void {
  if (body === undefined) {
    return;
  }

  if (method === "GET" || method === "HEAD") {
    throw new RequestError(`Request with ${method} method cannot have a body`);
  }
}

function validateBrowserProfile(browser?: BrowserProfile | string): void {
  if (browser === undefined) {
    return;
  }

  if (typeof browser !== "string" || browser.trim().length === 0) {
    throw new RequestError("Browser profile must not be empty");
  }

  if (!getProfileSet().has(browser)) {
    throw new RequestError(`Invalid browser profile: ${browser}. Available profiles: ${getProfiles().join(", ")}`);
  }
}

function validateOperatingSystem(os?: EmulationOS | string): void {
  if (os === undefined) {
    return;
  }

  if (typeof os !== "string" || os.trim().length === 0) {
    throw new RequestError("Operating system must not be empty");
  }

  if (!getOperatingSystemSet().has(os)) {
    throw new RequestError(`Invalid operating system: ${os}. Available options: ${getOperatingSystems().join(", ")}`);
  }
}

function validateTimeout(timeout?: number): void {
  if (timeout === undefined) {
    return;
  }

  if (typeof timeout !== "number" || !Number.isFinite(timeout)) {
    throw new RequestError("Timeout must be a finite number");
  }

  if (timeout < 0) {
    throw new RequestError("Timeout must be 0 (no timeout) or a positive number");
  }
}

function validatePositiveNumber(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RequestError(`${label} must be a finite number`);
  }

  if (value <= 0) {
    throw new RequestError(`${label} must be greater than 0`);
  }
}

function validateNonNegativeInteger(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RequestError(`${label} must be an integer`);
  }

  if (value < 0) {
    throw new RequestError(`${label} must be greater than or equal to 0`);
  }
}

function validatePositiveInteger(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RequestError(`${label} must be an integer`);
  }

  if (value <= 0) {
    throw new RequestError(`${label} must be greater than 0`);
  }
}

function validateIntegerInRange(value: number, min: number, max: number, label: string): void {
  validateNonNegativeInteger(value, label);
  if (value < min || value > max) {
    throw new RequestError(`${label} must be between ${min} and ${max}`);
  }
}

const SUPPORTED_ALPN_PROTOCOLS = new Set<AlpnProtocol>(["HTTP1", "HTTP2", "HTTP3"]);
const SUPPORTED_ALPS_PROTOCOLS = new Set<AlpsProtocol>(["HTTP1", "HTTP2", "HTTP3"]);
const SUPPORTED_CERTIFICATE_COMPRESSION_ALGORITHMS = new Set(["zlib", "brotli", "zstd"]);
const HTTP2_SETTING_IDS = new Set<Http2SettingId>([
  "HeaderTableSize",
  "EnablePush",
  "MaxConcurrentStreams",
  "InitialWindowSize",
  "MaxFrameSize",
  "MaxHeaderListSize",
  "EnableConnectProtocol",
  "NoRfc7540Priorities",
]);
const HTTP2_PSEUDO_HEADER_IDS = new Set<Http2PseudoHeaderId>(["Method", "Scheme", "Authority", "Path", "Protocol"]);
const STANDARD_HTTP2_SETTING_ID_VALUES = new Set([1, 2, 3, 4, 5, 6, 8, 9]);
const MAX_HTTP2_EXPERIMENTAL_SETTING_ID = 15;
const TLS_VERSION_ALIASES = new Map<string, "1.0" | "1.1" | "1.2" | "1.3">([
  ["1.0", "1.0"],
  ["1.1", "1.1"],
  ["1.2", "1.2"],
  ["1.3", "1.3"],
  ["tls1.0", "1.0"],
  ["tls1.1", "1.1"],
  ["tls1.2", "1.2"],
  ["tls1.3", "1.3"],
]);

function isNonEmpty(value: object): boolean {
  for (const _ in value) return true;
  return false;
}

function normalizeProtocolList<T extends AlpnProtocol | AlpsProtocol>(
  value: T[] | undefined,
  label: string,
  allowed: Set<T>,
): T[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new RequestError(`${label} must be an array`);
  }

  for (const protocol of value) {
    if (!allowed.has(protocol)) {
      throw new RequestError(`${label} values must be one of: HTTP1, HTTP2, HTTP3`);
    }
  }

  return [...value];
}

function normalizeTlsVersion(value: TlsVersion | undefined, label: string): "1.0" | "1.1" | "1.2" | "1.3" | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new RequestError(`${label} must be a string`);
  }

  const normalized = TLS_VERSION_ALIASES.get(value.trim().toLowerCase());
  if (!normalized) {
    throw new RequestError(`${label} must be one of: 1.0, 1.1, 1.2, 1.3`);
  }

  return normalized;
}

function normalizeOrigHeaders(origHeaders: string[] | undefined): string[] | undefined {
  if (origHeaders === undefined) {
    return undefined;
  }

  if (!Array.isArray(origHeaders)) {
    throw new RequestError("emulation.origHeaders must be an array of strings");
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const entry of origHeaders) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new RequestError("emulation.origHeaders entries must be non-empty strings");
    }

    const trimmed = entry.trim();
    const duplicateKey = trimmed.toLowerCase();
    if (seen.has(duplicateKey)) {
      throw new RequestError(`Duplicate emulation.origHeaders entry: ${trimmed}`);
    }

    seen.add(duplicateKey);
    normalized.push(trimmed);
  }

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeCustomTlsOptions(options: CustomTlsOptions | undefined): CustomTlsOptions | undefined {
  if (options === undefined) {
    return undefined;
  }

  const normalized: CustomTlsOptions = {};

  const alpnProtocols = normalizeProtocolList(
    options.alpnProtocols,
    "emulation.tlsOptions.alpnProtocols",
    SUPPORTED_ALPN_PROTOCOLS,
  );
  if (alpnProtocols !== undefined) {
    normalized.alpnProtocols = alpnProtocols;
  }

  const alpsProtocols = normalizeProtocolList(
    options.alpsProtocols,
    "emulation.tlsOptions.alpsProtocols",
    SUPPORTED_ALPS_PROTOCOLS,
  );
  if (alpsProtocols !== undefined) {
    normalized.alpsProtocols = alpsProtocols;
  }

  const minTlsVersion = normalizeTlsVersion(options.minTlsVersion, "emulation.tlsOptions.minTlsVersion");
  if (minTlsVersion !== undefined) {
    normalized.minTlsVersion = minTlsVersion;
  }

  const maxTlsVersion = normalizeTlsVersion(options.maxTlsVersion, "emulation.tlsOptions.maxTlsVersion");
  if (maxTlsVersion !== undefined) {
    normalized.maxTlsVersion = maxTlsVersion;
  }

  if (options.alpsUseNewCodepoint !== undefined) {
    normalized.alpsUseNewCodepoint = options.alpsUseNewCodepoint;
  }
  if (options.sessionTicket !== undefined) {
    normalized.sessionTicket = options.sessionTicket;
  }
  if (options.preSharedKey !== undefined) {
    normalized.preSharedKey = options.preSharedKey;
  }
  if (options.enableEchGrease !== undefined) {
    normalized.enableEchGrease = options.enableEchGrease;
  }
  if (options.permuteExtensions !== undefined) {
    normalized.permuteExtensions = options.permuteExtensions;
  }
  if (options.greaseEnabled !== undefined) {
    normalized.greaseEnabled = options.greaseEnabled;
  }
  if (options.enableOcspStapling !== undefined) {
    normalized.enableOcspStapling = options.enableOcspStapling;
  }
  if (options.enableSignedCertTimestamps !== undefined) {
    normalized.enableSignedCertTimestamps = options.enableSignedCertTimestamps;
  }
  if (options.pskSkipSessionTicket !== undefined) {
    normalized.pskSkipSessionTicket = options.pskSkipSessionTicket;
  }
  if (options.pskDheKe !== undefined) {
    normalized.pskDheKe = options.pskDheKe;
  }
  if (options.renegotiation !== undefined) {
    normalized.renegotiation = options.renegotiation;
  }
  if (options.aesHwOverride !== undefined) {
    normalized.aesHwOverride = options.aesHwOverride;
  }
  if (options.preserveTls13CipherList !== undefined) {
    normalized.preserveTls13CipherList = options.preserveTls13CipherList;
  }
  if (options.randomAesHwOverride !== undefined) {
    normalized.randomAesHwOverride = options.randomAesHwOverride;
  }
  if (options.delegatedCredentials !== undefined) {
    normalized.delegatedCredentials = options.delegatedCredentials;
  }
  if (options.curvesList !== undefined) {
    normalized.curvesList = options.curvesList;
  }
  if (options.cipherList !== undefined) {
    normalized.cipherList = options.cipherList;
  }
  if (options.sigalgsList !== undefined) {
    normalized.sigalgsList = options.sigalgsList;
  }

  if (options.recordSizeLimit !== undefined) {
    validateIntegerInRange(options.recordSizeLimit, 0, 65535, "emulation.tlsOptions.recordSizeLimit");
    normalized.recordSizeLimit = options.recordSizeLimit;
  }

  if (options.keySharesLimit !== undefined) {
    validateIntegerInRange(options.keySharesLimit, 0, 255, "emulation.tlsOptions.keySharesLimit");
    normalized.keySharesLimit = options.keySharesLimit;
  }

  if (options.certificateCompressionAlgorithms !== undefined) {
    if (!Array.isArray(options.certificateCompressionAlgorithms)) {
      throw new RequestError("emulation.tlsOptions.certificateCompressionAlgorithms must be an array");
    }

    const algorithms: Array<"zlib" | "brotli" | "zstd"> = [];
    const seen = new Set<string>();

    for (const algorithm of options.certificateCompressionAlgorithms) {
      if (!SUPPORTED_CERTIFICATE_COMPRESSION_ALGORITHMS.has(algorithm)) {
        throw new RequestError(
          "emulation.tlsOptions.certificateCompressionAlgorithms values must be one of: zlib, brotli, zstd",
        );
      }
      if (seen.has(algorithm)) {
        throw new RequestError(`Duplicate emulation.tlsOptions.certificateCompressionAlgorithms entry: ${algorithm}`);
      }
      seen.add(algorithm);
      algorithms.push(algorithm);
    }

    normalized.certificateCompressionAlgorithms = algorithms;
  }

  if (options.extensionPermutation !== undefined) {
    if (!Array.isArray(options.extensionPermutation)) {
      throw new RequestError("emulation.tlsOptions.extensionPermutation must be an array");
    }

    const permutation: number[] = [];
    const seen = new Set<number>();

    for (const extensionId of options.extensionPermutation) {
      validateIntegerInRange(extensionId, 0, 65535, "emulation.tlsOptions.extensionPermutation");
      if (seen.has(extensionId)) {
        throw new RequestError(`Duplicate emulation.tlsOptions.extensionPermutation entry: ${extensionId}`);
      }
      seen.add(extensionId);
      permutation.push(extensionId);
    }

    normalized.extensionPermutation = permutation;
  }

  return isNonEmpty(normalized) ? normalized : undefined;
}

function normalizeCustomHttp1Options(options: CustomHttp1Options | undefined): CustomHttp1Options | undefined {
  if (options === undefined) {
    return undefined;
  }

  const normalized: CustomHttp1Options = {};

  if (options.http09Responses !== undefined) {
    normalized.http09Responses = options.http09Responses;
  }
  if (options.writev !== undefined) {
    normalized.writev = options.writev;
  }
  if (options.ignoreInvalidHeadersInResponses !== undefined) {
    normalized.ignoreInvalidHeadersInResponses = options.ignoreInvalidHeadersInResponses;
  }
  if (options.allowSpacesAfterHeaderNameInResponses !== undefined) {
    normalized.allowSpacesAfterHeaderNameInResponses = options.allowSpacesAfterHeaderNameInResponses;
  }
  if (options.allowObsoleteMultilineHeadersInResponses !== undefined) {
    normalized.allowObsoleteMultilineHeadersInResponses = options.allowObsoleteMultilineHeadersInResponses;
  }

  if (options.maxHeaders !== undefined) {
    validateNonNegativeInteger(options.maxHeaders, "emulation.http1Options.maxHeaders");
    normalized.maxHeaders = options.maxHeaders;
  }

  if (options.readBufExactSize !== undefined) {
    validateNonNegativeInteger(options.readBufExactSize, "emulation.http1Options.readBufExactSize");
    normalized.readBufExactSize = options.readBufExactSize;
  }

  if (options.maxBufSize !== undefined) {
    validateNonNegativeInteger(options.maxBufSize, "emulation.http1Options.maxBufSize");
    if (options.maxBufSize < 8192) {
      throw new RequestError("emulation.http1Options.maxBufSize must be greater than or equal to 8192");
    }
    normalized.maxBufSize = options.maxBufSize;
  }

  if (normalized.readBufExactSize !== undefined && normalized.maxBufSize !== undefined) {
    throw new RequestError("emulation.http1Options.readBufExactSize and maxBufSize cannot both be set");
  }

  return isNonEmpty(normalized) ? normalized : undefined;
}

function normalizeHttp2StreamDependency(dependency: Http2StreamDependency, label: string): Http2StreamDependency {
  if (!isPlainObject(dependency)) {
    throw new RequestError(`${label} must be an object`);
  }

  validateIntegerInRange(dependency.dependencyId, 0, 0x7fffffff, `${label}.dependencyId`);
  validateIntegerInRange(dependency.weight, 0, 255, `${label}.weight`);

  const normalized: Http2StreamDependency = {
    dependencyId: dependency.dependencyId,
    weight: dependency.weight,
  };
  if (dependency.exclusive !== undefined) {
    normalized.exclusive = dependency.exclusive;
  }
  return normalized;
}

function normalizeCustomHttp2Options(options: CustomHttp2Options | undefined): CustomHttp2Options | undefined {
  if (options === undefined) {
    return undefined;
  }

  const normalized: CustomHttp2Options = {};

  if (options.adaptiveWindow !== undefined) {
    normalized.adaptiveWindow = options.adaptiveWindow;
  }
  if (options.keepAliveWhileIdle !== undefined) {
    normalized.keepAliveWhileIdle = options.keepAliveWhileIdle;
  }
  if (options.enablePush !== undefined) {
    normalized.enablePush = options.enablePush;
  }
  if (options.enableConnectProtocol !== undefined) {
    normalized.enableConnectProtocol = options.enableConnectProtocol;
  }
  if (options.noRfc7540Priorities !== undefined) {
    normalized.noRfc7540Priorities = options.noRfc7540Priorities;
  }

  if (options.initialStreamId !== undefined) {
    validateNonNegativeInteger(options.initialStreamId, "emulation.http2Options.initialStreamId");
    normalized.initialStreamId = options.initialStreamId;
  }
  if (options.initialConnectionWindowSize !== undefined) {
    validateNonNegativeInteger(
      options.initialConnectionWindowSize,
      "emulation.http2Options.initialConnectionWindowSize",
    );
    normalized.initialConnectionWindowSize = options.initialConnectionWindowSize;
  }
  if (options.initialWindowSize !== undefined) {
    validateNonNegativeInteger(options.initialWindowSize, "emulation.http2Options.initialWindowSize");
    normalized.initialWindowSize = options.initialWindowSize;
  }
  if (options.initialMaxSendStreams !== undefined) {
    validateNonNegativeInteger(options.initialMaxSendStreams, "emulation.http2Options.initialMaxSendStreams");
    normalized.initialMaxSendStreams = options.initialMaxSendStreams;
  }
  if (options.maxFrameSize !== undefined) {
    validateNonNegativeInteger(options.maxFrameSize, "emulation.http2Options.maxFrameSize");
    normalized.maxFrameSize = options.maxFrameSize;
  }
  if (options.keepAliveInterval !== undefined) {
    validateNonNegativeInteger(options.keepAliveInterval, "emulation.http2Options.keepAliveInterval");
    normalized.keepAliveInterval = options.keepAliveInterval;
  }
  if (options.keepAliveTimeout !== undefined) {
    validateNonNegativeInteger(options.keepAliveTimeout, "emulation.http2Options.keepAliveTimeout");
    normalized.keepAliveTimeout = options.keepAliveTimeout;
  }
  if (options.maxConcurrentResetStreams !== undefined) {
    validateNonNegativeInteger(options.maxConcurrentResetStreams, "emulation.http2Options.maxConcurrentResetStreams");
    normalized.maxConcurrentResetStreams = options.maxConcurrentResetStreams;
  }
  if (options.maxSendBufferSize !== undefined) {
    validateNonNegativeInteger(options.maxSendBufferSize, "emulation.http2Options.maxSendBufferSize");
    normalized.maxSendBufferSize = options.maxSendBufferSize;
  }
  if (options.maxConcurrentStreams !== undefined) {
    validateNonNegativeInteger(options.maxConcurrentStreams, "emulation.http2Options.maxConcurrentStreams");
    normalized.maxConcurrentStreams = options.maxConcurrentStreams;
  }
  if (options.maxHeaderListSize !== undefined) {
    validateNonNegativeInteger(options.maxHeaderListSize, "emulation.http2Options.maxHeaderListSize");
    normalized.maxHeaderListSize = options.maxHeaderListSize;
  }
  if (options.maxPendingAcceptResetStreams !== undefined) {
    validateNonNegativeInteger(
      options.maxPendingAcceptResetStreams,
      "emulation.http2Options.maxPendingAcceptResetStreams",
    );
    normalized.maxPendingAcceptResetStreams = options.maxPendingAcceptResetStreams;
  }
  if (options.headerTableSize !== undefined) {
    validateNonNegativeInteger(options.headerTableSize, "emulation.http2Options.headerTableSize");
    normalized.headerTableSize = options.headerTableSize;
  }

  if (options.settingsOrder !== undefined) {
    if (!Array.isArray(options.settingsOrder)) {
      throw new RequestError("emulation.http2Options.settingsOrder must be an array");
    }

    const settingsOrder: Http2SettingId[] = [];
    const seen = new Set<Http2SettingId>();
    for (const settingId of options.settingsOrder) {
      if (!HTTP2_SETTING_IDS.has(settingId)) {
        throw new RequestError("emulation.http2Options.settingsOrder contains an unsupported setting id");
      }
      if (seen.has(settingId)) {
        throw new RequestError(`Duplicate emulation.http2Options.settingsOrder entry: ${settingId}`);
      }
      seen.add(settingId);
      settingsOrder.push(settingId);
    }
    normalized.settingsOrder = settingsOrder;
  }

  if (options.headersPseudoOrder !== undefined) {
    if (!Array.isArray(options.headersPseudoOrder)) {
      throw new RequestError("emulation.http2Options.headersPseudoOrder must be an array");
    }

    const headersPseudoOrder: Http2PseudoHeaderId[] = [];
    const seenPseudo = new Set<Http2PseudoHeaderId>();
    for (const pseudoId of options.headersPseudoOrder) {
      if (!HTTP2_PSEUDO_HEADER_IDS.has(pseudoId)) {
        throw new RequestError("emulation.http2Options.headersPseudoOrder contains an unsupported pseudo-header id");
      }
      if (seenPseudo.has(pseudoId)) {
        throw new RequestError(`Duplicate emulation.http2Options.headersPseudoOrder entry: ${pseudoId}`);
      }
      seenPseudo.add(pseudoId);
      headersPseudoOrder.push(pseudoId);
    }
    normalized.headersPseudoOrder = headersPseudoOrder;
  }

  if (options.headersStreamDependency !== undefined) {
    normalized.headersStreamDependency = normalizeHttp2StreamDependency(
      options.headersStreamDependency,
      "emulation.http2Options.headersStreamDependency",
    );
  }

  if (options.priorities !== undefined) {
    if (!Array.isArray(options.priorities)) {
      throw new RequestError("emulation.http2Options.priorities must be an array");
    }

    const priorities: Http2Priority[] = [];
    const seenStreamIds = new Set<number>();
    for (const [index, priority] of options.priorities.entries()) {
      if (!isPlainObject(priority)) {
        throw new RequestError(`emulation.http2Options.priorities[${index}] must be an object`);
      }

      validatePositiveInteger(priority.streamId, `emulation.http2Options.priorities[${index}].streamId`);
      if (seenStreamIds.has(priority.streamId)) {
        throw new RequestError(`Duplicate emulation.http2Options.priorities streamId: ${priority.streamId}`);
      }
      seenStreamIds.add(priority.streamId);

      priorities.push({
        streamId: priority.streamId,
        dependency: normalizeHttp2StreamDependency(
          priority.dependency,
          `emulation.http2Options.priorities[${index}].dependency`,
        ),
      });
    }
    normalized.priorities = priorities;
  }

  if (options.experimentalSettings !== undefined) {
    if (!Array.isArray(options.experimentalSettings)) {
      throw new RequestError("emulation.http2Options.experimentalSettings must be an array");
    }

    const experimentalSettings: Http2ExperimentalSetting[] = [];
    const seenIds = new Set<number>();

    for (const [index, setting] of options.experimentalSettings.entries()) {
      if (!isPlainObject(setting)) {
        throw new RequestError(`emulation.http2Options.experimentalSettings[${index}] must be an object`);
      }

      validateIntegerInRange(
        setting.id,
        1,
        MAX_HTTP2_EXPERIMENTAL_SETTING_ID,
        `emulation.http2Options.experimentalSettings[${index}].id`,
      );
      if (STANDARD_HTTP2_SETTING_ID_VALUES.has(setting.id)) {
        throw new RequestError(
          `emulation.http2Options.experimentalSettings[${index}].id must not be a standard HTTP/2 setting id`,
        );
      }
      if (seenIds.has(setting.id)) {
        throw new RequestError(`Duplicate emulation.http2Options.experimentalSettings id: ${setting.id}`);
      }
      seenIds.add(setting.id);

      validateIntegerInRange(
        setting.value,
        0,
        0xffffffff,
        `emulation.http2Options.experimentalSettings[${index}].value`,
      );

      experimentalSettings.push({
        id: setting.id,
        value: setting.value,
      });
    }

    normalized.experimentalSettings = experimentalSettings;
  }

  return isNonEmpty(normalized) ? normalized : undefined;
}

function normalizeCustomEmulationOptions(
  emulation: CustomEmulationOptions | undefined,
  allowEmpty: boolean,
): SerializedCustomEmulation | undefined {
  if (emulation === undefined) {
    return undefined;
  }

  if (!isPlainObject(emulation)) {
    throw new RequestError("emulation must be an object");
  }

  const source = emulation as Partial<CustomEmulationOptions>;
  const normalized: SerializedCustomEmulation = {};

  const tlsOptions = normalizeCustomTlsOptions(source.tlsOptions);
  if (tlsOptions !== undefined) {
    normalized.tlsOptions = tlsOptions;
  }

  const http1Options = normalizeCustomHttp1Options(source.http1Options);
  if (http1Options !== undefined) {
    normalized.http1Options = http1Options;
  }

  const http2Options = normalizeCustomHttp2Options(source.http2Options);
  if (http2Options !== undefined) {
    normalized.http2Options = http2Options;
  }

  if (source.headers !== undefined) {
    const headers = headersToTuples(source.headers);
    if (headers.length > 0) {
      normalized.headers = headers;
    }
  }

  const origHeaders = normalizeOrigHeaders(source.origHeaders);
  if (origHeaders !== undefined) {
    normalized.origHeaders = origHeaders;
  }

  if (!allowEmpty && !isNonEmpty(normalized)) {
    throw new RequestError(
      "Standalone custom emulation requires at least one of tlsOptions, http1Options, http2Options, headers, or origHeaders",
    );
  }

  return isNonEmpty(normalized) ? normalized : undefined;
}

function serializeCustomEmulationOptions(
  emulation: CustomEmulationOptions | undefined,
  allowEmpty: boolean,
): string | undefined {
  const normalized = normalizeCustomEmulationOptions(emulation, allowEmpty);
  return normalized ? JSON.stringify(normalized) : undefined;
}

function resolveEmulationMode(
  browser: BrowserProfile | undefined,
  os: EmulationOS | undefined,
  emulation: CustomEmulationOptions | undefined,
): ResolvedEmulationMode {
  if (browser !== undefined) {
    validateBrowserProfile(browser);
    if (os !== undefined) {
      validateOperatingSystem(os);
    }

    const emulationJson = serializeCustomEmulationOptions(emulation, true);
    return {
      kind: "preset",
      browser,
      os: os ?? DEFAULT_OS,
      ...(emulationJson !== undefined && { emulationJson }),
    };
  }

  if (os !== undefined) {
    validateOperatingSystem(os);
    const emulationJson = serializeCustomEmulationOptions(emulation, true);
    return {
      kind: "preset",
      browser: DEFAULT_BROWSER,
      os,
      ...(emulationJson !== undefined && { emulationJson }),
    };
  }

  if (emulation !== undefined) {
    const emulationJson = serializeCustomEmulationOptions(emulation, false);
    if (emulationJson === undefined) {
      throw new RequestError(
        "Standalone custom emulation requires at least one of tlsOptions, http1Options, http2Options, headers, or origHeaders",
      );
    }
    return { kind: "custom", emulationJson };
  }

  return {
    kind: "preset",
    browser: DEFAULT_BROWSER,
    os: DEFAULT_OS,
  };
}

function applyNativeEmulationMode(
  target: { browser?: BrowserProfile; os?: EmulationOS; emulationJson?: string },
  mode: ResolvedEmulationMode,
): void {
  if (mode.kind === "custom") {
    target.emulationJson = mode.emulationJson;
    return;
  }

  target.browser = mode.browser;
  target.os = mode.os;
  if (mode.emulationJson !== undefined) {
    target.emulationJson = mode.emulationJson;
  }
}

async function dispatchRequest(
  options: NativeRequestOptions,
  requestUrl: string,
  signal?: AbortSignal | null,
): Promise<Response> {
  // Fast path when no abort signal is provided: avoid Promise.race/allocation overhead.
  if (!signal) {
    const requestId = generateRequestId();
    let payload: NativeResponse;

    try {
      payload = (await nativeBinding.request(options, requestId, false)) as NativeResponse;
    } catch (error) {
      if (error instanceof RequestError) {
        throw error;
      }
      throw new RequestError(String(error));
    }

    return new Response(payload, requestUrl);
  }

  const requestId = generateRequestId();
  const cancelNative = () => {
    try {
      nativeBinding.cancelRequest(requestId);
    } catch {
      // Cancellation is best-effort; ignore binding errors here.
    }
  };

  // setupAbort throws if signal is already aborted and returns null only when signal is falsy
  // (impossible here since we checked `!signal` above). Cast is safe; avoids non-null assertion lint.
  const abortHandler = setupAbort(signal, cancelNative) as AbortHandler;

  const pending = Promise.race([nativeBinding.request(options, requestId, true), abortHandler.promise]);

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
    abortHandler.cleanup();
  }

  return new Response(payload, requestUrl);
}

/**
 * Fetch-compatible entry point that adds browser impersonation controls.
 *
 * **Important:** The default fetch path is isolated and non-persistent by design.
 * Each call uses an isolated request context, so cookies are not shared across calls.
 * Connection and TLS reuse behavior is handled by the native layer.
 *
 * **Use {@link createSession} or {@link withSession} if you need:**
 * - Cookie persistence across requests
 * - Shared session defaults across requests
 * - A single session context for multi-step flows
 *
 * **Concurrency:** The core is unthrottled by design. Callers are expected to implement
 * their own concurrency control (e.g., p-limit) if needed. Built-in throttling would
 * reduce performance for high-throughput workloads.
 *
 * @param input - Request URL (string or URL) or a Request object
 * @param init - Fetch-compatible init options
 *
 * @example
 * ```typescript
 * // Isolated request (no state persistence)
 * const response = await fetch('https://example.com');
 *
 * // For persistent cookies and connection reuse, use a session:
 * await withSession(async (session) => {
 *   await session.fetch('https://example.com/login', { method: 'POST', body: loginData });
 *   await session.fetch('https://example.com/protected'); // Cookies from login are sent
 * });
 * ```
 */
export async function fetch(input: string | URL | Request, init?: WreqRequestInit): Promise<Response> {
  const resolved = await resolveFetchArgs(input, init);
  const url = resolved.url;
  const config = resolved.init;
  const sessionContext = resolveSessionContext(config);
  const sessionDefaults = sessionContext.defaults;

  validateRedirectMode(config.redirect);

  if (config.timeout !== undefined) {
    validateTimeout(config.timeout);
  }

  const method = ensureMethod(config.method);
  const serializedBody = await serializeBody(config.body ?? null);
  const body = serializedBody.body;

  ensureBodyAllowed(method, body);

  // Only normalize headers when provided; avoids per-request header allocations on hot paths.
  // If the caller already provides HeaderTuple[], pass it through.
  let headerTuples = mergeHeaderTuples(sessionDefaults?.defaultHeaders, config.headers);
  if (serializedBody.contentType && !hasHeaderName(headerTuples, "content-type")) {
    if (!headerTuples) {
      headerTuples = [];
    }
    headerTuples.push(["Content-Type", serializedBody.contentType]);
  }

  const transport = resolveTransportContext(config, sessionDefaults);
  const timeout = config.timeout ?? sessionDefaults?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const requestOptions: NativeRequestOptions = {
    url,
    method,
    sessionId: sessionContext.sessionId,
    ephemeral: sessionContext.dropAfterRequest,
  };

  if (body !== undefined) {
    requestOptions.body = body;
  }

  if (transport.transportId) {
    requestOptions.transportId = transport.transportId;
  } else {
    if (transport.mode !== undefined) {
      applyNativeEmulationMode(requestOptions, transport.mode);
    }
    if (transport.proxy !== undefined) {
      requestOptions.proxy = transport.proxy;
    }
    if (transport.insecure !== undefined) {
      requestOptions.insecure = transport.insecure;
    }
  }

  requestOptions.timeout = timeout;
  if (config.redirect !== undefined) {
    requestOptions.redirect = config.redirect;
  }
  if (config.disableDefaultHeaders !== undefined) {
    requestOptions.disableDefaultHeaders = config.disableDefaultHeaders;
  }
  if (config.compress !== undefined) {
    requestOptions.compress = config.compress;
  }

  if (headerTuples && headerTuples.length > 0) {
    requestOptions.headers = headerTuples;
  }

  return dispatchRequest(requestOptions, url, config.signal ?? null);
}

export async function createTransport(options?: CreateTransportOptions): Promise<Transport> {
  const mode = resolveEmulationMode(options?.browser, options?.os, options?.emulation);

  if (options?.poolIdleTimeout !== undefined) {
    validatePositiveNumber(options.poolIdleTimeout, "poolIdleTimeout");
  }
  if (options?.poolMaxIdlePerHost !== undefined) {
    validateNonNegativeInteger(options.poolMaxIdlePerHost, "poolMaxIdlePerHost");
  }
  if (options?.poolMaxSize !== undefined) {
    validatePositiveInteger(options.poolMaxSize, "poolMaxSize");
  }
  if (options?.connectTimeout !== undefined) {
    validatePositiveNumber(options.connectTimeout, "connectTimeout");
  }
  if (options?.readTimeout !== undefined) {
    validatePositiveNumber(options.readTimeout, "readTimeout");
  }

  try {
    const transportOptions: NativeTransportOptions = {
      ...(options?.proxy !== undefined && { proxy: options.proxy }),
      ...(options?.insecure !== undefined && { insecure: options.insecure }),
      ...(options?.poolIdleTimeout !== undefined && { poolIdleTimeout: options.poolIdleTimeout }),
      ...(options?.poolMaxIdlePerHost !== undefined && { poolMaxIdlePerHost: options.poolMaxIdlePerHost }),
      ...(options?.poolMaxSize !== undefined && { poolMaxSize: options.poolMaxSize }),
      ...(options?.connectTimeout !== undefined && { connectTimeout: options.connectTimeout }),
      ...(options?.readTimeout !== undefined && { readTimeout: options.readTimeout }),
    };
    applyNativeEmulationMode(transportOptions, mode);

    const id = nativeBinding.createTransport(transportOptions);

    return new Transport(id);
  } catch (error) {
    throw new RequestError(String(error));
  }
}

export async function createSession(options?: CreateSessionOptions): Promise<Session> {
  const { sessionId, defaults } = normalizeSessionOptions(options);

  let createdId: string;
  let transportId: string;

  try {
    const transportOptions: NativeTransportOptions = {
      ...(defaults.proxy !== undefined && { proxy: defaults.proxy }),
      ...(defaults.insecure !== undefined && { insecure: defaults.insecure }),
    };
    applyNativeEmulationMode(transportOptions, defaults.transportMode);
    transportId = nativeBinding.createTransport(transportOptions);
  } catch (error) {
    throw new RequestError(String(error));
  }

  try {
    createdId = nativeBinding.createSession({
      sessionId,
    });
  } catch (error) {
    try {
      nativeBinding.dropTransport(transportId);
    } catch {
      // Best-effort cleanup; prefer surfacing the original error.
    }
    throw new RequestError(String(error));
  }

  defaults.transportId = transportId;
  defaults.ownsTransport = true;

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
  const legacy = rest as Partial<WreqRequestInit> & { ephemeral?: boolean };

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

  if (rest.os !== undefined) {
    init.os = rest.os;
  }

  if (rest.emulation !== undefined) {
    init.emulation = rest.emulation;
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

  if (rest.transport !== undefined) {
    init.transport = rest.transport;
  }

  if (rest.insecure !== undefined) {
    init.insecure = rest.insecure;
  }

  if (rest.disableDefaultHeaders !== undefined) {
    init.disableDefaultHeaders = rest.disableDefaultHeaders;
  }

  if (rest.redirect !== undefined) {
    init.redirect = rest.redirect;
  }

  if (legacy.signal !== undefined) {
    init.signal = legacy.signal;
  }

  if (legacy.session !== undefined) {
    init.session = legacy.session;
  }

  if (legacy.cookieMode !== undefined) {
    init.cookieMode = legacy.cookieMode;
  } else if (legacy.ephemeral === true) {
    init.cookieMode = "ephemeral";
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
 * console.log(profiles); // ['chrome_131', 'chrome_142', 'firefox_135', 'safari_18', ...]
 * ```
 */
export function getProfiles(): BrowserProfile[] {
  if (!cachedProfiles) {
    cachedProfiles = nativeBinding.getProfiles() as BrowserProfile[];
  }

  return cachedProfiles;
}

function getProfileSet(): Set<string> {
  if (!cachedProfileSet) {
    cachedProfileSet = new Set(getProfiles());
  }

  return cachedProfileSet;
}

/**
 * Get list of supported operating systems for emulation.
 *
 * @returns Array of operating system identifiers
 */
export function getOperatingSystems(): EmulationOS[] {
  if (!cachedOperatingSystems) {
    const fromNative = nativeBinding.getOperatingSystems?.() as EmulationOS[] | undefined;
    cachedOperatingSystems = fromNative && fromNative.length > 0 ? fromNative : [...SUPPORTED_OSES];
  }

  return cachedOperatingSystems;
}

function getOperatingSystemSet(): Set<string> {
  if (!cachedOperatingSystemSet) {
    cachedOperatingSystemSet = new Set(getOperatingSystems());
  }

  return cachedOperatingSystemSet;
}

/**
 * Convenience helper for GET requests using {@link fetch}.
 */
export async function get(url: string | URL | Request, init?: Omit<WreqRequestInit, "method">): Promise<Response> {
  const config: WreqRequestInit = {};
  if (init) {
    Object.assign(config, init);
  }
  config.method = "GET";
  return fetch(url, config);
}

/**
 * Convenience helper for POST requests using {@link fetch}.
 */
export async function post(
  url: string | URL | Request,
  body?: BodyInit | null,
  init?: Omit<WreqRequestInit, "method" | "body">,
): Promise<Response> {
  const config: WreqRequestInit = {};
  if (init) {
    Object.assign(config, init);
  }
  config.method = "POST";
  if (body !== undefined) {
    config.body = body;
  }

  return fetch(url, config);
}

function normalizeWebSocketUrl(url: string | URL): string {
  const normalized = String(url).trim();
  if (!normalized) {
    throw new RequestError("URL is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch (error) {
    throw new RequestError(String(error));
  }

  if (parsed.hash) {
    throw new RequestError("WebSocket URL must not include a hash fragment");
  }

  if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
  } else if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
  }

  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new RequestError("expected a ws: or wss: url");
  }

  return parsed.toString();
}

function validateWebSocketProtocols(protocols?: string | string[]): void {
  if (protocols === undefined) {
    return;
  }

  const protocolList = typeof protocols === "string" ? [protocols] : protocols;
  const seen = new Set<string>();
  const validToken = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

  for (const protocol of protocolList) {
    if (typeof protocol !== "string" || protocol.length === 0) {
      throw new RequestError("WebSocket protocol values must be non-empty strings");
    }
    if (!validToken.test(protocol)) {
      throw new RequestError(`Invalid WebSocket protocol value: ${protocol}`);
    }
    if (seen.has(protocol)) {
      throw new RequestError(`Duplicate WebSocket protocol: ${protocol}`);
    }
    seen.add(protocol);
  }
}

function normalizeStandaloneWebSocketOptions(options?: Partial<WebSocketOptions>): WebSocketOptions {
  const normalized: WebSocketOptions = {};
  if (!options) {
    return normalized;
  }

  if (options.browser !== undefined) {
    normalized.browser = options.browser;
  }
  if (options.os !== undefined) {
    normalized.os = options.os;
  }
  if (options.emulation !== undefined) {
    normalized.emulation = options.emulation;
  }
  if (options.headers !== undefined) {
    normalized.headers = options.headers;
  }
  if (options.proxy !== undefined) {
    normalized.proxy = options.proxy;
  }
  if (options.protocols !== undefined) {
    normalized.protocols = options.protocols;
  }
  if (options.binaryType !== undefined) {
    if (options.binaryType !== "nodebuffer" && options.binaryType !== "arraybuffer" && options.binaryType !== "blob") {
      throw new RequestError("binaryType must be one of: 'nodebuffer', 'arraybuffer', 'blob'");
    }
    normalized.binaryType = options.binaryType;
  }

  return normalized;
}

function normalizeSessionWebSocketOptions(options?: Partial<SessionWebSocketOptions>): SessionWebSocketOptions {
  const normalized: SessionWebSocketOptions = {};
  if (!options) {
    return normalized;
  }

  const optionsWithOverrides = options as Partial<WebSocketOptions>;
  if (optionsWithOverrides.browser !== undefined) {
    throw new RequestError(
      "`browser` is not supported in session.websocket(); the session controls browser emulation.",
    );
  }
  if (optionsWithOverrides.os !== undefined) {
    throw new RequestError("`os` is not supported in session.websocket(); the session controls OS emulation.");
  }
  if (optionsWithOverrides.emulation !== undefined) {
    throw new RequestError(
      "`emulation` is not supported in session.websocket(); the session transport controls emulation.",
    );
  }
  if (optionsWithOverrides.proxy !== undefined) {
    throw new RequestError("`proxy` is not supported in session.websocket(); the session transport controls proxying.");
  }

  if (options.headers !== undefined) {
    normalized.headers = options.headers;
  }
  if (options.protocols !== undefined) {
    normalized.protocols = options.protocols;
  }
  if (options.binaryType !== undefined) {
    if (options.binaryType !== "nodebuffer" && options.binaryType !== "arraybuffer" && options.binaryType !== "blob") {
      throw new RequestError("binaryType must be one of: 'nodebuffer', 'arraybuffer', 'blob'");
    }
    normalized.binaryType = options.binaryType;
  }

  return normalized;
}

function extractLegacyWebSocketCallbacks(options: unknown): LegacyWebSocketCallbacks | undefined {
  if (!isPlainObject(options)) {
    return undefined;
  }

  const maybeCallbacks = options as Partial<LegacyWebSocketCallbacks>;
  const callbacks: LegacyWebSocketCallbacks = {};

  if (typeof maybeCallbacks.onMessage === "function") {
    callbacks.onMessage = maybeCallbacks.onMessage;
  }
  if (typeof maybeCallbacks.onClose === "function") {
    callbacks.onClose = maybeCallbacks.onClose;
  }
  if (typeof maybeCallbacks.onError === "function") {
    callbacks.onError = maybeCallbacks.onError;
  }

  return Object.keys(callbacks).length > 0 ? callbacks : undefined;
}

function normalizeWebSocketCloseOptions(code?: number, reason?: string): NativeWebSocketCloseOptions | undefined {
  if (code === undefined && reason === undefined) {
    return undefined;
  }

  if (code === undefined) {
    throw new RequestError("A close code is required when providing a close reason");
  }

  if (!Number.isInteger(code)) {
    throw new RequestError("Close code must be an integer");
  }
  if (code !== 1000 && (code < 3000 || code > 4999)) {
    throw new RequestError("Close code must be 1000 or in range 3000-4999");
  }

  const normalizedReason = reason ?? "";
  if (Buffer.byteLength(normalizedReason, "utf8") > 123) {
    throw new RequestError("Close reason must be 123 bytes or fewer");
  }

  return {
    code,
    reason: normalizedReason,
  };
}

type WebSocketAnyEvent = WebSocketOpenEvent | WebSocketMessageEvent | WebSocketCloseEvent | WebSocketErrorEvent;
type WebSocketFunctionListener = (this: WebSocket, event: WebSocketAnyEvent) => void;
type WebSocketObjectListener = { handleEvent: (event: WebSocketAnyEvent) => void };
type WebSocketListener = WebSocketFunctionListener | WebSocketObjectListener;
type WebSocketAddEventListenerOptions = boolean | { once?: boolean; signal?: AbortSignal | null };
type WebSocketListenerType = "open" | "message" | "close" | "error";

type WebSocketListenerDescriptor = {
  listener: WebSocketListener;
  order: number;
  once: boolean;
  abortSignal?: AbortSignal | null;
  abortHandler?: () => void;
};

function isWebSocketListenerType(type: string): type is WebSocketListenerType {
  return type === "open" || type === "message" || type === "close" || type === "error";
}

/**
 * WHATWG-style WebSocket API with async connection establishment.
 */
export class WebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  protocol = "";
  extensions = "";
  readyState = WebSocket.CONNECTING;
  private _binaryType: WebSocketBinaryType = "nodebuffer";
  private _bufferedAmount = 0;

  private _onopen: ((this: WebSocket, event: WebSocketOpenEvent) => void) | null = null;
  private _onmessage: ((this: WebSocket, event: WebSocketMessageEvent) => void) | null = null;
  private _onclose: ((this: WebSocket, event: WebSocketCloseEvent) => void) | null = null;
  private _onerror: ((this: WebSocket, event: WebSocketErrorEvent) => void) | null = null;
  private _onHandlerOrder = {
    open: -1,
    message: -1,
    close: -1,
    error: -1,
  };
  private _listenerOrderCounter = 0;

  private readonly _listeners = {
    open: new Map<WebSocketListener, WebSocketListenerDescriptor>(),
    message: new Map<WebSocketListener, WebSocketListenerDescriptor>(),
    close: new Map<WebSocketListener, WebSocketListenerDescriptor>(),
    error: new Map<WebSocketListener, WebSocketListenerDescriptor>(),
  };
  private readonly _legacyCallbacks: LegacyWebSocketCallbacks | undefined;
  private readonly _openDispatchMode: WebSocketOpenDispatchMode;
  private _connection: NativeWebSocketConnection | undefined;
  private _connectPromise!: Promise<void>;
  private _closeOptions: NativeWebSocketCloseOptions | undefined;
  private _finalizerToken: NativeWebSocketConnection | undefined;
  private _openEventDispatched = false;
  private _openEventQueued = false;
  private _closeEventDispatched = false;
  private _nativeCloseStarted = false;
  private _pendingMessages: Array<string | Buffer> = [];
  private _sendChain: Promise<void> = Promise.resolve();

  constructor(init: InternalWebSocketInit);
  constructor(url: string | URL, protocols?: string | string[]);
  constructor(url: string | URL, protocols?: string | string[], options?: WebSocketOptions);
  constructor(url: string | URL, options?: WebSocketOptions);
  constructor(
    urlOrInit: string | URL | InternalWebSocketInit,
    protocolsOrOptions?: string | string[] | WebSocketOptions,
    maybeOptions?: WebSocketOptions,
  ) {
    let init: InternalWebSocketInit;
    if (isInternalWebSocketInit(urlOrInit)) {
      init = urlOrInit;
    } else {
      init = WebSocket.buildStandaloneInit(urlOrInit, protocolsOrOptions, maybeOptions);
    }

    this.url = init.url;
    this.binaryType = init.options.binaryType ?? "nodebuffer";
    this._legacyCallbacks = init.legacyCallbacks;
    this._openDispatchMode = init.openDispatchMode;
    this._connectPromise = this.connect(init.connect);
    void this._connectPromise.catch(() => undefined);
  }

  get binaryType(): WebSocketBinaryType {
    return this._binaryType;
  }

  set binaryType(value: WebSocketBinaryType) {
    if (value === "arraybuffer" || value === "blob" || value === "nodebuffer") {
      this._binaryType = value;
    }
  }

  get bufferedAmount(): number {
    return this._bufferedAmount;
  }

  get onopen(): ((this: WebSocket, event: WebSocketOpenEvent) => void) | null {
    return this._onopen;
  }

  set onopen(listener: ((this: WebSocket, event: WebSocketOpenEvent) => void) | null) {
    this._onopen = listener;
    this._onHandlerOrder.open = listener ? ++this._listenerOrderCounter : -1;
  }

  get onmessage(): ((this: WebSocket, event: WebSocketMessageEvent) => void) | null {
    return this._onmessage;
  }

  set onmessage(listener: ((this: WebSocket, event: WebSocketMessageEvent) => void) | null) {
    this._onmessage = listener;
    this._onHandlerOrder.message = listener ? ++this._listenerOrderCounter : -1;
  }

  get onclose(): ((this: WebSocket, event: WebSocketCloseEvent) => void) | null {
    return this._onclose;
  }

  set onclose(listener: ((this: WebSocket, event: WebSocketCloseEvent) => void) | null) {
    this._onclose = listener;
    this._onHandlerOrder.close = listener ? ++this._listenerOrderCounter : -1;
  }

  get onerror(): ((this: WebSocket, event: WebSocketErrorEvent) => void) | null {
    return this._onerror;
  }

  set onerror(listener: ((this: WebSocket, event: WebSocketErrorEvent) => void) | null) {
    this._onerror = listener;
    this._onHandlerOrder.error = listener ? ++this._listenerOrderCounter : -1;
  }

  static async _connectWithInit(init: InternalWebSocketInit): Promise<WebSocket> {
    const ws = new WebSocket(init);
    await ws._waitUntilConnected();
    ws.scheduleOpenEventAfterAwait();
    return ws;
  }

  private static buildStandaloneInit(
    url: string | URL,
    protocolsOrOptions?: string | string[] | WebSocketOptions,
    maybeOptions?: WebSocketOptions,
  ): InternalWebSocketInit {
    const optionsCandidate =
      typeof protocolsOrOptions === "string" || Array.isArray(protocolsOrOptions)
        ? maybeOptions
        : (protocolsOrOptions ?? maybeOptions);
    const normalizedOptions = normalizeStandaloneWebSocketOptions(optionsCandidate);
    validateWebSocketProtocols(
      typeof protocolsOrOptions === "string" || Array.isArray(protocolsOrOptions)
        ? protocolsOrOptions
        : normalizedOptions.protocols,
    );
    assertNoManualWebSocketProtocolHeader(normalizedOptions.headers);
    const emulationMode = resolveEmulationMode(
      normalizedOptions.browser,
      normalizedOptions.os,
      normalizedOptions.emulation,
    );
    const protocols = normalizeWebSocketProtocolList(
      typeof protocolsOrOptions === "string" || Array.isArray(protocolsOrOptions)
        ? protocolsOrOptions
        : normalizedOptions.protocols,
    );

    return {
      _internal: true,
      url: normalizeWebSocketUrl(url),
      options: normalizedOptions,
      openDispatchMode: "automatic",
      connect: (callbacks) => {
        const nativeOptions: NativeWebSocketOptions = {
          url: normalizeWebSocketUrl(url),
          headers: headersToTuples(normalizedOptions.headers ?? {}),
          ...(protocols && protocols.length > 0 && { protocols }),
          ...(normalizedOptions.proxy !== undefined && { proxy: normalizedOptions.proxy }),
          onMessage: callbacks.onMessage,
          onClose: callbacks.onClose,
          onError: callbacks.onError,
        };
        applyNativeEmulationMode(nativeOptions, emulationMode);
        return nativeBinding.websocketConnect(nativeOptions);
      },
      legacyCallbacks: extractLegacyWebSocketCallbacks(optionsCandidate),
    };
  }

  private async connect(
    connectFn: (callbacks: {
      onMessage: (data: string | Buffer) => void;
      onClose: (event: NativeWebSocketCloseEvent) => void;
      onError: (message: string) => void;
    }) => Promise<NativeWebSocketConnection>,
  ): Promise<void> {
    try {
      const connection = await connectFn({
        onMessage: (data) => {
          this.handleNativeMessage(data);
        },
        onClose: (event) => {
          this.handleNativeClose(event);
        },
        onError: (message) => {
          this.handleNativeError(message);
        },
      });

      this._connection = connection;
      this.protocol = connection.protocol ?? "";
      this.extensions = connection.extensions ?? "";
      if (websocketFinalizer) {
        this._finalizerToken = connection;
        websocketFinalizer.register(this, connection, connection);
      }

      if (this.readyState === WebSocket.CLOSING) {
        this.startNativeClose();
        return;
      }

      this.readyState = WebSocket.OPEN;
      if (this._openDispatchMode === "automatic") {
        this.scheduleOpenEventAfterConnect();
      }
    } catch (error) {
      this.handleNativeError(String(error));
      this.finalizeClosed({ code: 1006, reason: "" }, false);
      throw new RequestError(String(error));
    }
  }

  private _waitUntilConnected(): Promise<void> {
    return this._connectPromise;
  }

  private scheduleOpenEventAfterConnect(): void {
    this.scheduleOpenEventWithDepth(2);
  }

  private scheduleOpenEventAfterAwait(): void {
    this.scheduleOpenEventWithDepth(3);
  }

  private scheduleOpenEventWithDepth(depth: number): void {
    if (this._openEventDispatched || this._openEventQueued || this.readyState !== WebSocket.OPEN) {
      return;
    }
    this._openEventQueued = true;

    const queue = (remaining: number) => {
      if (remaining === 0) {
        this._openEventQueued = false;
        if (this._openEventDispatched || this.readyState !== WebSocket.OPEN) {
          return;
        }
        this._openEventDispatched = true;
        this.dispatchOpenEvent();
        return;
      }

      queueMicrotask(() => {
        queue(remaining - 1);
      });
    };

    queue(depth);
  }

  private releaseConnectionTracking(): void {
    if (!this._finalizerToken || !websocketFinalizer) {
      return;
    }
    websocketFinalizer.unregister(this._finalizerToken);
    this._finalizerToken = undefined;
  }

  private toMessageEventData(data: string | Buffer): string | Buffer | ArrayBuffer | Blob {
    if (typeof data === "string") {
      return data;
    }
    if (this._binaryType === "arraybuffer") {
      const arrayBuffer = new ArrayBuffer(data.byteLength);
      new Uint8Array(arrayBuffer).set(data);
      return arrayBuffer;
    }
    if (this._binaryType === "blob") {
      return new Blob([data]);
    }
    return data;
  }

  private invokeListener(listener: WebSocketListener, event: WebSocketAnyEvent): void {
    try {
      if (typeof listener === "function") {
        listener.call(this, event);
      } else {
        listener.handleEvent(event);
      }
    } catch {
      // Event listener errors should not break native callback dispatch.
    }
  }

  private createBaseEvent<TType extends WebSocketAnyEvent["type"]>(type: TType) {
    return {
      type,
      isTrusted: false as const,
      timeStamp: Date.now(),
      target: this,
      currentTarget: this,
    };
  }

  private getOnHandler(type: WebSocketListenerType): WebSocketFunctionListener | null {
    switch (type) {
      case "open":
        return this._onopen as WebSocketFunctionListener | null;
      case "message":
        return this._onmessage as WebSocketFunctionListener | null;
      case "close":
        return this._onclose as WebSocketFunctionListener | null;
      case "error":
        return this._onerror as WebSocketFunctionListener | null;
      default:
        return null;
    }
  }

  private getOnHandlerOrder(type: WebSocketListenerType): number {
    return this._onHandlerOrder[type];
  }

  private getListenerMap(type: WebSocketListenerType): Map<WebSocketListener, WebSocketListenerDescriptor> {
    return this._listeners[type];
  }

  private dispatchEvent(type: WebSocketListenerType, event: WebSocketAnyEvent): void {
    const listenerMap = this.getListenerMap(type);
    const onHandler = this.getOnHandler(type);
    if (listenerMap.size === 0 && !onHandler) {
      return;
    }

    const ordered: Array<{ order: number; listener: WebSocketListener; once: boolean }> = [];
    for (const descriptor of listenerMap.values()) {
      ordered.push({
        order: descriptor.order,
        listener: descriptor.listener,
        once: descriptor.once,
      });
    }

    if (onHandler) {
      ordered.push({
        order: this.getOnHandlerOrder(type),
        listener: onHandler,
        once: false,
      });
    }

    ordered.sort((a, b) => a.order - b.order);

    for (const entry of ordered) {
      if (entry.once) {
        this.removeEventListener(type, entry.listener);
      }
      this.invokeListener(entry.listener, event);
    }
  }

  private dispatchOpenEvent(): void {
    const event: WebSocketOpenEvent = this.createBaseEvent("open");
    this.dispatchEvent("open", event);
    if (!this._closeEventDispatched && this._pendingMessages.length > 0) {
      const pending = this._pendingMessages;
      this._pendingMessages = [];
      for (const data of pending) {
        this.dispatchMessageEvent(this.toMessageEventData(data));
      }
    }
  }

  private dispatchMessageEvent(data: string | Buffer | ArrayBuffer | Blob): void {
    const event: WebSocketMessageEvent = {
      ...this.createBaseEvent("message"),
      data,
    };
    this.dispatchEvent("message", event);
  }

  private dispatchCloseEvent(event: WebSocketCloseEvent): void {
    this.dispatchEvent("close", event);
  }

  private dispatchErrorEvent(message?: string): void {
    const event: WebSocketErrorEvent = {
      ...this.createBaseEvent("error"),
      ...(message !== undefined && { message }),
    };
    this.dispatchEvent("error", event);
  }

  private handleNativeMessage(data: string | Buffer): void {
    if (this._closeEventDispatched) {
      return;
    }

    this._legacyCallbacks?.onMessage?.(data);
    if (!this._openEventDispatched && this.readyState === WebSocket.OPEN) {
      this._pendingMessages.push(data);
      return;
    }
    this.dispatchMessageEvent(this.toMessageEventData(data));
  }

  private handleNativeError(message: string): void {
    this._legacyCallbacks?.onError?.(message);
    this.dispatchErrorEvent(message);
  }

  private handleNativeClose(event: NativeWebSocketCloseEvent): void {
    const wasClean = this.readyState === WebSocket.CLOSING || event.code === 1000;
    this.finalizeClosed(event, wasClean);
  }

  private finalizeClosed(event: NativeWebSocketCloseEvent, wasClean: boolean): void {
    if (this._closeEventDispatched) {
      return;
    }

    this.readyState = WebSocket.CLOSED;
    this._closeEventDispatched = true;
    this._pendingMessages = [];
    this.releaseConnectionTracking();

    const closeEvent: WebSocketCloseEvent = {
      ...this.createBaseEvent("close"),
      code: event.code,
      reason: event.reason,
      wasClean,
    };

    this._legacyCallbacks?.onClose?.(closeEvent);
    this.dispatchCloseEvent(closeEvent);
  }

  private startNativeClose(): void {
    if (this._nativeCloseStarted || !this._connection) {
      return;
    }
    this._nativeCloseStarted = true;
    const connection = this._connection;
    const closeOptions = this._closeOptions;

    void nativeBinding.websocketClose(connection, closeOptions).catch((error) => {
      this.handleNativeError(String(error));
      this.finalizeClosed({ code: 1006, reason: "" }, false);
    });
  }

  addEventListener(
    type: "open",
    listener: ((event: WebSocketOpenEvent) => void) | null,
    options?: WebSocketAddEventListenerOptions,
  ): void;
  addEventListener(
    type: "message",
    listener: ((event: WebSocketMessageEvent) => void) | null,
    options?: WebSocketAddEventListenerOptions,
  ): void;
  addEventListener(
    type: "close",
    listener: ((event: WebSocketCloseEvent) => void) | null,
    options?: WebSocketAddEventListenerOptions,
  ): void;
  addEventListener(
    type: "error",
    listener: ((event: WebSocketErrorEvent) => void) | null,
    options?: WebSocketAddEventListenerOptions,
  ): void;
  addEventListener(type: string, listener: unknown, options?: WebSocketAddEventListenerOptions): void;
  addEventListener(type: string, listener: unknown, options?: WebSocketAddEventListenerOptions): void {
    if (!listener || !isWebSocketListenerType(type)) {
      return;
    }

    const normalizedListener = listener as WebSocketListener;
    if (
      typeof normalizedListener !== "function" &&
      (typeof normalizedListener !== "object" ||
        normalizedListener === null ||
        typeof normalizedListener.handleEvent !== "function")
    ) {
      return;
    }
    const listenerMap = this.getListenerMap(type);
    if (listenerMap.has(normalizedListener)) {
      return;
    }

    const parsedOptions = typeof options === "boolean" ? {} : (options ?? {});
    const once = parsedOptions.once === true;
    const signal = parsedOptions.signal;

    if (signal?.aborted) {
      return;
    }

    const descriptor: WebSocketListenerDescriptor = {
      listener: normalizedListener,
      order: ++this._listenerOrderCounter,
      once,
    };

    if (signal) {
      const onAbort = () => {
        this.removeEventListener(type, normalizedListener);
      };
      descriptor.abortSignal = signal;
      descriptor.abortHandler = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
    }

    listenerMap.set(normalizedListener, descriptor);
  }

  removeEventListener(type: "open", listener: ((event: WebSocketOpenEvent) => void) | null): void;
  removeEventListener(type: "message", listener: ((event: WebSocketMessageEvent) => void) | null): void;
  removeEventListener(type: "close", listener: ((event: WebSocketCloseEvent) => void) | null): void;
  removeEventListener(type: "error", listener: ((event: WebSocketErrorEvent) => void) | null): void;
  removeEventListener(type: string, listener: unknown): void;
  removeEventListener(type: string, listener: unknown): void {
    if (!listener || !isWebSocketListenerType(type)) {
      return;
    }

    const normalizedListener = listener as WebSocketListener;
    if (typeof normalizedListener !== "function" && typeof normalizedListener !== "object") {
      return;
    }
    const listenerMap = this.getListenerMap(type);
    const descriptor = listenerMap.get(normalizedListener);
    if (!descriptor) {
      return;
    }

    if (descriptor.abortSignal && descriptor.abortHandler) {
      descriptor.abortSignal.removeEventListener("abort", descriptor.abortHandler);
    }

    listenerMap.delete(normalizedListener);
  }

  private getSendByteLength(data: string | Buffer | ArrayBuffer | ArrayBufferView | Blob): number {
    if (typeof data === "string") {
      return Buffer.byteLength(data);
    }
    if (Buffer.isBuffer(data)) {
      return data.byteLength;
    }
    if (data instanceof ArrayBuffer) {
      return data.byteLength;
    }
    if (ArrayBuffer.isView(data)) {
      return data.byteLength;
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return data.size;
    }

    throw new TypeError("WebSocket data must be a string, Buffer, ArrayBuffer, ArrayBufferView, or Blob");
  }

  private async normalizeSendPayload(
    data: string | Buffer | ArrayBuffer | ArrayBufferView | Blob,
  ): Promise<string | Buffer> {
    if (typeof data === "string") {
      return data;
    }
    if (Buffer.isBuffer(data)) {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      return Buffer.from(data);
    }
    if (ArrayBuffer.isView(data)) {
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return Buffer.from(await data.arrayBuffer());
    }

    throw new TypeError("WebSocket data must be a string, Buffer, ArrayBuffer, ArrayBufferView, or Blob");
  }

  send(data: string | Buffer | ArrayBuffer | ArrayBufferView | Blob): void {
    if (this.readyState !== WebSocket.OPEN || !this._connection) {
      throw new RequestError("WebSocket is not open");
    }

    const queuedBytes = this.getSendByteLength(data);
    const connection = this._connection;
    this._bufferedAmount += queuedBytes;
    const sendTask = async () => {
      try {
        const payload = await this.normalizeSendPayload(data);
        await nativeBinding.websocketSend(connection, payload);
      } catch (error) {
        this.handleNativeError(String(error));
        this.finalizeClosed({ code: 1006, reason: "" }, false);
      } finally {
        this._bufferedAmount = Math.max(0, this._bufferedAmount - queuedBytes);
      }
    };
    this._sendChain = this._sendChain.then(sendTask, sendTask);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === WebSocket.CLOSING || this.readyState === WebSocket.CLOSED) {
      return;
    }

    this._closeOptions = normalizeWebSocketCloseOptions(code, reason);
    this.readyState = WebSocket.CLOSING;
    this.startNativeClose();
  }
}

function isInternalWebSocketInit(value: unknown): value is InternalWebSocketInit {
  if (!isPlainObject(value)) {
    return false;
  }

  const candidate = value as Partial<InternalWebSocketInit>;
  return candidate._internal === true && typeof candidate.url === "string" && typeof candidate.connect === "function";
}

function normalizeStandaloneWebSocketArgs(
  urlOrOptions: string | URL | LegacyWebSocketOptions,
  options?: WebSocketOptions,
): { url: string; options: WebSocketOptions; legacyCallbacks: LegacyWebSocketCallbacks | undefined } {
  if (typeof urlOrOptions === "string" || urlOrOptions instanceof URL) {
    const normalizedOptions = normalizeStandaloneWebSocketOptions(options);
    return {
      url: normalizeWebSocketUrl(urlOrOptions),
      options: normalizedOptions,
      legacyCallbacks: extractLegacyWebSocketCallbacks(options),
    };
  }

  const legacy = urlOrOptions;
  const normalizedOptions = normalizeStandaloneWebSocketOptions(legacy);
  return {
    url: normalizeWebSocketUrl(legacy.url),
    options: normalizedOptions,
    legacyCallbacks: extractLegacyWebSocketCallbacks(legacy),
  };
}

function normalizeSessionWebSocketArgs(
  urlOrOptions: string | URL | LegacySessionWebSocketOptions,
  options?: SessionWebSocketOptions,
): { url: string; options: SessionWebSocketOptions; legacyCallbacks: LegacyWebSocketCallbacks | undefined } {
  if (typeof urlOrOptions === "string" || urlOrOptions instanceof URL) {
    const normalizedOptions = normalizeSessionWebSocketOptions(options);
    return {
      url: normalizeWebSocketUrl(urlOrOptions),
      options: normalizedOptions,
      legacyCallbacks: extractLegacyWebSocketCallbacks(options),
    };
  }

  const legacy = urlOrOptions;
  const normalizedOptions = normalizeSessionWebSocketOptions(legacy);
  return {
    url: normalizeWebSocketUrl(legacy.url),
    options: normalizedOptions,
    legacyCallbacks: extractLegacyWebSocketCallbacks(legacy),
  };
}

/**
 * Create a WebSocket connection with browser impersonation.
 */
export async function websocket(url: string | URL, options?: WebSocketOptions): Promise<WebSocket>;
export async function websocket(options: LegacyWebSocketOptions): Promise<WebSocket>;
export async function websocket(
  urlOrOptions: string | URL | LegacyWebSocketOptions,
  options?: WebSocketOptions,
): Promise<WebSocket> {
  const normalized = normalizeStandaloneWebSocketArgs(urlOrOptions, options);
  validateWebSocketProtocols(normalized.options.protocols);
  assertNoManualWebSocketProtocolHeader(normalized.options.headers);
  const emulationMode = resolveEmulationMode(
    normalized.options.browser,
    normalized.options.os,
    normalized.options.emulation,
  );
  const protocols = normalizeWebSocketProtocolList(normalized.options.protocols);

  return WebSocket._connectWithInit({
    _internal: true,
    url: normalized.url,
    options: normalized.options,
    openDispatchMode: "deferred",
    connect: (callbacks) => {
      const nativeOptions: NativeWebSocketOptions = {
        url: normalized.url,
        headers: headersToTuples(normalized.options.headers ?? {}),
        ...(protocols && protocols.length > 0 && { protocols }),
        ...(normalized.options.proxy !== undefined && { proxy: normalized.options.proxy }),
        onMessage: callbacks.onMessage,
        onClose: callbacks.onClose,
        onError: callbacks.onError,
      };
      applyNativeEmulationMode(nativeOptions, emulationMode);
      return nativeBinding.websocketConnect(nativeOptions);
    },
    legacyCallbacks: normalized.legacyCallbacks,
  });
}

export type {
  AlpnProtocol,
  AlpsProtocol,
  BodyInit,
  BrowserProfile,
  CookieMode,
  CreateSessionOptions,
  CreateTransportOptions,
  CustomEmulationOptions,
  CustomHttp1Options,
  CustomHttp2Options,
  CustomTlsOptions,
  EmulationOS,
  HeadersInit,
  Http2ExperimentalSetting,
  Http2Priority,
  Http2PseudoHeaderId,
  Http2SettingId,
  Http2StreamDependency,
  RequestInit,
  RequestOptions,
  SessionHandle,
  SessionWebSocketOptions,
  TlsVersion,
  WebSocketBinaryType,
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketEventType,
  WebSocketMessageEvent,
  WebSocketOpenEvent,
  WebSocketOptions,
} from "./types.js";

export { RequestError };

export default {
  fetch,
  request,
  get,
  post,
  getProfiles,
  getOperatingSystems,
  createTransport,
  createSession,
  withSession,
  websocket,
  WebSocket,
  Headers,
  Response,
  Transport,
  Session,
  RequestError,
};
