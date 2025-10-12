use anyhow::{Context, Result};
use std::collections::HashMap;
use std::time::Duration;
use wreq_util::Emulation;

#[derive(Debug, Clone)]
pub struct RequestOptions {
    pub url: String,
    pub emulation: Emulation,
    pub headers: HashMap<String, String>,
    pub method: String,
    pub body: Option<String>,
    pub proxy: Option<String>,
    pub timeout: u64,
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
    pub cookies: HashMap<String, String>,
    pub url: String,
}

pub async fn make_request(options: RequestOptions) -> Result<Response> {
    // Create client builder with emulation
    let mut client_builder = wreq::Client::builder()
        .emulation(options.emulation)
        .cookie_store(true);

    // Apply proxy if present (must be set at client builder level)
    if let Some(proxy_url) = &options.proxy {
        let proxy = wreq::Proxy::all(proxy_url)
            .context("Failed to create proxy")?;
        client_builder = client_builder.proxy(proxy);
    }

    // Build the client
    let client = client_builder
        .build()
        .context("Failed to build HTTP client")?;

    let method = if options.method.is_empty() {
        "GET"
    } else {
        &options.method
    };

    // Build request
    let mut request = match method.to_uppercase().as_str() {
        "GET" => client.get(&options.url),
        "POST" => client.post(&options.url),
        "PUT" => client.put(&options.url),
        "DELETE" => client.delete(&options.url),
        "PATCH" => client.patch(&options.url),
        "HEAD" => client.head(&options.url),
        _ => return Err(anyhow::anyhow!("Unsupported HTTP method: {}", method)),
    };

    // Apply custom headers
    for (key, value) in &options.headers {
        request = request.header(key, value);
    }

    // Apply body if present
    if let Some(body) = options.body {
        request = request.body(body);
    }

    // Apply timeout
    request = request.timeout(Duration::from_millis(options.timeout));

    // Execute request
    let response = request
        .send()
        .await
        .with_context(|| format!("{} {}", method, options.url))?;

    // Extract response data
    let status = response.status().as_u16();
    let final_url = response.uri().to_string();

    // Extract headers
    let mut response_headers = HashMap::new();
    for (key, value) in response.headers() {
        if let Ok(value_str) = value.to_str() {
            response_headers.insert(key.to_string(), value_str.to_string());
        }
    }

    // Extract cookies
    let mut cookies = HashMap::new();
    if let Some(cookie_header) = response.headers().get("set-cookie") {
        if let Ok(cookie_str) = cookie_header.to_str() {
            // Simple cookie parsing (name=value)
            for cookie_part in cookie_str.split(';') {
                if let Some((key, value)) = cookie_part.trim().split_once('=') {
                    cookies.insert(key.to_string(), value.to_string());
                }
            }
        }
    }

    // Get body
    let body = response
        .text()
        .await
        .context("Failed to read response body")?;

    Ok(Response {
        status,
        headers: response_headers,
        body,
        cookies,
        url: final_url,
    })
}
