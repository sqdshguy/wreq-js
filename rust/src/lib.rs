mod client;
mod custom_emulation;
mod generated_profiles;
mod websocket;

use anyhow::anyhow;
use client::{
    HTTP_RUNTIME, RedirectMode, RequestOptions, Response, clear_managed_session,
    create_managed_session, create_managed_transport, drop_body_stream, drop_managed_session,
    drop_managed_transport, generate_session_id, get_session_cookies, make_request,
    read_body_all as native_read_body_all, read_body_chunk as native_read_body_chunk,
    set_session_cookie,
};
use dashmap::DashMap;
use futures_util::StreamExt;
use neon::prelude::*;
use neon::types::{
    JsArray, JsBoolean, JsBuffer, JsNull, JsObject, JsString, JsUndefined, JsValue,
    buffer::TypedArray,
};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::LazyLock;
use tokio::sync::{Semaphore, mpsc};
use tokio_util::sync::CancellationToken;
use websocket::{
    WebSocketOptions, WebSocketUpgradeMetadata, WsClosePayload, WsConnection, connect_websocket,
    connect_websocket_with_session, get_connection, remove_connection, store_connection,
};
use wreq::ws::message::Message;
use wreq_util::{Emulation, EmulationOS};

const WS_EVENT_BUFFER: usize = 64;
static REQUEST_CANCELLATIONS: LazyLock<DashMap<u64, CancellationToken>> =
    LazyLock::new(DashMap::new);

// Parse browser string to Emulation enum using serde
fn parse_emulation(browser: &str) -> Emulation {
    static EMULATION_CACHE: LazyLock<HashMap<&'static str, Emulation>> = LazyLock::new(|| {
        generated_profiles::BROWSER_PROFILES
            .iter()
            .filter_map(|label| {
                // Populate cache once up-front; failures fall back to the default below.
                serde_json::from_value::<Emulation>(serde_json::Value::String((*label).to_string()))
                    .ok()
                    .map(|emulation| (*label, emulation))
            })
            .collect()
    });

    EMULATION_CACHE
        .get(browser)
        .cloned()
        .unwrap_or(Emulation::Chrome142)
}

fn parse_emulation_os(os: &str) -> EmulationOS {
    static OS_CACHE: LazyLock<HashMap<&'static str, EmulationOS>> = LazyLock::new(|| {
        generated_profiles::OPERATING_SYSTEMS
            .iter()
            .filter_map(|label| {
                serde_json::from_value::<EmulationOS>(serde_json::Value::String(
                    (*label).to_string(),
                ))
                .ok()
                .map(|emulation_os| (*label, emulation_os))
            })
            .collect()
    });

    OS_CACHE.get(os).cloned().unwrap_or(EmulationOS::MacOS)
}

fn coerce_header_value(cx: &mut FunctionContext, value: Handle<JsValue>) -> NeonResult<String> {
    if let Ok(js_str) = value.downcast::<JsString, _>(cx) {
        return Ok(js_str.value(cx));
    }

    let converted = value.to_string(cx)?;
    Ok(converted.value(cx))
}

fn parse_header_tuple(
    cx: &mut FunctionContext,
    tuple: Handle<JsArray>,
) -> NeonResult<(String, String)> {
    if tuple.len(cx) < 2 {
        return cx.throw_type_error("Header tuple must contain a name and a value");
    }

    let name_value = tuple.get(cx, 0)?;
    let value_value = tuple.get(cx, 1)?;
    let name = coerce_header_value(cx, name_value)?;
    let value = coerce_header_value(cx, value_value)?;

    Ok((name, value))
}

fn parse_headers_from_array(
    cx: &mut FunctionContext,
    array: Handle<JsArray>,
) -> NeonResult<Vec<(String, String)>> {
    let len = array.len(cx);
    let mut headers = Vec::with_capacity(len as usize);

    for i in 0..len {
        let element: Handle<JsValue> = array.get(cx, i)?;
        let tuple = element.downcast::<JsArray, _>(cx).or_throw(cx)?;
        let (name, value) = parse_header_tuple(cx, tuple)?;
        headers.push((name, value));
    }

    Ok(headers)
}

fn parse_headers_from_object(
    cx: &mut FunctionContext,
    obj: Handle<JsObject>,
) -> NeonResult<Vec<(String, String)>> {
    let keys = obj.get_own_property_names(cx)?;
    let keys_vec = keys.to_vec(cx)?;
    let mut headers = Vec::with_capacity(keys_vec.len());

    for key_val in keys_vec {
        if let Ok(key_str) = key_val.downcast::<JsString, _>(cx) {
            let key = key_str.value(cx);
            let value = obj.get(cx, key.as_str())?;
            let value = coerce_header_value(cx, value)?;
            headers.push((key, value));
        }
    }

    Ok(headers)
}

fn parse_headers_from_value(
    cx: &mut FunctionContext,
    value: Handle<JsValue>,
) -> NeonResult<Vec<(String, String)>> {
    if value.is_a::<JsUndefined, _>(cx) || value.is_a::<JsNull, _>(cx) {
        return Ok(Vec::new());
    }

    if value.is_a::<JsArray, _>(cx) {
        let array = value.downcast::<JsArray, _>(cx).or_throw(cx)?;
        return parse_headers_from_array(cx, array);
    }

    if value.is_a::<JsObject, _>(cx) {
        let obj = value.downcast::<JsObject, _>(cx).or_throw(cx)?;
        return parse_headers_from_object(cx, obj);
    }

    cx.throw_type_error("headers must be an array or object")
}

