use anyhow::{Context, Result};
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use neon::prelude::*;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::Mutex;
use wreq::cookie::{CookieStore, Cookies};
use wreq::header::OrigHeaderMap;
use wreq::ws::WebSocket;
use wreq::ws::message::{CloseCode, CloseFrame, Message};

use crate::client::{get_session_cookie_jar, get_transport_resolved};
use crate::custom_emulation::resolve_emulation;
use wreq_util::{Emulation as BrowserEmulation, EmulationOS as BrowserEmulationOS};

// Global storage for WebSocket connections
static WS_CONNECTIONS: LazyLock<DashMap<u64, Arc<WsConnection>>> = LazyLock::new(DashMap::new);

static NEXT_WS_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone)]
pub struct WebSocketOptions {
    pub url: String,
    pub browser: Option<BrowserEmulation>,
    pub browser_os: Option<BrowserEmulationOS>,
    pub emulation_json: Option<Arc<str>>,
    pub headers: Vec<(String, String)>,
    pub protocols: Vec<String>,
    pub proxy: Option<Arc<str>>,
}

#[derive(Debug, Clone, Default)]
pub struct WebSocketUpgradeMetadata {
    pub protocol: Option<String>,
    pub extensions: Option<String>,
}

/// WebSocket connection wrapper
pub struct WsConnection {
    sender: Arc<Mutex<futures_util::stream::SplitSink<WebSocket, Message>>>,
}

#[derive(Clone, Debug)]
pub struct WsClosePayload {
    pub code: u16,
    pub reason: String,
}

impl WsConnection {
    pub fn new(sender: futures_util::stream::SplitSink<WebSocket, Message>) -> Self {
        Self {
            sender: Arc::new(Mutex::new(sender)),
        }
    }

    /// Send a text message
    pub async fn send_text(&self, text: String) -> Result<()> {
        let mut sender = self.sender.lock().await;
        sender
            .send(Message::text(text))
            .await
            .context("Failed to send text message")?;
        Ok(())
    }

    /// Send a binary message
    pub async fn send_binary(&self, data: Vec<u8>) -> Result<()> {
        let mut sender = self.sender.lock().await;
        sender
            .send(Message::binary(data))
            .await
            .context("Failed to send binary message")?;
        Ok(())
    }

    /// Close the WebSocket connection
    pub async fn close(&self, close_payload: Option<WsClosePayload>) -> Result<()> {
        let mut sender = self.sender.lock().await;

        let close_message = match close_payload {
            Some(payload) => Message::close(Some(CloseFrame {
                code: CloseCode::from(payload.code),
                reason: payload.reason.into(),
            })),
            None => Message::close(None),
        };

        sender
            .send(close_message)
            .await
            .context("Failed to close WebSocket")?;
        Ok(())
    }
}

// Finalize implementation for proper cleanup
impl Finalize for WsConnection {}

/// Store a WebSocket connection and return its ID
pub fn store_connection(connection: WsConnection) -> u64 {
    let id = NEXT_WS_ID.fetch_add(1, Ordering::Relaxed);
    WS_CONNECTIONS.insert(id, Arc::new(connection));
    id
}

/// Get a WebSocket connection by ID
pub fn get_connection(id: u64) -> Option<Arc<WsConnection>> {
    WS_CONNECTIONS.get(&id).map(|entry| entry.value().clone())
}

/// Remove a WebSocket connection
pub fn remove_connection(id: u64) {
    WS_CONNECTIONS.remove(&id);
}

/// Create WebSocket connection
pub async fn connect_websocket(
    options: WebSocketOptions,
) -> Result<(
    WsConnection,
    futures_util::stream::SplitStream<WebSocket>,
    WebSocketUpgradeMetadata,
)> {
    // Build client with emulation and proxy
    let mut emulation = resolve_emulation(
        options.browser,
        options.browser_os,
        options.emulation_json.as_deref(),
    )?;
    let emulation_orig_headers = emulation.orig_headers_mut().clone();
    let mut client_builder = wreq::Client::builder().emulation(emulation);

    // Apply proxy if present
    if let Some(proxy_url) = options.proxy.as_deref() {
        let proxy = wreq::Proxy::all(proxy_url).context("Failed to create proxy")?;
        client_builder = client_builder.proxy(proxy);
    }

    // Build the client
    let client = client_builder
        .build()
        .context("Failed to build HTTP client")?;

    connect_websocket_with_client(
        &client,
        &options.url,
        &options.headers,
        &options.protocols,
        &emulation_orig_headers,
    )
    .await
}

