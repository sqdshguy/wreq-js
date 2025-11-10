mod client;
mod generated_profiles;
mod websocket;

use client::{
    clear_managed_session, create_managed_session, drop_managed_session, generate_session_id, make_request,
    RequestOptions, Response, HTTP_RUNTIME,
};
use futures_util::StreamExt;
use indexmap::IndexMap;
use neon::prelude::*;
use neon::types::{
    buffer::TypedArray, JsArray, JsBoolean, JsNull, JsObject, JsString, JsUndefined, JsValue,
};
use std::sync::Arc;
use tokio::sync::{mpsc, Semaphore};
use websocket::{
    connect_websocket, get_connection, remove_connection, store_connection, WebSocketOptions,
    WS_RUNTIME,
};
use wreq::ws::message::Message;
use wreq_util::Emulation;

const WS_EVENT_BUFFER: usize = 64;

// Parse browser string to Emulation enum using serde
fn parse_emulation(browser: &str) -> Emulation {
    // Use serde to deserialize the string into the enum
    // If deserialization fails, default to Chrome142
    serde_json::from_value(serde_json::Value::String(browser.to_string()))
        .unwrap_or(Emulation::Chrome142)
}

fn coerce_header_value(cx: &mut FunctionContext, value: Handle<JsValue>) -> NeonResult<String> {
    if let Ok(js_str) = value.downcast::<JsString, _>(cx) {
        return Ok(js_str.value(cx));
    }

    let converted = value.to_string(cx)?;
    Ok(converted.value(cx))
}

fn parse_header_tuple(cx: &mut FunctionContext, tuple: Handle<JsArray>) -> NeonResult<(String, String)> {
    if tuple.len(cx) < 2 {
        return cx.throw_type_error("Header tuple must contain a name and a value");
    }

    let name_value = tuple.get(cx, 0)?;
    let value_value = tuple.get(cx, 1)?;
    let name = coerce_header_value(cx, name_value)?;
    let value = coerce_header_value(cx, value_value)?;

    Ok((name, value))
}

fn parse_headers_from_array(cx: &mut FunctionContext, array: Handle<JsArray>) -> NeonResult<IndexMap<String, String>> {
    let mut headers = IndexMap::new();
    let len = array.len(cx);

    for i in 0..len {
        let element: Handle<JsValue> = array.get(cx, i)?;
        let tuple = element.downcast::<JsArray, _>(cx).or_throw(cx)?;
        let (name, value) = parse_header_tuple(cx, tuple)?;
        headers.insert(name, value);
    }

    Ok(headers)
}

fn parse_headers_from_object(cx: &mut FunctionContext, obj: Handle<JsObject>) -> NeonResult<IndexMap<String, String>> {
    let mut headers = IndexMap::new();
    let keys = obj.get_own_property_names(cx)?;
    let keys_vec = keys.to_vec(cx)?;

    for key_val in keys_vec {
        if let Ok(key_str) = key_val.downcast::<JsString, _>(cx) {
            let key = key_str.value(cx);
            let value = obj.get(cx, key.as_str())?;
            let value = coerce_header_value(cx, value)?;
            headers.insert(key, value);
        }
    }

    Ok(headers)
}