// Convert JS object to RequestOptions
fn js_object_to_request_options(
    cx: &mut FunctionContext,
    obj: Handle<JsObject>,
) -> NeonResult<RequestOptions> {
    // Get URL (required)
    let url: Handle<JsString> = obj.get(cx, "url")?;
    let url = url.value(cx);

    // Get browser/os/emulation mode as resolved by JS.
    let browser_str = obj
        .get_opt(cx, "browser")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(cx).ok())
        .map(|v| v.value(cx));

    let browser = browser_str.as_deref().map(parse_emulation);
    let os_str = obj
        .get_opt(cx, "os")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(cx).ok())
        .map(|v| v.value(cx));
    let browser_os = os_str.as_deref().map(parse_emulation_os);
    let emulation_json = obj
        .get_opt(cx, "emulationJson")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(cx).ok())
        .map(|v| Arc::<str>::from(v.value(cx)));

    // Get method (optional, defaults to GET)
    let method = obj
        .get_opt(cx, "method")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(cx).ok())
        .map(|v| v.value(cx))
        .unwrap_or_else(|| "GET".to_string());

    // Get headers (optional)
    let headers = if let Ok(Some(headers_val)) = obj.get_opt(cx, "headers") {
        parse_headers_from_value(cx, headers_val)?
    } else {
        Vec::new()
    };

    // Get body (optional)
    let body = if let Some(body_value) = obj.get_opt::<JsValue, _, _>(cx, "body")? {
        if body_value.is_a::<JsUndefined, _>(cx) || body_value.is_a::<JsNull, _>(cx) {
            None
        } else if let Ok(buffer) = body_value.downcast::<JsBuffer, _>(cx) {
            Some(buffer.as_slice(cx).to_vec())
        } else if let Ok(js_str) = body_value.downcast::<JsString, _>(cx) {
            Some(js_str.value(cx).into_bytes())
        } else {
            return cx.throw_type_error("body must be a string or Buffer");
        }
    } else {
        None
    };

    // Get proxy (optional)
    let proxy = obj
        .get_opt(cx, "proxy")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(cx).ok())
        .map(|v| Arc::<str>::from(v.value(cx)));

    // Get timeout (optional, defaults to 30000ms)
    let timeout = obj
        .get_opt(cx, "timeout")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsNumber, _>(cx).ok())
        .map(|v| v.value(cx) as u64)
        .unwrap_or(30000);

    // Get redirect policy (optional, defaults to follow)
    let redirect = obj
        .get_opt(cx, "redirect")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(cx).ok())
        .map(|v| v.value(cx))
        .unwrap_or_else(|| "follow".to_string());

    let redirect = match redirect.as_str() {
        "follow" => RedirectMode::Follow,
        "manual" => RedirectMode::Manual,
        "error" => RedirectMode::Error,
        other => return cx.throw_type_error(format!("Unsupported redirect mode: {}", other)),
    };

    // Get sessionId (optional)
    let session_id = obj
        .get_opt(cx, "sessionId")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(cx).ok())
        .map(|v| v.value(cx))
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(generate_session_id);

    let ephemeral = obj
        .get_opt(cx, "ephemeral")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsBoolean, _>(cx).ok())
        .map(|v| v.value(cx))
        .unwrap_or(false);

    let disable_default_headers = obj
        .get_opt(cx, "disableDefaultHeaders")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsBoolean, _>(cx).ok())
        .map(|v| v.value(cx))
        .unwrap_or(false);

    let insecure = obj
        .get_opt(cx, "insecure")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsBoolean, _>(cx).ok())
        .map(|v| v.value(cx))
        .unwrap_or(false);

    let compress = obj
        .get_opt(cx, "compress")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsBoolean, _>(cx).ok())
        .map(|v| v.value(cx))
        .unwrap_or(true);

    let transport_id = obj
        .get_opt(cx, "transportId")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(cx).ok())
        .map(|v| v.value(cx))
        .filter(|v| !v.trim().is_empty());

    let pool_idle_timeout = obj
        .get_opt(cx, "poolIdleTimeout")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsNumber, _>(cx).ok())
        .map(|v| v.value(cx) as u64);

    let pool_max_idle_per_host = obj
        .get_opt(cx, "poolMaxIdlePerHost")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsNumber, _>(cx).ok())
        .map(|v| v.value(cx) as usize);

    let pool_max_size = obj
        .get_opt(cx, "poolMaxSize")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsNumber, _>(cx).ok())
        .map(|v| v.value(cx) as u32);

    let connect_timeout = obj
        .get_opt(cx, "connectTimeout")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsNumber, _>(cx).ok())
        .map(|v| v.value(cx) as u64);

    let read_timeout = obj
        .get_opt(cx, "readTimeout")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsNumber, _>(cx).ok())
        .map(|v| v.value(cx) as u64);

    Ok(RequestOptions {
        url,
        browser,
        browser_os,
        emulation_json,
        headers,
        method,
        body,
        proxy,
        timeout,
        redirect,
        session_id,
        ephemeral,
        disable_default_headers,
        insecure,
        transport_id,
        pool_idle_timeout,
        pool_max_idle_per_host,
        pool_max_size,
        connect_timeout,
        read_timeout,
        compress,
    })
}

