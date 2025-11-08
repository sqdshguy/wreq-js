mod client;
mod generated_profiles;
mod websocket;

use client::{make_request, RequestOptions, Response, HTTP_RUNTIME};
use futures_util::StreamExt;
use neon::prelude::*;
use neon::types::buffer::TypedArray;
use std::collections::HashMap;
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
    // If deserialization fails, default to Chrome137
    serde_json::from_value(serde_json::Value::String(browser.to_string()))
        .unwrap_or(Emulation::Chrome137)
}

// Convert JS object to RequestOptions
fn js_object_to_request_options(
    cx: &mut FunctionContext,
    obj: Handle<JsObject>,
) -> NeonResult<RequestOptions> {
    // Get URL (required)
    let url: Handle<JsString> = obj.get(cx, "url")?;
    let url = url.value(cx);

    // Get browser (optional, defaults to chrome_137)
    let browser_str = obj
        .get_opt(cx, "browser")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(cx).ok())
        .map(|v| v.value(cx))
        .unwrap_or_else(|| "chrome_137".to_string());

    let emulation = parse_emulation(&browser_str);

    // Get method (optional, defaults to GET)
    let method = obj
        .get_opt(cx, "method")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(cx).ok())
        .map(|v| v.value(cx))
        .unwrap_or_else(|| "GET".to_string());

    // Get headers (optional)
    let mut headers = HashMap::new();
    if let Ok(Some(headers_obj)) = obj.get_opt::<JsObject, _, _>(cx, "headers") {
        let keys = headers_obj.get_own_property_names(cx)?;
        let keys_vec = keys.to_vec(cx)?;

        for key_val in keys_vec {
            if let Ok(key_str) = key_val.downcast::<JsString, _>(cx) {
                let key = key_str.value(cx);
                if let Ok(value) = headers_obj.get::<JsString, _, _>(cx, key.as_str()) {
                    headers.insert(key, value.value(cx));
                }
            }
        }
    }

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

    Ok(RequestOptions {
        url,
        emulation,
        headers,
        method,
        body,
        proxy,
        timeout,
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

// WebSocket connection function
fn websocket_connect(mut cx: FunctionContext) -> JsResult<JsPromise> {
    // Get the options object
    let options_obj = cx.argument::<JsObject>(0)?;

    // Get URL (required)
    let url: Handle<JsString> = options_obj.get(&mut cx, "url")?;
    let url = url.value(&mut cx);

    // Get browser (optional, defaults to chrome_137)
    let browser_str = options_obj
        .get_opt(&mut cx, "browser")?
        .and_then(|v: Handle<JsValue>| v.downcast::<JsString, _>(&mut cx).ok())
        .map(|v| v.value(&mut cx))
        .unwrap_or_else(|| "chrome_137".to_string());

    let emulation = parse_emulation(&browser_str);

    // Get headers (optional)
    let mut headers = HashMap::new();
    if let Ok(Some(headers_obj)) = options_obj.get_opt::<JsObject, _, _>(&mut cx, "headers") {
        let keys = headers_obj.get_own_property_names(&mut cx)?;
        let keys_vec = keys.to_vec(&mut cx)?;

        for key_val in keys_vec {
            if let Ok(key_str) = key_val.downcast::<JsString, _>(&mut cx) {
                let key = key_str.value(&mut cx);
                if let Ok(value) = headers_obj.get::<JsString, _, _>(&mut cx, key.as_str()) {
                    headers.insert(key, value.value(&mut cx));
                }
            }
        }
    }

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
    cx.export_function("websocketConnect", websocket_connect)?;
    cx.export_function("websocketSend", websocket_send)?;
    cx.export_function("websocketClose", websocket_close)?;
    Ok(())
}
