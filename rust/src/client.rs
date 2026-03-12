use anyhow::{Context, Result, anyhow};
use bytes::Bytes;
use dashmap::DashMap;
use futures_util::{Stream, StreamExt};
use moka::sync::Cache;
use std::borrow::Cow;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::runtime::Runtime;
use tokio::sync::Mutex;
use uuid::Uuid;
use wreq::cookie::Jar;
use wreq::header::OrigHeaderMap;
use wreq::{Client as HttpClient, Method, Proxy, redirect};

use crate::custom_emulation::resolve_emulation;
use wreq_util::{Emulation as BrowserEmulation, EmulationOS as BrowserEmulationOS};

pub static HTTP_RUNTIME: LazyLock<Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to create shared HTTP runtime")
});

static SESSION_MANAGER: LazyLock<SessionManager> = LazyLock::new(SessionManager::new);
static EPHEMERAL_MANAGER: LazyLock<EphemeralClientManager> =
    LazyLock::new(EphemeralClientManager::new);
static TRANSPORT_MANAGER: LazyLock<TransportManager> = LazyLock::new(TransportManager::new);

// Responses at or below this size (bytes) are fully buffered in Rust and returned
// inline to Node, avoiding an extra round-trip to stream the body.
// Most API responses fit within 2 MiB; inlining them skips DashMap, Mutex, and an
// additional FFI round-trip that the streaming path would otherwise require.
const INLINE_BODY_MAX: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Default)]
pub enum RedirectMode {
    #[default]
    Follow,
    Manual,
    Error,
}