// Convert Response to JS object
fn response_to_js_object<'a, C: Context<'a>>(
    cx: &mut C,
    response: Response,
) -> JsResult<'a, JsObject> {
    let obj = cx.empty_object();

    // Status
    let status = cx.number(response.status as f64);
    obj.set(cx, "status", status)?;

    // URL
    let url = cx.string(&response.url);
    obj.set(cx, "url", url)?;

    // Headers
    let headers_arr = cx.empty_array();
    for (i, (key, value)) in response.headers.iter().enumerate() {
        let entry = cx.empty_array();
        let key_str = cx.string(key);
        let value_str = cx.string(value);
        entry.set(cx, 0, key_str)?;
        entry.set(cx, 1, value_str)?;
        headers_arr.set(cx, i as u32, entry)?;
    }
    obj.set(cx, "headers", headers_arr)?;

    // Cookies (as array of [key, value] tuples)
    let cookies_arr = cx.empty_array();
    for (i, (key, value)) in response.cookies.iter().enumerate() {
        let entry = cx.empty_array();
        let key_str = cx.string(key);
        let value_str = cx.string(value);
        entry.set(cx, 0, key_str)?;
        entry.set(cx, 1, value_str)?;
        cookies_arr.set(cx, i as u32, entry)?;
    }
    obj.set(cx, "cookies", cookies_arr)?;

    // Inline body bytes for small responses (avoids a second native round-trip)
    match response.body_bytes {
        Some(bytes) => {
            let buffer = JsBuffer::from_slice(cx, &bytes)?;
            obj.set(cx, "bodyBytes", buffer)?;
        }
        None => {
            let null_value = cx.null();
            obj.set(cx, "bodyBytes", null_value)?;
        }
    }

    // Body handle for streaming
    match response.body_handle {
        Some(handle) => {
            let handle_num = cx.number(handle as f64);
            obj.set(cx, "bodyHandle", handle_num)?;
        }
        None => {
            let null_value = cx.null();
            obj.set(cx, "bodyHandle", null_value)?;
        }
    }

    // Content-Length hint (if known)
    if let Some(len) = response.content_length {
        let len_num = cx.number(len as f64);
        obj.set(cx, "contentLength", len_num)?;
    } else {
        let null_value = cx.null();
        obj.set(cx, "contentLength", null_value)?;
    }

    Ok(obj)
}

// Main request function exported to Node.js
fn request(mut cx: FunctionContext) -> JsResult<JsPromise> {
    // Get the options object
    let options_obj = cx.argument::<JsObject>(0)?;
    let request_id = cx.argument::<JsNumber>(1)?.value(&mut cx) as u64;
    let cancellable = cx
        .argument_opt(2)
        .and_then(|value| value.downcast::<JsBoolean, _>(&mut cx).ok())
        .map(|b| b.value(&mut cx))
        .unwrap_or(true);

    // Convert JS object to Rust struct
    let options = js_object_to_request_options(&mut cx, options_obj)?;

    // Create a promise
    let (deferred, promise) = cx.promise();
    let settle_channel = cx.channel();

    if !cancellable {
        HTTP_RUNTIME.spawn(async move {
            let result = make_request(options).await;

            // Send result back to JS
            deferred.settle_with(&settle_channel, move |mut cx| match result {
                Ok(response) => response_to_js_object(&mut cx, response),
                Err(e) => {
                    // Format error with full chain for better debugging
                    let error_msg = format!("{:#}", e);
                    cx.throw_error(error_msg)
                }
            });
        });

        return Ok(promise);
    }

    let token = CancellationToken::new();
    REQUEST_CANCELLATIONS.insert(request_id, token.clone());

    HTTP_RUNTIME.spawn(async move {
        let result = tokio::select! {
            _ = token.cancelled() => Err(anyhow!("Request aborted")),
            res = make_request(options) => res,
        };

        REQUEST_CANCELLATIONS.remove(&request_id);

        // Send result back to JS
        deferred.settle_with(&settle_channel, move |mut cx| match result {
            Ok(response) => response_to_js_object(&mut cx, response),
            Err(e) => {
                // Format error with full chain for better debugging
                let error_msg = format!("{:#}", e);
                cx.throw_error(error_msg)
            }
        });
    });

    Ok(promise)
}

// Get list of available browser profiles
fn get_profiles(mut cx: FunctionContext) -> JsResult<JsArray> {
    let js_array = cx.empty_array();

    for (i, profile) in generated_profiles::BROWSER_PROFILES.iter().enumerate() {
        let js_string = cx.string(*profile);
        js_array.set(&mut cx, i as u32, js_string)?;
    }

    Ok(js_array)
}

// Get list of available operating systems for emulation
fn get_operating_systems(mut cx: FunctionContext) -> JsResult<JsArray> {
    let js_array = cx.empty_array();

    for (i, os) in generated_profiles::OPERATING_SYSTEMS.iter().enumerate() {
        let js_string = cx.string(*os);
        js_array.set(&mut cx, i as u32, js_string)?;
    }

    Ok(js_array)
}

