use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use neon::prelude::*;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex;
use wreq::ws::message::Message;
use wreq::ws::WebSocket;
use wreq_util::Emulation;

// Global storage for WebSocket connections
static WS_CONNECTIONS: Lazy<StdMutex<HashMap<u64, Arc<WsConnection>>>> =
    Lazy::new(|| StdMutex::new(HashMap::new()));

static NEXT_WS_ID: Lazy<StdMutex<u64>> = Lazy::new(|| StdMutex::new(1));

// Global Tokio runtime for WebSocket operations
pub static WS_RUNTIME: Lazy<tokio::runtime::Runtime> = Lazy::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to create Tokio runtime for WebSockets")
});

#[derive(Debug, Clone)]
pub struct WebSocketOptions {
    pub url: String,
    pub emulation: Emulation,
    pub headers: HashMap<String, String>,
    pub proxy: Option<String>,
}

/// WebSocket connection wrapper
pub struct WsConnection {
    sender: Arc<Mutex<futures_util::stream::SplitSink<WebSocket, Message>>>,
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
    pub async fn close(&self) -> Result<()> {
        let mut sender = self.sender.lock().await;
        sender
            .send(Message::close(None))
            .await
            .context("Failed to close WebSocket")?;
        Ok(())
    }
}

// Finalize implementation for proper cleanup
impl Finalize for WsConnection {}

/// Store a WebSocket connection and return its ID
pub fn store_connection(connection: WsConnection) -> u64 {
    let mut id_lock = NEXT_WS_ID.lock().unwrap();
    let id = *id_lock;
    *id_lock += 1;
    drop(id_lock);

    let mut connections = WS_CONNECTIONS.lock().unwrap();
    connections.insert(id, Arc::new(connection));
    id
}

/// Get a WebSocket connection by ID
pub fn get_connection(id: u64) -> Option<Arc<WsConnection>> {
    let connections = WS_CONNECTIONS.lock().unwrap();
    connections.get(&id).cloned()
}

/// Remove a WebSocket connection
pub fn remove_connection(id: u64) {
    let mut connections = WS_CONNECTIONS.lock().unwrap();
    connections.remove(&id);
}

/// Create WebSocket connection
pub async fn connect_websocket(
    options: WebSocketOptions,
) -> Result<(WsConnection, futures_util::stream::SplitStream<WebSocket>)> {
    // Build client with emulation and proxy
    let mut client_builder = wreq::Client::builder().emulation(options.emulation);

    // Apply proxy if present
    if let Some(proxy_url) = &options.proxy {
        let proxy = wreq::Proxy::all(proxy_url).context("Failed to create proxy")?;
        client_builder = client_builder.proxy(proxy);
    }

    // Build the client
    let client = client_builder
        .build()
        .context("Failed to build HTTP client")?;

    // Create WebSocket request
    let mut request = client.websocket(&options.url);

    // Apply custom headers
    for (key, value) in &options.headers {
        request = request.header(key, value);
    }

    // Send upgrade request
    let ws_response = request
        .send()
        .await
        .context("Failed to send WebSocket upgrade request")?;

    // Upgrade to WebSocket
    let websocket = ws_response.into_websocket().await?;

    // Split into sender and receiver
    let (sender, receiver) = websocket.split();

    let connection = WsConnection::new(sender);

    Ok((connection, receiver))
}