impl RedirectMode {
    fn as_policy(self) -> redirect::Policy {
        match self {
            RedirectMode::Follow => redirect::Policy::default(),
            RedirectMode::Manual => redirect::Policy::custom(|attempt| attempt.stop()),
            RedirectMode::Error => redirect::Policy::custom(|attempt| {
                attempt.error("Redirects are disabled for this request")
            }),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RequestOptions {
    pub url: String,
    pub browser: Option<BrowserEmulation>,
    pub browser_os: Option<BrowserEmulationOS>,
    pub emulation_json: Option<Arc<str>>,
    pub headers: Vec<(String, String)>,
    pub method: String,
    pub body: Option<Vec<u8>>,
    pub proxy: Option<Arc<str>>,
    pub timeout: u64,
    pub redirect: RedirectMode,
    pub session_id: String,
    pub ephemeral: bool,
    pub disable_default_headers: bool,
    pub insecure: bool,
    pub transport_id: Option<String>,
    pub pool_idle_timeout: Option<u64>,
    pub pool_max_idle_per_host: Option<usize>,
    pub pool_max_size: Option<u32>,
    pub connect_timeout: Option<u64>,
    pub read_timeout: Option<u64>,
    pub compress: bool,
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body_handle: Option<u64>,
    pub body_bytes: Option<Bytes>,
    pub cookies: Vec<(String, String)>,
    pub url: String,
    pub content_length: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct SessionConfig {
    browser: Option<BrowserEmulation>,
    browser_os: Option<BrowserEmulationOS>,
    emulation_json: Option<Arc<str>>,
    proxy: Option<Arc<str>>,
    insecure: bool,
    connect_timeout: Option<Duration>,
    read_timeout: Option<Duration>,
}

impl SessionConfig {
    #[inline]
    fn from_request(options: &RequestOptions) -> Self {
        Self {
            browser: options.browser,
            browser_os: options.browser_os,
            emulation_json: options.emulation_json.clone(),
            proxy: options.proxy.clone(),
            insecure: options.insecure,
            connect_timeout: options.connect_timeout.map(Duration::from_millis),
            read_timeout: options.read_timeout.map(Duration::from_millis),
        }
    }
}

#[derive(Debug, Clone)]
struct TransportConfig {
    browser: Option<BrowserEmulation>,
    browser_os: Option<BrowserEmulationOS>,
    emulation_json: Option<Arc<str>>,
    proxy: Option<Arc<str>>,
    insecure: bool,
    pool_idle_timeout: Option<Duration>,
    pool_max_idle_per_host: Option<usize>,
    pool_max_size: Option<u32>,
    connect_timeout: Option<Duration>,
    read_timeout: Option<Duration>,
}

impl TransportConfig {
    #[inline]
    fn from_request(options: &RequestOptions) -> Self {
        Self {
            browser: options.browser,
            browser_os: options.browser_os,
            emulation_json: options.emulation_json.clone(),
            proxy: options.proxy.clone(),
            insecure: options.insecure,
            pool_idle_timeout: options.pool_idle_timeout.map(Duration::from_millis),
            pool_max_idle_per_host: options.pool_max_idle_per_host,
            pool_max_size: options.pool_max_size,
            connect_timeout: options.connect_timeout.map(Duration::from_millis),
            read_timeout: options.read_timeout.map(Duration::from_millis),
        }
    }

    #[inline]
    fn new(
        browser: Option<BrowserEmulation>,
        browser_os: Option<BrowserEmulationOS>,
        emulation_json: Option<Arc<str>>,
        proxy: Option<Arc<str>>,
        insecure: bool,
        pool_idle_timeout: Option<u64>,
        pool_max_idle_per_host: Option<usize>,
        pool_max_size: Option<u32>,
        connect_timeout: Option<u64>,
        read_timeout: Option<u64>,
    ) -> Self {
        Self {
            browser,
            browser_os,
            emulation_json,
            proxy,
            insecure,
            pool_idle_timeout: pool_idle_timeout.map(Duration::from_millis),
            pool_max_idle_per_host,
            pool_max_size,
            connect_timeout: connect_timeout.map(Duration::from_millis),
            read_timeout: read_timeout.map(Duration::from_millis),
        }
    }
}

/// Bundles an HTTP client with the emulation-level OrigHeaderMap so that
/// per-request orig_headers can be merged (not replaced) when user headers
/// are present.
pub(crate) struct ResolvedClient {
    pub(crate) http_client: HttpClient,
    pub(crate) emulation_orig_headers: OrigHeaderMap,
}

#[derive(Clone)]
struct TransportEntry {
    client: Arc<ResolvedClient>,
}

#[derive(Clone)]
struct SessionEntry {
    cookie_jar: Arc<Jar>,
}

struct TransportManager {
    explicit: DashMap<String, Arc<TransportEntry>>,
}

struct SessionManager {
    cache: Cache<String, Arc<SessionEntry>>,
}

struct EphemeralClientManager {
    cache: Cache<SessionConfig, Arc<ResolvedClient>>,
}

pub type ResponseBodyStream = Pin<Box<dyn Stream<Item = wreq::Result<Bytes>> + Send>>;

static BODY_STREAMS: LazyLock<Cache<u64, Arc<Mutex<ResponseBodyStream>>>> = LazyLock::new(|| {
    Cache::builder()
        .time_to_idle(Duration::from_secs(300))
        .build()
});
static NEXT_BODY_HANDLE: AtomicU64 = AtomicU64::new(1);

fn next_body_handle() -> u64 {
    NEXT_BODY_HANDLE.fetch_add(1, Ordering::Relaxed)
}

pub fn store_body_stream(stream: ResponseBodyStream) -> u64 {
    let handle = next_body_handle();
    BODY_STREAMS.insert(handle, Arc::new(Mutex::new(stream)));
    handle
}

pub async fn read_body_chunk(handle: u64) -> Result<Option<Bytes>> {
    let stream = BODY_STREAMS
        .get(&handle)
        .ok_or_else(|| anyhow!("Body handle {} not found", handle))?;

    let mut guard = stream.lock().await;
    let next = guard.next().await;

    match next {
        Some(Ok(bytes)) => Ok(Some(bytes)),
        Some(Err(err)) => {
            BODY_STREAMS.invalidate(&handle);
            Err(err.into())
        }
        None => {
            BODY_STREAMS.invalidate(&handle);
            Ok(None)
        }
    }
}

/// Read entire body into a single buffer. More efficient than streaming for small bodies.
pub async fn read_body_all(handle: u64) -> Result<Bytes> {
    let stream = BODY_STREAMS
        .remove(&handle)
        .ok_or_else(|| anyhow!("Body handle {} not found", handle))?;

    let mut guard = stream.lock().await;
    let mut chunks: Vec<Bytes> = Vec::new();
    let mut total_len = 0usize;

    while let Some(result) = guard.next().await {
        let bytes = result?;
        total_len += bytes.len();
        chunks.push(bytes);
    }

    // Fast path: single chunk or empty
    if chunks.is_empty() {
        return Ok(Bytes::new());
    }
    if chunks.len() == 1 {
        return Ok(chunks.into_iter().next().unwrap());
    }

    // Multiple chunks: consolidate
    let mut buf = Vec::with_capacity(total_len);
    for chunk in chunks {
        buf.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(buf))
}

pub fn drop_body_stream(handle: u64) {
    BODY_STREAMS.invalidate(&handle);
}

impl TransportManager {
    fn new() -> Self {
        Self {
            explicit: DashMap::new(),
        }
    }

    fn create_transport(&self, config: TransportConfig) -> Result<String> {
        let resolved = Arc::new(build_client(&config)?);
        let entry = Arc::new(TransportEntry { client: resolved });
        let id = Uuid::new_v4().to_string();
        self.explicit.insert(id.clone(), entry);
        Ok(id)
    }

    fn get_transport(&self, transport_id: &str) -> Result<Arc<ResolvedClient>> {
        self.explicit
            .get(transport_id)
            .map(|entry| entry.client.clone())
            .ok_or_else(|| anyhow!("Transport '{}' not found", transport_id))
    }

    fn drop_transport(&self, transport_id: &str) {
        self.explicit.remove(transport_id);
    }
}

impl SessionManager {
    fn new() -> Self {
        Self {
            cache: Cache::builder()
                .time_to_idle(Duration::from_secs(300))
                .build(),
        }
    }

    fn jar_for(&self, session_id: &str) -> Result<Arc<Jar>> {
        if let Some(entry) = self.cache.get(session_id) {
            return Ok(entry.cookie_jar.clone());
        }

        let entry = Arc::new(SessionEntry {
            cookie_jar: Arc::new(Jar::default()),
        });
        self.cache.insert(session_id.to_string(), entry.clone());
        Ok(entry.cookie_jar.clone())
    }

    fn create_session(&self, session_id: String) -> Result<String> {
        let entry = Arc::new(SessionEntry {
            cookie_jar: Arc::new(Jar::default()),
        });
        self.cache.insert(session_id.clone(), entry);
        Ok(session_id)
    }

    fn clear_session(&self, session_id: &str) -> Result<()> {
        let entry = self
            .cache
            .get(session_id)
            .ok_or_else(|| anyhow::anyhow!("Session '{}' not found", session_id))?;
        entry.cookie_jar.clear();
        Ok(())
    }

    fn drop_session(&self, session_id: &str) {
        self.cache.invalidate(session_id);
    }
}

impl EphemeralClientManager {
    fn new() -> Self {
        Self {
            cache: Cache::builder()
                .time_to_idle(Duration::from_secs(300))
                .build(),
        }
    }

    fn client_for(&self, config: SessionConfig) -> Result<Arc<ResolvedClient>> {
        if let Some(resolved) = self.cache.get(&config) {
            return Ok(resolved);
        }

        let resolved = Arc::new(build_ephemeral_client(&config)?);
        self.cache.insert(config, resolved.clone());
        Ok(resolved)
    }
}

pub async fn make_request(options: RequestOptions) -> Result<Response> {
    let transport_id = options.transport_id.clone();

    // Resolve client: explicit transport > ephemeral cache > fresh client
    let resolved = if let Some(ref tid) = transport_id {
        TRANSPORT_MANAGER.get_transport(tid)?
    } else if options.ephemeral {
        let config = SessionConfig::from_request(&options);
        EPHEMERAL_MANAGER.client_for(config)?
    } else {
        let config = TransportConfig::from_request(&options);
        Arc::new(build_client(&config)?)
    };

    // Resolve cookie jar: ephemeral gets a fresh jar, sessions share one
    let cookie_jar = if options.ephemeral {
        Arc::new(Jar::default())
    } else {
        SESSION_MANAGER.jar_for(&options.session_id)?
    };

    make_request_inner(options, resolved, cookie_jar).await
}

async fn make_request_inner(
    options: RequestOptions,
    resolved: Arc<ResolvedClient>,
    cookie_jar: Arc<Jar>,
) -> Result<Response> {
    let RequestOptions {
        url,
        headers,
        method,
        body,
        timeout,
        redirect,
        disable_default_headers,
        compress,
        ..
    } = options;

    // Methods are already normalized to uppercase in JS; default to GET when empty.
    let method = if method.is_empty() {
        Cow::Borrowed("GET")
    } else {
        Cow::Owned(method)
    };

    let request_method = match method.as_ref() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        "PUT" => Method::PUT,
        "DELETE" => Method::DELETE,
        "PATCH" => Method::PATCH,
        "HEAD" => Method::HEAD,
        "OPTIONS" => Method::OPTIONS,
        "CONNECT" => Method::CONNECT,
        "TRACE" => Method::TRACE,
        _ => Method::from_bytes(method.as_bytes())
            .with_context(|| format!("Unsupported HTTP method: {}", method))?,
    };

    // Build request
    let mut request = resolved.http_client.request(request_method, &url);

    // Apply custom headers and preserve their original casing.
    // Merge with emulation-level origHeaders so that custom emulation header
    // casing/order is preserved even when the request adds explicit headers.
    if !headers.is_empty() {
        let mut orig = resolved.emulation_orig_headers.clone();
        for (key, value) in headers.iter() {
            request = request.header(key, value);
            orig.insert(key.clone());
        }
        request = request.orig_headers(orig);
    }

    // Disable default headers if requested to prevent emulation headers from being appended
    if disable_default_headers {
        request = request.default_headers(false);
    }

    // Disable automatic decompression when compress is false
    if !compress {
        request = request.gzip(false).brotli(false).deflate(false).zstd(false);
    }

    // Apply redirect policy
    request = request.redirect(redirect.as_policy());

    // Apply body if present
    if let Some(body) = body {
        request = request.body(body);
    }

    // Apply timeout (0 means no timeout)
    if timeout > 0 {
        request = request.timeout(Duration::from_millis(timeout));
    }

    request = request.cookie_provider(cookie_jar);

    // Execute request
    let response = request
        .send()
        .await
        .with_context(|| format!("{} {}", method, url))?;

    // Extract response data
    let status = response.status().as_u16();
    let final_url = response.uri().to_string();

    // Extract headers into a pre-allocated Vec (avoids IndexMap hashing overhead)
    let raw_headers = response.headers();
    let mut response_headers = Vec::with_capacity(raw_headers.len());
    for (key, value) in raw_headers {
        if let Ok(value_str) = value.to_str() {
            response_headers.push((key.as_str().to_owned(), value_str.to_owned()));
        }
    }

    // Extract cookies into a Vec
    let cookies: Vec<(String, String)> = response
        .cookies()
        .map(|c| (c.name().to_owned(), c.value().to_owned()))
        .collect();

    let mut content_length = response.content_length();
    let allows_body = response_allows_body(status, method.as_ref());

    let (body_handle, body_bytes) = if allows_body {
        let inline_eligible = content_length
            .map(|len| len <= INLINE_BODY_MAX)
            .unwrap_or(false);

        if inline_eligible {
            let bytes = response.bytes().await?;
            content_length = Some(bytes.len() as u64);
            (None, Some(bytes))
        } else {
            let stream: ResponseBodyStream = Box::pin(response.bytes_stream());
            (Some(store_body_stream(stream)), None)
        }
    } else {
        (None, None)
    };

    Ok(Response {
        status,
        headers: response_headers,
        body_handle,
        body_bytes,
        cookies,
        url: final_url,
        content_length,
    })
}

/// Build a client for explicit transports (full pooling config).
fn build_client(config: &TransportConfig) -> Result<ResolvedClient> {
    let mut emulation = resolve_emulation(
        config.browser,
        config.browser_os,
        config.emulation_json.as_deref(),
    )?;
    let emulation_orig_headers = emulation.orig_headers_mut().clone();

    let mut client_builder = HttpClient::builder().emulation(emulation);

    if let Some(proxy_url) = config.proxy.as_deref() {
        let proxy = Proxy::all(proxy_url).context("Failed to create proxy")?;
        client_builder = client_builder.proxy(proxy);
    }

    if config.insecure {
        client_builder = client_builder.cert_verification(false);
    }

    if let Some(pool_idle_timeout) = config.pool_idle_timeout {
        client_builder = client_builder.pool_idle_timeout(pool_idle_timeout);
    }

    if let Some(pool_max_idle_per_host) = config.pool_max_idle_per_host {
        client_builder = client_builder.pool_max_idle_per_host(pool_max_idle_per_host);
    }

    if let Some(pool_max_size) = config.pool_max_size {
        client_builder = client_builder.pool_max_size(pool_max_size);
    }

    if let Some(connect_timeout) = config.connect_timeout {
        client_builder = client_builder.connect_timeout(connect_timeout);
    }

    if let Some(read_timeout) = config.read_timeout {
        client_builder = client_builder.read_timeout(read_timeout);
    }

    let http_client = client_builder
        .build()
        .context("Failed to build HTTP client")?;
    Ok(ResolvedClient {
        http_client,
        emulation_orig_headers,
    })
}

/// Build a client for ephemeral (stateless) requests - no connection pooling.
fn build_ephemeral_client(config: &SessionConfig) -> Result<ResolvedClient> {
    let mut emulation = resolve_emulation(
        config.browser,
        config.browser_os,
        config.emulation_json.as_deref(),
    )?;
    let emulation_orig_headers = emulation.orig_headers_mut().clone();

    let mut client_builder = HttpClient::builder()
        .emulation(emulation)
        .pool_max_idle_per_host(0);

    if let Some(proxy_url) = config.proxy.as_deref() {
        let proxy = Proxy::all(proxy_url).context("Failed to create proxy")?;
        client_builder = client_builder.proxy(proxy);
    }

    if config.insecure {
        client_builder = client_builder.cert_verification(false);
    }

    if let Some(connect_timeout) = config.connect_timeout {
        client_builder = client_builder.connect_timeout(connect_timeout);
    }

    if let Some(read_timeout) = config.read_timeout {
        client_builder = client_builder.read_timeout(read_timeout);
    }

    let http_client = client_builder
        .build()
        .context("Failed to build HTTP client")?;
    Ok(ResolvedClient {
        http_client,
        emulation_orig_headers,
    })
}

fn response_allows_body(status: u16, method: &str) -> bool {
    if method.eq_ignore_ascii_case("HEAD") {
        return false;
    }

    match status {
        101 | 204 | 205 | 304 => false,
        _ => true,
    }
}

pub fn create_managed_session(session_id: String) -> Result<String> {
    SESSION_MANAGER.create_session(session_id)
}

pub fn clear_managed_session(session_id: &str) -> Result<()> {
    SESSION_MANAGER.clear_session(session_id)
}

pub fn drop_managed_session(session_id: &str) {
    SESSION_MANAGER.drop_session(session_id);
}

pub fn create_managed_transport(
    browser: Option<BrowserEmulation>,
    browser_os: Option<BrowserEmulationOS>,
    emulation_json: Option<Arc<str>>,
    proxy: Option<Arc<str>>,
    insecure: bool,
    pool_idle_timeout: Option<u64>,
    pool_max_idle_per_host: Option<usize>,
    pool_max_size: Option<u32>,
    connect_timeout: Option<u64>,
    read_timeout: Option<u64>,
) -> Result<String> {
    let config = TransportConfig::new(
        browser,
        browser_os,
        emulation_json,
        proxy,
        insecure,
        pool_idle_timeout,
        pool_max_idle_per_host,
        pool_max_size,
        connect_timeout,
        read_timeout,
    );
    TRANSPORT_MANAGER.create_transport(config)
}

pub fn drop_managed_transport(transport_id: &str) {
    TRANSPORT_MANAGER.drop_transport(transport_id);
}

pub fn generate_session_id() -> String {
    Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_request_options() -> RequestOptions {
        RequestOptions {
            url: "http://127.0.0.1".to_string(),
            browser: Some(BrowserEmulation::Chrome142),
            browser_os: Some(BrowserEmulationOS::MacOS),
            emulation_json: None,
            headers: Vec::new(),
            method: "GET".to_string(),
            body: None,
            proxy: None,
            timeout: 5_000,
            redirect: RedirectMode::Follow,
            session_id: "test-session".to_string(),
            ephemeral: true,
            disable_default_headers: false,
            insecure: false,
            transport_id: None,
            pool_idle_timeout: None,
            pool_max_idle_per_host: None,
            pool_max_size: None,
            connect_timeout: None,
            read_timeout: None,
            compress: true,
        }
    }

    #[test]
    fn ephemeral_session_cache_key_includes_socket_timeouts() {
        let base = base_request_options();

        let mut with_connect_timeout = base_request_options();
        with_connect_timeout.connect_timeout = Some(250);

        let mut with_read_timeout = base_request_options();
        with_read_timeout.read_timeout = Some(250);

        let base_config = SessionConfig::from_request(&base);
        let connect_config = SessionConfig::from_request(&with_connect_timeout);
        let read_config = SessionConfig::from_request(&with_read_timeout);

        assert_ne!(base_config, connect_config);
        assert_ne!(base_config, read_config);
        assert_ne!(connect_config, read_config);
    }
}

/// Get cookies from a session's jar that would be sent to the given URL
/// (RFC 6265 domain/path matching, secure filtering, expiry check).
pub fn get_session_cookies(session_id: &str, url: &str) -> Result<Vec<(String, String)>> {
    use wreq::cookie::CookieStore;

    let jar = SESSION_MANAGER.jar_for(session_id)?;
    let uri: wreq::Uri = url
        .parse()
        .with_context(|| format!("Invalid URL: {}", url))?;
    let cookie_header = jar.cookies(&uri);

    let pairs = match cookie_header {
        wreq::cookie::Cookies::Compressed(header_value) => {
            let s = header_value.to_str().unwrap_or("");
            parse_cookie_pairs(s)
        }
        wreq::cookie::Cookies::Uncompressed(values) => {
            let mut all = Vec::new();
            for hv in &values {
                if let Ok(s) = hv.to_str() {
                    all.extend(parse_cookie_pairs(s));
                }
            }
            all
        }
        wreq::cookie::Cookies::Empty => Vec::new(),
        _ => Vec::new(),
    };
    Ok(pairs)
}

fn parse_cookie_pairs(s: &str) -> Vec<(String, String)> {
    s.split("; ")
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let name = parts.next()?.trim();
            let value = parts.next().unwrap_or("").trim();
            if name.is_empty() {
                None
            } else {
                Some((name.to_owned(), value.to_owned()))
            }
        })
        .collect()
}

/// Add a cookie to a session's jar, scoped to the domain/path of the given URL.
pub fn set_session_cookie(session_id: &str, name: &str, value: &str, url: &str) -> Result<()> {
    use wreq::cookie::IntoCookie;

    let cookie_str = format!("{}={}", name, value);
    let cookie = cookie_str
        .as_str()
        .into_cookie()
        .ok_or_else(|| anyhow!("Invalid cookie string: {}", cookie_str))?;
    let uri: wreq::Uri = url
        .parse()
        .with_context(|| format!("Invalid URL: {}", url))?;

    let jar = SESSION_MANAGER.jar_for(session_id)?;
    jar.add(cookie, uri);
    Ok(())
}

/// Get the cookie jar for a session. Used by websocket to share cookies.
pub(crate) fn get_session_cookie_jar(session_id: &str) -> Result<Arc<Jar>> {
    SESSION_MANAGER.jar_for(session_id)
}

/// Get the resolved client for a transport. Used by websocket to share TLS config.
pub(crate) fn get_transport_resolved(transport_id: &str) -> Result<Arc<ResolvedClient>> {
    TRANSPORT_MANAGER.get_transport(transport_id)
}