fn create_session(mut cx: FunctionContext) -> JsResult<JsString> {
    let options_value = cx.argument_opt(0);

    let session_id_opt = if let Some(value) = options_value {
        if value.is_a::<JsUndefined, _>(&mut cx) || value.is_a::<JsNull, _>(&mut cx) {
            None
        } else {
            let obj = value.downcast_or_throw::<JsObject, _>(&mut cx)?;
            let session_id = obj
                .get_opt(&mut cx, "sessionId")?
                .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(&mut cx).ok())
                .map(|v| v.value(&mut cx));
            session_id
        }
    } else {
        None
    };

    let session_id = session_id_opt.unwrap_or_else(generate_session_id);

    match create_managed_session(session_id.clone()) {
        Ok(id) => Ok(cx.string(id)),
        Err(e) => {
            let msg = format!("{:#}", e);
            cx.throw_error(msg)
        }
    }
}

fn create_transport(mut cx: FunctionContext) -> JsResult<JsString> {
    let options_value = cx.argument_opt(0);

    let (
        browser_opt,
        os_opt,
        emulation_json_opt,
        proxy_opt,
        insecure_opt,
        pool_idle_timeout_opt,
        pool_max_idle_per_host_opt,
        pool_max_size_opt,
        connect_timeout_opt,
        read_timeout_opt,
    ) = if let Some(value) = options_value {
        if value.is_a::<JsUndefined, _>(&mut cx) || value.is_a::<JsNull, _>(&mut cx) {
            (None, None, None, None, None, None, None, None, None, None)
        } else {
            let obj = value.downcast_or_throw::<JsObject, _>(&mut cx)?;
            let browser = obj
                .get_opt(&mut cx, "browser")?
                .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(&mut cx).ok())
                .map(|v| v.value(&mut cx));
            let os = obj
                .get_opt(&mut cx, "os")?
                .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(&mut cx).ok())
                .map(|v| v.value(&mut cx));
            let emulation_json = obj
                .get_opt(&mut cx, "emulationJson")?
                .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(&mut cx).ok())
                .map(|v| Arc::<str>::from(v.value(&mut cx)));
            let proxy = obj
                .get_opt(&mut cx, "proxy")?
                .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(&mut cx).ok())
                .map(|v| Arc::<str>::from(v.value(&mut cx)));
            let insecure = obj
                .get_opt(&mut cx, "insecure")?
                .and_then(|v: Handle<JsValue>| v.downcast::<JsBoolean, _>(&mut cx).ok())
                .map(|v| v.value(&mut cx));
            let pool_idle_timeout = obj
                .get_opt(&mut cx, "poolIdleTimeout")?
                .and_then(|v: Handle<JsValue>| v.downcast::<JsNumber, _>(&mut cx).ok())
                .map(|v| v.value(&mut cx) as u64);
            let pool_max_idle_per_host = obj
                .get_opt(&mut cx, "poolMaxIdlePerHost")?
                .and_then(|v: Handle<JsValue>| v.downcast::<JsNumber, _>(&mut cx).ok())
                .map(|v| v.value(&mut cx) as usize);
            let pool_max_size = obj
                .get_opt(&mut cx, "poolMaxSize")?
                .and_then(|v: Handle<JsValue>| v.downcast::<JsNumber, _>(&mut cx).ok())
                .map(|v| v.value(&mut cx) as u32);
            let connect_timeout = obj
                .get_opt(&mut cx, "connectTimeout")?
                .and_then(|v: Handle<JsValue>| v.downcast::<JsNumber, _>(&mut cx).ok())
                .map(|v| v.value(&mut cx) as u64);
            let read_timeout = obj
                .get_opt(&mut cx, "readTimeout")?
                .and_then(|v: Handle<JsValue>| v.downcast::<JsNumber, _>(&mut cx).ok())
                .map(|v| v.value(&mut cx) as u64);

            (
                browser,
                os,
                emulation_json,
                proxy,
                insecure,
                pool_idle_timeout,
                pool_max_idle_per_host,
                pool_max_size,
                connect_timeout,
                read_timeout,
            )
        }
    } else {
        (None, None, None, None, None, None, None, None, None, None)
    };

    let browser = browser_opt.as_deref().map(parse_emulation);
    let browser_os = os_opt.as_deref().map(parse_emulation_os);
    let insecure = insecure_opt.unwrap_or(false);

    match create_managed_transport(
        browser,
        browser_os,
        emulation_json_opt,
        proxy_opt,
        insecure,
        pool_idle_timeout_opt,
        pool_max_idle_per_host_opt,
        pool_max_size_opt,
        connect_timeout_opt,
        read_timeout_opt,
    ) {
        Ok(id) => Ok(cx.string(id)),
        Err(e) => {
            let msg = format!("{:#}", e);
            cx.throw_error(msg)
        }
    }
}

fn clear_session(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let session_id = cx.argument::<JsString>(0)?.value(&mut cx);

    if let Err(e) = clear_managed_session(&session_id) {
        let msg = format!("{:#}", e);
        return cx.throw_error(msg);
    }

    Ok(cx.undefined())
}

fn drop_transport(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let transport_id = cx.argument::<JsString>(0)?.value(&mut cx);
    drop_managed_transport(&transport_id);
    Ok(cx.undefined())
}

fn drop_session(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let session_id = cx.argument::<JsString>(0)?.value(&mut cx);
    drop_managed_session(&session_id);
    Ok(cx.undefined())
}