/// Create WebSocket connection using a session's cookies and transport's TLS config.
pub async fn connect_websocket_with_session(
    session_id: &str,
    transport_id: &str,
    url: &str,
    headers: &[(String, String)],
    protocols: &[String],
) -> Result<(
    WsConnection,
    futures_util::stream::SplitStream<WebSocket>,
    WebSocketUpgradeMetadata,
)> {
    let resolved = get_transport_resolved(transport_id)?;
    let cookie_jar = get_session_cookie_jar(session_id)?;

    // Extract cookies from the jar for this URL and inject as a Cookie header
    let uri: wreq::Uri = url.parse().context("Failed to parse WebSocket URL")?;
    let cookies = cookie_jar.cookies(&uri);

    let mut all_headers: Vec<(String, String)> = Vec::with_capacity(headers.len() + 1);
    let mut cookie_segments: Vec<String> = Vec::new();

    for (key, value) in headers.iter() {
        if key.eq_ignore_ascii_case("cookie") {
            if !value.trim().is_empty() {
                cookie_segments.push(value.trim().to_string());
            }
            continue;
        }

        all_headers.push((key.clone(), value.clone()));
    }

    match cookies {
        Cookies::Compressed(header_value) => {
            if let Ok(cookie_str) = header_value.to_str() {
                let trimmed = cookie_str.trim();
                if !trimmed.is_empty() {
                    cookie_segments.push(trimmed.to_string());
                }
            }
        }
        Cookies::Uncompressed(header_values) => {
            for hv in header_values {
                if let Ok(cookie_str) = hv.to_str() {
                    let trimmed = cookie_str.trim();
                    if !trimmed.is_empty() {
                        cookie_segments.push(trimmed.to_string());
                    }
                }
            }
        }
        Cookies::Empty => {}
        _ => {}
    }

    if !cookie_segments.is_empty() {
        all_headers.push(("Cookie".to_string(), cookie_segments.join("; ")));
    }

    connect_websocket_with_client(
        &resolved.http_client,
        url,
        &all_headers,
        protocols,
        &resolved.emulation_orig_headers,
    )
    .await
}

/// Build an OrigHeaderMap with Title-Case header names for HTTP/1.1 WebSocket
/// upgrade requests. Starts from any emulation-level origHeaders so that custom
/// emulation casing/order is preserved, then appends standard WS protocol
/// headers and user-provided headers.
fn build_ws_orig_headers(
    emulation_orig_headers: &OrigHeaderMap,
    user_headers: &[(String, String)],
) -> OrigHeaderMap {
    let mut orig = emulation_orig_headers.clone();

    // Standard headers in browser-typical order with Title-Case.
    // These cover both emulation-injected and wreq-internal WS headers.
    for name in [
        "Host",
        "Connection",
        "Pragma",
        "Cache-Control",
        "User-Agent",
        "Upgrade",
        "Origin",
        "Sec-WebSocket-Version",
        "Accept-Encoding",
        "Accept-Language",
        "Accept",
        "Cookie",
        "Sec-WebSocket-Key",
        "Sec-WebSocket-Extensions",
        "Sec-WebSocket-Protocol",
        "Sec-Fetch-Dest",
        "Sec-Fetch-Mode",
        "Sec-Fetch-Site",
        "Sec-Fetch-User",
    ] {
        orig.insert(name);
    }

    // User-provided headers with their original casing.
    for (key, _) in user_headers {
        orig.insert(key.clone());
    }

    orig
}

/// Internal: connect using an existing client.
async fn connect_websocket_with_client(
    client: &wreq::Client,
    url: &str,
    headers: &[(String, String)],
    protocols: &[String],
    emulation_orig_headers: &OrigHeaderMap,
) -> Result<(
    WsConnection,
    futures_util::stream::SplitStream<WebSocket>,
    WebSocketUpgradeMetadata,
)> {
    // Create WebSocket request
    let mut request = client.websocket(url);

    // Apply custom headers
    for (key, value) in headers.iter() {
        request = request.header(key, value);
    }

    if !protocols.is_empty() {
        request = request.protocols(protocols.iter().cloned());
    }

    // Set original header casing for HTTP/1.1 (Cloudflare rejects lowercase).
    // Merges emulation-level origHeaders with standard WS headers and user headers.
    request = request.orig_headers(build_ws_orig_headers(emulation_orig_headers, headers));

    // Send upgrade request
    let ws_response = request
        .send()
        .await
        .context("Failed to send WebSocket upgrade request")?;

    let protocol = ws_response
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let extensions = ws_response
        .headers()
        .get("sec-websocket-extensions")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());

    // Upgrade to WebSocket
    let websocket = ws_response.into_websocket().await?;

    // Split into sender and receiver
    let (sender, receiver) = websocket.split();

    let connection = WsConnection::new(sender);

    Ok((
        connection,
        receiver,
        WebSocketUpgradeMetadata {
            protocol,
            extensions,
        },
    ))
}