fn parse_headers_from_value(cx: &mut FunctionContext, value: Handle<JsValue>) -> NeonResult<IndexMap<String, String>> {
    if value.is_a::<JsUndefined, _>(cx) || value.is_a::<JsNull, _>(cx) {
        return Ok(IndexMap::new());
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

    // Get browser (optional, defaults to chrome_142)
    let browser_str = obj
        .get_opt(cx, "browser")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(cx).ok())
        .map(|v| v.value(cx))
        .unwrap_or_else(|| "chrome_142".to_string());

    let emulation = parse_emulation(&browser_str);

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
        IndexMap::new()
    };

    // Get body (optional)
    let body = obj
        .get_opt(cx, "body")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(cx).ok())
        .map(|v| v.value(cx));

    // Get proxy (optional)
    let proxy = obj
        .get_opt(cx, "proxy")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(cx).ok())
        .map(|v| v.value(cx));

    // Get timeout (optional, defaults to 30000ms)
    let timeout = obj
        .get_opt(cx, "timeout")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsNumber, _>(cx).ok())
        .map(|v| v.value(cx) as u64)
        .unwrap_or(30000);

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

    Ok(RequestOptions {
        url,
        emulation,
        headers,
        method,
        body,
        proxy,
        timeout,
        session_id,
        ephemeral,
        disable_default_headers,
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
    let headers_obj = cx.empty_object();
    for (key, value) in response.headers {
        let value_str = cx.string(&value);
        headers_obj.set(cx, key.as_str(), value_str)?;
    }
    obj.set(cx, "headers", headers_obj)?;

    // Cookies
    let cookies_obj = cx.empty_object();
    for (key, value) in response.cookies {
        let value_str = cx.string(&value);
        cookies_obj.set(cx, key.as_str(), value_str)?;
    }
    obj.set(cx, "cookies", cookies_obj)?;

    // Body
    let body = cx.string(&response.body);
    obj.set(cx, "body", body)?;

    Ok(obj)
}

// Main request function exported to Node.js
fn request(mut cx: FunctionContext) -> JsResult<JsPromise> {
    // Get the options object
    let options_obj = cx.argument::<JsObject>(0)?;

    // Convert JS object to Rust struct
    let options = js_object_to_request_options(&mut cx, options_obj)?;

    // Create a promise
    let (deferred, promise) = cx.promise();
    let settle_channel = cx.channel();

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

fn create_session(mut cx: FunctionContext) -> JsResult<JsString> {
    let options_value = cx.argument_opt(0);

    let (session_id_opt, browser_opt, proxy_opt) = if let Some(value) = options_value {
        if value.is_a::<JsUndefined, _>(&mut cx) || value.is_a::<JsNull, _>(&mut cx) {
            (None, None, None)
        } else {
            let obj = value.downcast_or_throw::<JsObject, _>(&mut cx)?;
            let session_id = obj
                .get_opt(&mut cx, "sessionId")?
                .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(&mut cx).ok())
                .map(|v| v.value(&mut cx));
            let browser = obj
                .get_opt(&mut cx, "browser")?
                .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(&mut cx).ok())
                .map(|v| v.value(&mut cx));
            let proxy = obj
                .get_opt(&mut cx, "proxy")?
                .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(&mut cx).ok())
                .map(|v| v.value(&mut cx));
            (session_id, browser, proxy)
        }
    } else {
        (None, None, None)
    };

    let session_id = session_id_opt.unwrap_or_else(generate_session_id);
    let browser_str = browser_opt.unwrap_or_else(|| "chrome_142".to_string());
    let emulation = parse_emulation(&browser_str);

    match create_managed_session(session_id.clone(), emulation, proxy_opt) {
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

fn drop_session(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let session_id = cx.argument::<JsString>(0)?.value(&mut cx);
    drop_managed_session(&session_id);
    Ok(cx.undefined())
}

// WebSocket connection function
fn websocket_connect(mut cx: FunctionContext) -> JsResult<JsPromise> {
    // Get the options object
    let options_obj = cx.argument::<JsObject>(0)?;

    // Get URL (required)
    let url: Handle<JsString> = options_obj.get(&mut cx, "url")?;
    let url = url.value(&mut cx);

    // Get browser (optional, defaults to chrome_142)
    let browser_str = options_obj
        .get_opt(&mut cx, "browser")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(&mut cx).ok())
        .map(|v| v.value(&mut cx))
        .unwrap_or_else(|| "chrome_142".to_string());

    let emulation = parse_emulation(&browser_str);

    // Get headers (optional)
    let headers = if let Ok(Some(headers_value)) = options_obj.get_opt(&mut cx, "headers") {
        parse_headers_from_value(&mut cx, headers_value)?
    } else {
        IndexMap::new()
    };

    // Get proxy (optional)
    let proxy = options_obj
        .get_opt(&mut cx, "proxy")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(&mut cx).ok())
        .map(|v| v.value(&mut cx));

    // Get callbacks
    let on_message: Handle<JsFunction> = options_obj.get(&mut cx, "onMessage")?;
    let on_close_opt = options_obj.get_opt::<JsFunction, _, _>(&mut cx, "onClose")?;
    let on_error_opt = options_obj.get_opt::<JsFunction, _, _>(&mut cx, "onError")?;

    let options = WebSocketOptions {
        url,
        emulation,
        headers,
        proxy,
    };

    // Create a promise
    let (deferred, promise) = cx.promise();
    let callbacks_channel = cx.channel();
    let settle_channel = callbacks_channel.clone();

    // Keep callbacks alive
    let on_message = Arc::new(on_message.root(&mut cx));
    let on_close = on_close_opt.map(|f| Arc::new(f.root(&mut cx)));
    let on_error = on_error_opt.map(|f| Arc::new(f.root(&mut cx)));

    WS_RUNTIME.spawn(async move {
        let result: Result<u64, anyhow::Error> = async {
            let (connection, mut receiver) = connect_websocket(options).await?;
            let id = store_connection(connection);

            let (events_tx, mut events_rx) = mpsc::channel::<WsEvent>(WS_EVENT_BUFFER);
            let receiver_tx = events_tx.clone();

            tokio::spawn(async move {
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
                        Ok(Message::Close(_)) => {
                            let _ = receiver_tx.send(WsEvent::Close).await;
                            break;
                        }
                        Ok(_) => {
                            // Ignore Ping/Pong
                        }
                        Err(e) => {
                            let _ = receiver_tx.send(WsEvent::Error(format!("{:#}", e))).await;
                            let _ = receiver_tx.send(WsEvent::Close).await;
                            break;
                        }
                    }
                }

                let _ = receiver_tx.send(WsEvent::Close).await;
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
                        WsEvent::Close => {
                            if !close_emitted {
                                if let Some(on_close_ref) = on_close_clone.as_ref() {
                                    let on_close_ref = on_close_ref.clone();
                                    channel_clone.send(move |mut cx| {
                                        let cb = on_close_ref.to_inner(&mut cx);
                                        let this = cx.undefined();
                                        cb.call(&mut cx, this, vec![])?;
                                        Ok(())
                                    });
                                }
                                close_emitted = true;
                            }
                        }
                    }
                }

                if !close_emitted {
                    if let Some(on_close_ref) = on_close_clone.as_ref() {
                        let on_close_ref = on_close_ref.clone();
                        channel_clone.send(move |mut cx| {
                            let cb = on_close_ref.to_inner(&mut cx);
                            let this = cx.undefined();
                            cb.call(&mut cx, this, vec![])?;
                            Ok(())
                        });
                    }
                }

                remove_connection(id);
            });

            Ok(id)
        }
        .await;

        deferred.settle_with(&settle_channel, move |mut cx| match result {
            Ok(id) => {
                let obj = cx.empty_object();
                let id_num = cx.number(id as f64);
                obj.set(&mut cx, "_id", id_num)?;
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

    WS_RUNTIME.spawn(async move {
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
    Close,
    Error(String),
}

// WebSocket close function
fn websocket_close(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let ws_obj = cx.argument::<JsObject>(0)?;

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

    WS_RUNTIME.spawn(async move {
        let result = connection.close().await;

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

// Module initialization
#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("request", request)?;
    cx.export_function("getProfiles", get_profiles)?;
    cx.export_function("createSession", create_session)?;
    cx.export_function("clearSession", clear_session)?;
    cx.export_function("dropSession", drop_session)?;
    cx.export_function("websocketConnect", websocket_connect)?;
    cx.export_function("websocketSend", websocket_send)?;
    cx.export_function("websocketClose", websocket_close)?;
    Ok(())
}