fn cancel_request(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let request_id = cx.argument::<JsNumber>(0)?.value(&mut cx) as u64;

    if let Some((_, token)) = REQUEST_CANCELLATIONS.remove(&request_id) {
        token.cancel();
    }

    Ok(cx.undefined())
}

fn read_body_chunk(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let handle_id = cx.argument::<JsNumber>(0)?.value(&mut cx) as u64;

    let (deferred, promise) = cx.promise();
    let settle_channel = cx.channel();

    HTTP_RUNTIME.spawn(async move {
        let result = native_read_body_chunk(handle_id).await;

        deferred.settle_with(&settle_channel, move |mut cx| match result {
            Ok(Some(bytes)) => {
                let buffer = JsBuffer::from_slice(&mut cx, &bytes)?;
                let value: Handle<JsValue> = buffer.upcast();
                Ok(value)
            }
            Ok(None) => Ok(cx.null().upcast()),
            Err(e) => {
                let error_msg = format!("{:#}", e);
                cx.throw_error(error_msg)
            }
        });
    });

    Ok(promise)
}

fn cancel_body_stream(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_id = cx.argument::<JsNumber>(0)?.value(&mut cx) as u64;
    drop_body_stream(handle_id);
    Ok(cx.undefined())
}

/// Read entire body into a single Buffer. More efficient than streaming for small responses.
fn read_body_all(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let handle_id = cx.argument::<JsNumber>(0)?.value(&mut cx) as u64;

    let (deferred, promise) = cx.promise();
    let settle_channel = cx.channel();

    HTTP_RUNTIME.spawn(async move {
        let result = native_read_body_all(handle_id).await;

        deferred.settle_with(&settle_channel, move |mut cx| match result {
            Ok(bytes) => {
                let buffer = JsBuffer::from_slice(&mut cx, &bytes)?;
                Ok(buffer)
            }
            Err(e) => {
                let error_msg = format!("{:#}", e);
                cx.throw_error(error_msg)
            }
        });
    });

    Ok(promise)
}

// Shared helper: wire up WebSocket receiver callbacks and return connection ID
fn setup_ws_callbacks(
    connection: WsConnection,
    mut receiver: futures_util::stream::SplitStream<wreq::ws::WebSocket>,
    on_message: Arc<neon::handle::Root<JsFunction>>,
    on_close: Option<Arc<neon::handle::Root<JsFunction>>>,
    on_error: Option<Arc<neon::handle::Root<JsFunction>>>,
    callbacks_channel: neon::event::Channel,
) -> u64 {
    let id = store_connection(connection);

    let (events_tx, mut events_rx) = mpsc::channel::<WsEvent>(WS_EVENT_BUFFER);
    let receiver_tx = events_tx.clone();

    tokio::spawn(async move {
        let mut close_sent = false;

        while let Some(msg_result) = receiver.next().await {
            match msg_result {
                Ok(Message::Text(text)) => {
                    if receiver_tx
                        .send(WsEvent::Text(text.to_string()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(Message::Binary(data)) => {
                    if receiver_tx
                        .send(WsEvent::Binary(data.to_vec()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(Message::Close(close_frame)) => {
                    let close_event = close_frame
                        .map(|frame| WsCloseEvent {
                            code: u16::from(frame.code),
                            reason: frame.reason.to_string(),
                        })
                        .unwrap_or_else(default_ws_close_event);
                    let _ = receiver_tx.send(WsEvent::Close(close_event)).await;
                    close_sent = true;
                    break;
                }
                Ok(_) => {
                    // Ignore Ping/Pong
                }
                Err(e) => {
                    let _ = receiver_tx.send(WsEvent::Error(format!("{:#}", e))).await;
                    let _ = receiver_tx
                        .send(WsEvent::Close(abnormal_ws_close_event()))
                        .await;
                    close_sent = true;
                    break;
                }
            }
        }

        if !close_sent {
            let _ = receiver_tx
                .send(WsEvent::Close(abnormal_ws_close_event()))
                .await;
        }
    });

    drop(events_tx);

    let on_message_clone = on_message.clone();
    let on_close_clone = on_close.clone();
    let on_error_clone = on_error.clone();
    let channel_clone = callbacks_channel.clone();
    let permits_consumer = Arc::new(Semaphore::new(WS_EVENT_BUFFER));

    tokio::spawn(async move {
        let mut close_emitted = false;
        while let Some(event) = events_rx.recv().await {
            match event {
                WsEvent::Text(text) => {
                    let permit = match permits_consumer.clone().acquire_owned().await {
                        Ok(permit) => permit,
                        Err(_) => break,
                    };
                    let on_message_ref = on_message_clone.clone();
                    channel_clone.send(move |mut cx| {
                        let _permit = permit;
                        let cb = on_message_ref.to_inner(&mut cx);
                        let this = cx.undefined();
                        let args = vec![cx.string(text).upcast()];
                        cb.call(&mut cx, this, args)?;
                        Ok(())
                    });
                }
                WsEvent::Binary(data) => {
                    let permit = match permits_consumer.clone().acquire_owned().await {
                        Ok(permit) => permit,
                        Err(_) => break,
                    };
                    let on_message_ref = on_message_clone.clone();
                    channel_clone.send(move |mut cx| {
                        let _permit = permit;
                        let cb = on_message_ref.to_inner(&mut cx);
                        let this = cx.undefined();
                        let mut buffer = cx.buffer(data.len())?;
                        buffer.as_mut_slice(&mut cx).copy_from_slice(&data);
                        let args = vec![buffer.upcast()];
                        cb.call(&mut cx, this, args)?;
                        Ok(())
                    });
                }
                WsEvent::Error(error_msg) => {
                    if let Some(on_error_ref) = on_error_clone.as_ref() {
                        let on_error_ref = on_error_ref.clone();
                        channel_clone.send(move |mut cx| {
                            let cb = on_error_ref.to_inner(&mut cx);
                            let this = cx.undefined();
                            let args = vec![cx.string(error_msg).upcast()];
                            cb.call(&mut cx, this, args)?;
                            Ok(())
                        });
                    }
                }
                WsEvent::Close(close_event) => {
                    if !close_emitted {
                        if let Some(on_close_ref) = on_close_clone.as_ref() {
                            let on_close_ref = on_close_ref.clone();
                            channel_clone.send(move |mut cx| {
                                let cb = on_close_ref.to_inner(&mut cx);
                                let this = cx.undefined();
                                let event = cx.empty_object();
                                let code = cx.number(close_event.code as f64);
                                let reason = cx.string(close_event.reason);
                                event.set(&mut cx, "code", code)?;
                                event.set(&mut cx, "reason", reason)?;
                                cb.call(&mut cx, this, vec![event.upcast()])?;
                                Ok(())
                            });
                        }
                        close_emitted = true;
                    }
                }
            }
        }

        if !close_emitted && let Some(on_close_ref) = on_close_clone.as_ref() {
            let on_close_ref = on_close_ref.clone();
            channel_clone.send(move |mut cx| {
                let cb = on_close_ref.to_inner(&mut cx);
                let this = cx.undefined();
                let event = cx.empty_object();
                let code = cx.number(1006f64);
                let reason = cx.string("");
                event.set(&mut cx, "code", code)?;
                event.set(&mut cx, "reason", reason)?;
                cb.call(&mut cx, this, vec![event.upcast()])?;
                Ok(())
            });
        }

        remove_connection(id);
    });

    id
}

// Helper: extract callbacks from options object
fn extract_ws_callbacks(
    cx: &mut FunctionContext,
    options_obj: &Handle<JsObject>,
) -> NeonResult<(
    Arc<neon::handle::Root<JsFunction>>,
    Option<Arc<neon::handle::Root<JsFunction>>>,
    Option<Arc<neon::handle::Root<JsFunction>>>,
)> {
    let on_message: Handle<JsFunction> = options_obj.get(cx, "onMessage")?;
    let on_close_opt = options_obj.get_opt::<JsFunction, _, _>(cx, "onClose")?;
    let on_error_opt = options_obj.get_opt::<JsFunction, _, _>(cx, "onError")?;

    let on_message = Arc::new(on_message.root(cx));
    let on_close = on_close_opt.map(|f| Arc::new(f.root(cx)));
    let on_error = on_error_opt.map(|f| Arc::new(f.root(cx)));

    Ok((on_message, on_close, on_error))
}

// Helper: extract headers from options object
fn extract_ws_headers(
    cx: &mut FunctionContext,
    options_obj: &Handle<JsObject>,
) -> NeonResult<Vec<(String, String)>> {
    if let Ok(Some(headers_value)) = options_obj.get_opt(cx, "headers") {
        parse_headers_from_value(cx, headers_value)
    } else {
        Ok(Vec::new())
    }
}

// Helper: extract WebSocket protocols from options object
fn extract_ws_protocols(
    cx: &mut FunctionContext,
    options_obj: &Handle<JsObject>,
) -> NeonResult<Vec<String>> {
    let Some(protocols_value) = options_obj.get_opt::<JsValue, _, _>(cx, "protocols")? else {
        return Ok(Vec::new());
    };

    if protocols_value.is_a::<JsUndefined, _>(cx) || protocols_value.is_a::<JsNull, _>(cx) {
        return Ok(Vec::new());
    }

    if let Ok(protocol) = protocols_value.downcast::<JsString, _>(cx) {
        return Ok(vec![protocol.value(cx)]);
    }

    if let Ok(protocols_array) = protocols_value.downcast::<JsArray, _>(cx) {
        let len = protocols_array.len(cx);
        let mut protocols = Vec::with_capacity(len as usize);

        for i in 0..len {
            let value: Handle<JsValue> = protocols_array.get(cx, i)?;
            let protocol = value.downcast_or_throw::<JsString, _>(cx)?.value(cx);
            protocols.push(protocol);
        }

        return Ok(protocols);
    }

    cx.throw_type_error("protocols must be a string or string array")
}

// WebSocket connection function (standalone, no session)
fn websocket_connect(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let options_obj = cx.argument::<JsObject>(0)?;

    let url: Handle<JsString> = options_obj.get(&mut cx, "url")?;
    let url = url.value(&mut cx);

    let browser_str = options_obj
        .get_opt(&mut cx, "browser")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(&mut cx).ok())
        .map(|v| v.value(&mut cx));
    let browser = browser_str.as_deref().map(parse_emulation);
    let os_str = options_obj
        .get_opt(&mut cx, "os")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(&mut cx).ok())
        .map(|v| v.value(&mut cx));
    let browser_os = os_str.as_deref().map(parse_emulation_os);
    let emulation_json = options_obj
        .get_opt(&mut cx, "emulationJson")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(&mut cx).ok())
        .map(|v| Arc::<str>::from(v.value(&mut cx)));

    let headers = extract_ws_headers(&mut cx, &options_obj)?;
    let protocols = extract_ws_protocols(&mut cx, &options_obj)?;

    let proxy = options_obj
        .get_opt(&mut cx, "proxy")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(&mut cx).ok())
        .map(|v| Arc::<str>::from(v.value(&mut cx)));

    let (on_message, on_close, on_error) = extract_ws_callbacks(&mut cx, &options_obj)?;

    let options = WebSocketOptions {
        url,
        browser,
        browser_os,
        emulation_json,
        headers,
        protocols,
        proxy,
    };

    let (deferred, promise) = cx.promise();
    let callbacks_channel = cx.channel();
    let settle_channel = callbacks_channel.clone();

    HTTP_RUNTIME.spawn(async move {
        let result: Result<(u64, WebSocketUpgradeMetadata), anyhow::Error> = async {
            let (connection, receiver, metadata) = connect_websocket(options).await?;
            let id = setup_ws_callbacks(
                connection,
                receiver,
                on_message,
                on_close,
                on_error,
                callbacks_channel,
            );
            Ok((id, metadata))
        }
        .await;

        deferred.settle_with(&settle_channel, move |mut cx| match result {
            Ok((id, metadata)) => {
                let obj = cx.empty_object();
                let id_num = cx.number(id as f64);
                obj.set(&mut cx, "_id", id_num)?;
                if let Some(protocol) = metadata.protocol {
                    let protocol_value = cx.string(protocol);
                    obj.set(&mut cx, "protocol", protocol_value)?;
                }
                if let Some(extensions) = metadata.extensions {
                    let extensions_value = cx.string(extensions);
                    obj.set(&mut cx, "extensions", extensions_value)?;
                }
                Ok(obj)
            }
            Err(e) => {
                let error_msg = format!("{:#}", e);
                cx.throw_error(error_msg)
            }
        });
    });

    Ok(promise)
}

// WebSocket connection with session (shares cookies and transport TLS config)
fn websocket_connect_session(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let options_obj = cx.argument::<JsObject>(0)?;

    let url: Handle<JsString> = options_obj.get(&mut cx, "url")?;
    let url = url.value(&mut cx);

    let session_id: Handle<JsString> = options_obj.get(&mut cx, "sessionId")?;
    let session_id = session_id.value(&mut cx);

    let transport_id: Handle<JsString> = options_obj.get(&mut cx, "transportId")?;
    let transport_id = transport_id.value(&mut cx);

    let headers = extract_ws_headers(&mut cx, &options_obj)?;
    let protocols = extract_ws_protocols(&mut cx, &options_obj)?;
    let (on_message, on_close, on_error) = extract_ws_callbacks(&mut cx, &options_obj)?;

    let (deferred, promise) = cx.promise();
    let callbacks_channel = cx.channel();
    let settle_channel = callbacks_channel.clone();

    HTTP_RUNTIME.spawn(async move {
        let result: Result<(u64, WebSocketUpgradeMetadata), anyhow::Error> = async {
            let (connection, receiver, metadata) = connect_websocket_with_session(
                &session_id,
                &transport_id,
                &url,
                &headers,
                &protocols,
            )
            .await?;
            let id = setup_ws_callbacks(
                connection,
                receiver,
                on_message,
                on_close,
                on_error,
                callbacks_channel,
            );
            Ok((id, metadata))
        }
        .await;

        deferred.settle_with(&settle_channel, move |mut cx| match result {
            Ok((id, metadata)) => {
                let obj = cx.empty_object();
                let id_num = cx.number(id as f64);
                obj.set(&mut cx, "_id", id_num)?;
                if let Some(protocol) = metadata.protocol {
                    let protocol_value = cx.string(protocol);
                    obj.set(&mut cx, "protocol", protocol_value)?;
                }
                if let Some(extensions) = metadata.extensions {
                    let extensions_value = cx.string(extensions);
                    obj.set(&mut cx, "extensions", extensions_value)?;
                }
                Ok(obj)
            }
            Err(e) => {
                let error_msg = format!("{:#}", e);
                cx.throw_error(error_msg)
            }
        });
    });

    Ok(promise)
}

// WebSocket send function
fn websocket_send(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let ws_obj = cx.argument::<JsObject>(0)?;
    let data = cx.argument::<JsValue>(1)?;

    // Get the connection ID from the object
    let id_val: Handle<JsNumber> = ws_obj.get(&mut cx, "_id")?;
    let id = id_val.value(&mut cx) as u64;

    // Get connection from global storage
    let connection = match get_connection(id) {
        Some(conn) => conn,
        None => return cx.throw_error("WebSocket connection not found"),
    };

    let (deferred, promise) = cx.promise();
    let settle_channel = cx.channel();

    // Check if data is string or buffer
    let is_text = data.is_a::<JsString, _>(&mut cx);
    let send_data = if is_text {
        let text = data.downcast_or_throw::<JsString, _>(&mut cx)?;
        SendData::Text(text.value(&mut cx))
    } else if let Ok(buffer) = data.downcast::<JsBuffer, _>(&mut cx) {
        let data = buffer.as_slice(&cx).to_vec();
        SendData::Binary(data)
    } else {
        return cx.throw_error("Data must be a string or Buffer");
    };

    HTTP_RUNTIME.spawn(async move {
        let result = match send_data {
            SendData::Text(text) => connection.send_text(text).await,
            SendData::Binary(data) => connection.send_binary(data).await,
        };

        deferred.settle_with(&settle_channel, move |mut cx| match result {
            Ok(()) => Ok(cx.undefined()),
            Err(e) => {
                let error_msg = format!("{:#}", e);
                cx.throw_error(error_msg)
            }
        });
    });

    Ok(promise)
}

enum SendData {
    Text(String),
    Binary(Vec<u8>),
}

enum WsEvent {
    Text(String),
    Binary(Vec<u8>),
    Close(WsCloseEvent),
    Error(String),
}

#[derive(Clone)]
struct WsCloseEvent {
    code: u16,
    reason: String,
}

fn default_ws_close_event() -> WsCloseEvent {
    // RFC 6455 reserved "no status received" code used when no close frame payload exists.
    WsCloseEvent {
        code: 1005,
        reason: String::new(),
    }
}

fn abnormal_ws_close_event() -> WsCloseEvent {
    // RFC 6455 abnormal closure code used when the connection drops unexpectedly.
    WsCloseEvent {
        code: 1006,
        reason: String::new(),
    }
}

// WebSocket close function
fn websocket_close(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let ws_obj = cx.argument::<JsObject>(0)?;
    let close_payload = if let Some(close_value) = cx.argument_opt(1) {
        if close_value.is_a::<JsUndefined, _>(&mut cx) || close_value.is_a::<JsNull, _>(&mut cx) {
            None
        } else {
            let close_obj = close_value.downcast_or_throw::<JsObject, _>(&mut cx)?;
            let code = close_obj
                .get_opt::<JsNumber, _, _>(&mut cx, "code")?
                .map(|num| num.value(&mut cx) as u16)
                .unwrap_or(1000);
            let reason = close_obj
                .get_opt::<JsString, _, _>(&mut cx, "reason")?
                .map(|value| value.value(&mut cx))
                .unwrap_or_default();

            Some(WsClosePayload { code, reason })
        }
    } else {
        None
    };

    // Get the connection ID from the object
    let id_val: Handle<JsNumber> = ws_obj.get(&mut cx, "_id")?;
    let id = id_val.value(&mut cx) as u64;

    // Get connection from global storage
    let connection = match get_connection(id) {
        Some(conn) => conn,
        None => return cx.throw_error("WebSocket connection not found"),
    };

    let (deferred, promise) = cx.promise();
    let settle_channel = cx.channel();

    HTTP_RUNTIME.spawn(async move {
        let result = connection.close(close_payload).await;

        // Remove connection from storage after closing
        remove_connection(id);

        deferred.settle_with(&settle_channel, move |mut cx| match result {
            Ok(()) => Ok(cx.undefined()),
            Err(e) => {
                let error_msg = format!("{:#}", e);
                cx.throw_error(error_msg)
            }
        });
    });

    Ok(promise)
}

fn get_cookies(mut cx: FunctionContext) -> JsResult<JsObject> {
    let session_id = cx.argument::<JsString>(0)?.value(&mut cx);
    let url = cx.argument::<JsString>(1)?.value(&mut cx);

    match get_session_cookies(&session_id, &url) {
        Ok(cookies) => {
            let obj = cx.empty_object();
            for (name, value) in cookies {
                let js_value = cx.string(&value);
                obj.set(&mut cx, name.as_str(), js_value)?;
            }
            Ok(obj)
        }
        Err(e) => {
            let msg = format!("{:#}", e);
            cx.throw_error(msg)
        }
    }
}

fn set_cookie(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let session_id = cx.argument::<JsString>(0)?.value(&mut cx);
    let name = cx.argument::<JsString>(1)?.value(&mut cx);
    let value = cx.argument::<JsString>(2)?.value(&mut cx);
    let url = cx.argument::<JsString>(3)?.value(&mut cx);

    if let Err(e) = set_session_cookie(&session_id, &name, &value, &url) {
        let msg = format!("{:#}", e);
        return cx.throw_error(msg);
    }

    Ok(cx.undefined())
}

// Module initialization
#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("request", request)?;
    cx.export_function("cancelRequest", cancel_request)?;
    cx.export_function("readBodyChunk", read_body_chunk)?;
    cx.export_function("readBodyAll", read_body_all)?;
    cx.export_function("cancelBody", cancel_body_stream)?;
    cx.export_function("getProfiles", get_profiles)?;
    cx.export_function("getOperatingSystems", get_operating_systems)?;
    cx.export_function("createSession", create_session)?;
    cx.export_function("clearSession", clear_session)?;
    cx.export_function("dropSession", drop_session)?;
    cx.export_function("getCookies", get_cookies)?;
    cx.export_function("setCookie", set_cookie)?;
    cx.export_function("createTransport", create_transport)?;
    cx.export_function("dropTransport", drop_transport)?;
    cx.export_function("websocketConnect", websocket_connect)?;
    cx.export_function("websocketConnectSession", websocket_connect_session)?;
    cx.export_function("websocketSend", websocket_send)?;
    cx.export_function("websocketClose", websocket_close)?;
    Ok(())
}
