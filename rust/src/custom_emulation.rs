use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::collections::HashSet;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::time::Duration;
use wreq::{
    Emulation as WreqEmulation, Group, IntoEmulation,
    header::{HeaderCaseName, HeaderMap, HeaderName, HeaderValue, OrigHeaderMap},
    http1::Http1Options,
    http2::{
        Http2Options, Priorities, Priority, PseudoId, PseudoOrder, SettingId, SettingsOrder,
        StreamDependency, StreamId,
    },
    tls::{
        AlpnProtocol, AlpsProtocol, ExtensionType, TlsOptions, TlsVersion,
        compress::CertificateCompressor,
    },
};

use wreq_util::emulate::compress::{BrotliCompressor, ZlibCompressor, ZstdCompressor};
// wreq-util renamed these: the profile enum is now `Profile`, the OS enum is
// `Platform`, and `EmulationOption` became `Emulation` (which collides with wreq's own
// `Emulation`, hence the aliases).
use wreq_util::{
    Emulation as EmulationOption, Platform as BrowserEmulationOS, Profile as BrowserEmulation,
};

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CustomEmulationPayload {
    #[serde(default)]
    tls_options: Option<CustomTlsOptions>,
    #[serde(default)]
    http1_options: Option<CustomHttp1Options>,
    #[serde(default)]
    http2_options: Option<CustomHttp2Options>,
    #[serde(default)]
    headers: Option<Vec<(String, String)>>,
    #[serde(default)]
    orig_headers: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CustomTlsOptions {
    #[serde(default)]
    alpn_protocols: Option<Vec<String>>,
    #[serde(default)]
    alps_protocols: Option<Vec<String>>,
    #[serde(default)]
    alps_use_new_codepoint: Option<bool>,
    #[serde(default)]
    session_ticket: Option<bool>,
    #[serde(default)]
    min_tls_version: Option<String>,
    #[serde(default)]
    max_tls_version: Option<String>,
    #[serde(default)]
    pre_shared_key: Option<bool>,
    #[serde(default)]
    enable_ech_grease: Option<bool>,
    #[serde(default)]
    permute_extensions: Option<bool>,
    #[serde(default)]
    grease_enabled: Option<bool>,
    #[serde(default)]
    enable_ocsp_stapling: Option<bool>,
    #[serde(default)]
    enable_signed_cert_timestamps: Option<bool>,
    #[serde(default)]
    record_size_limit: Option<u16>,
    #[serde(default)]
    psk_skip_session_ticket: Option<bool>,
    #[serde(default)]
    psk_dhe_ke: Option<bool>,
    #[serde(default)]
    renegotiation: Option<bool>,
    #[serde(default)]
    delegated_credentials: Option<String>,
    #[serde(default)]
    curves_list: Option<String>,
    #[serde(default)]
    cipher_list: Option<String>,
    #[serde(default)]
    sigalgs_list: Option<String>,
    #[serde(default)]
    certificate_compression_algorithms: Option<Vec<String>>,
    #[serde(default)]
    extension_permutation: Option<Vec<u16>>,
    #[serde(default)]
    aes_hw_override: Option<bool>,
    #[serde(default)]
    preserve_tls13_cipher_list: Option<bool>,
    #[serde(default)]
    random_aes_hw_override: Option<bool>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CustomHttp1Options {
    #[serde(default)]
    http09_responses: Option<bool>,
    #[serde(default)]
    writev: Option<bool>,
    #[serde(default)]
    max_headers: Option<usize>,
    #[serde(default)]
    read_buf_exact_size: Option<usize>,
    #[serde(default)]
    max_buf_size: Option<usize>,
    #[serde(default)]
    ignore_invalid_headers_in_responses: Option<bool>,
    #[serde(default)]
    allow_spaces_after_header_name_in_responses: Option<bool>,
    #[serde(default)]
    allow_obsolete_multiline_headers_in_responses: Option<bool>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CustomHttp2Options {
    #[serde(default)]
    adaptive_window: Option<bool>,
    #[serde(default)]
    initial_stream_id: Option<u32>,
    #[serde(default)]
    initial_connection_window_size: Option<u32>,
    #[serde(default)]
    initial_window_size: Option<u32>,
    #[serde(default)]
    initial_max_send_streams: Option<usize>,
    #[serde(default)]
    max_frame_size: Option<u32>,
    #[serde(default)]
    keep_alive_interval: Option<u64>,
    #[serde(default)]
    keep_alive_timeout: Option<u64>,
    #[serde(default)]
    keep_alive_while_idle: Option<bool>,
    #[serde(default)]
    max_concurrent_reset_streams: Option<usize>,
    #[serde(default)]
    max_send_buffer_size: Option<usize>,
    #[serde(default)]
    max_concurrent_streams: Option<u32>,
    #[serde(default)]
    max_header_list_size: Option<u32>,
    #[serde(default)]
    max_pending_accept_reset_streams: Option<usize>,
    #[serde(default)]
    enable_push: Option<bool>,
    #[serde(default)]
    header_table_size: Option<u32>,
    #[serde(default)]
    enable_connect_protocol: Option<bool>,
    #[serde(default)]
    no_rfc7540_priorities: Option<bool>,
    #[serde(default)]
    settings_order: Option<Vec<String>>,
    #[serde(default)]
    headers_pseudo_order: Option<Vec<String>>,
    #[serde(default)]
    headers_stream_dependency: Option<CustomHttp2StreamDependency>,
    #[serde(default)]
    priorities: Option<Vec<CustomHttp2Priority>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomHttp2Priority {
    stream_id: u32,
    dependency: CustomHttp2StreamDependency,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomHttp2StreamDependency {
    dependency_id: u32,
    weight: u8,
    #[serde(default)]
    exclusive: bool,
}

fn parse_payload(emulation_json: &str) -> Result<CustomEmulationPayload> {
    serde_json::from_str(emulation_json).context("Failed to parse emulation JSON")
}

fn payload_is_empty(payload: &CustomEmulationPayload) -> bool {
    payload.tls_options.is_none()
        && payload.http1_options.is_none()
        && payload.http2_options.is_none()
        && payload
            .headers
            .as_ref()
            .map(|headers| headers.is_empty())
            .unwrap_or(true)
        && payload
            .orig_headers
            .as_ref()
            .map(|headers| headers.is_empty())
            .unwrap_or(true)
}

pub fn resolve_preset_emulation(
    browser: BrowserEmulation,
    os: BrowserEmulationOS,
    emulation_json: Option<&str>,
) -> Result<WreqEmulation> {
    let mut emulation = EmulationOption::builder()
        .profile(browser)
        .platform(os)
        .build()
        .into_emulation();

    if let Some(emulation_json) = emulation_json {
        let payload = parse_payload(emulation_json)?;
        apply_payload(&mut emulation, payload, true)?;
    }

    Ok(emulation)
}

/// Read-only view of the headers a preset profile injects into every request,
/// in the profile's own order and with its original casing.
///
/// Lets callers inspect a profile (e.g. read its User-Agent) without sending a
/// request; nothing here touches the request path.
pub fn preset_emulation_headers(
    browser: BrowserEmulation,
    os: BrowserEmulationOS,
) -> Result<Vec<(String, String)>> {
    let emulation = resolve_preset_emulation(browser, os, None)?;
    let orig_headers = emulation.orig_headers.clone();
    let mut headers = emulation.headers.clone();

    let mut resolved = Vec::with_capacity(headers.len());

    // `OrigHeaderMap` keeps insertion order and original casing, `HeaderMap` keeps
    // neither, so drain the ordered names first and let the rest follow.
    for (name, orig_name) in orig_headers.iter() {
        for value in headers.get_all(name) {
            resolved.push((decode_header_name(orig_name), decode_header_value(value)));
        }
        headers.remove(name);
    }

    for (name, value) in headers.iter() {
        resolved.push((name.as_str().to_owned(), decode_header_value(value)));
    }

    Ok(resolved)
}

fn decode_header_name(name: &HeaderCaseName) -> String {
    String::from_utf8_lossy(name.as_ref()).into_owned()
}

fn decode_header_value(value: &HeaderValue) -> String {
    String::from_utf8_lossy(value.as_bytes()).into_owned()
}

pub fn resolve_custom_emulation(emulation_json: &str) -> Result<WreqEmulation> {
    let payload = parse_payload(emulation_json)?;
    if payload_is_empty(&payload) {
        bail!(
            "Standalone custom emulation requires at least one of tlsOptions, http1Options, http2Options, headers, or origHeaders"
        );
    }

    // wreq partitions the connection pool by `Group`, so two different custom
    // emulations must not share one. Preset profiles get their group from wreq-util; derive
    // ours from the config itself so identical configs pool together and different ones don't.
    let mut group_hash = DefaultHasher::new();
    emulation_json.hash(&mut group_hash);

    let mut emulation = WreqEmulation::builder().build(Group::new(group_hash.finish()));
    apply_payload(&mut emulation, payload, false)?;
    Ok(emulation)
}

pub fn resolve_emulation(
    browser: Option<BrowserEmulation>,
    os: Option<BrowserEmulationOS>,
    emulation_json: Option<&str>,
) -> Result<WreqEmulation> {
    match (browser, os, emulation_json) {
        (Some(browser), Some(os), emulation_json) => {
            resolve_preset_emulation(browser, os, emulation_json)
        }
        (None, None, Some(emulation_json)) => resolve_custom_emulation(emulation_json),
        (None, None, None) => bail!("Missing emulation configuration"),
        _ => bail!("Invalid emulation configuration dispatched from JS"),
    }
}

fn apply_payload(
    emulation: &mut WreqEmulation,
    payload: CustomEmulationPayload,
    overlay_on_preset: bool,
) -> Result<()> {
    if let Some(tls_options) = payload.tls_options {
        emulation.tls_options = Some(build_tls_options(tls_options)?);
    }

    if let Some(http1_options) = payload.http1_options {
        emulation.http1_options = Some(build_http1_options(http1_options)?);
    }

    if let Some(http2_options) = payload.http2_options {
        emulation.http2_options = Some(build_http2_options(http2_options)?);
    }

    if let Some(headers) = payload.headers {
        if overlay_on_preset {
            merge_header_map(&mut emulation.headers, headers)?;
        } else {
            emulation.headers = build_header_map(headers)?;
        }
    }

    if let Some(orig_headers) = payload.orig_headers {
        if overlay_on_preset {
            let mut merged = emulation.orig_headers.clone();
            merged.extend(build_orig_header_map(orig_headers)?);
            emulation.orig_headers = merged;
        } else {
            emulation.orig_headers = build_orig_header_map(orig_headers)?;
        }
    }

    Ok(())
}

fn merge_header_map(target: &mut HeaderMap, headers: Vec<(String, String)>) -> Result<()> {
    let mut removed = HashSet::new();

    for (name, value) in headers {
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .with_context(|| format!("Invalid emulation header name: {name}"))?;
        let header_value = HeaderValue::from_str(&value)
            .with_context(|| format!("Invalid emulation header value for {name}"))?;

        if removed.insert(header_name.clone()) {
            target.remove(&header_name);
        }

        target.append(header_name, header_value);
    }

    Ok(())
}

fn build_header_map(headers: Vec<(String, String)>) -> Result<HeaderMap> {
    let mut header_map = HeaderMap::with_capacity(headers.len());
    for (name, value) in headers {
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .with_context(|| format!("Invalid emulation header name: {name}"))?;
        let header_value = HeaderValue::from_str(&value)
            .with_context(|| format!("Invalid emulation header value for {name}"))?;
        header_map.append(header_name, header_value);
    }
    Ok(header_map)
}

fn build_orig_header_map(orig_headers: Vec<String>) -> Result<OrigHeaderMap> {
    let mut map = OrigHeaderMap::with_capacity(orig_headers.len());
    let mut seen = HashSet::with_capacity(orig_headers.len());

    for orig_header in orig_headers {
        let trimmed = orig_header.trim();
        if trimmed.is_empty() {
            bail!("Invalid emulation origHeaders entry: header name must not be empty");
        }

        HeaderName::from_bytes(trimmed.as_bytes())
            .with_context(|| format!("Invalid emulation origHeaders entry: {trimmed}"))?;

        let dedupe_key = trimmed.to_ascii_lowercase();
        if !seen.insert(dedupe_key) {
            bail!("Duplicate emulation origHeaders entry: {trimmed}");
        }

        map.insert(trimmed.to_string());
    }

    Ok(map)
}

fn build_tls_options(options: CustomTlsOptions) -> Result<TlsOptions> {
    let mut builder = TlsOptions::builder();

    if let Some(alpn_protocols) = options.alpn_protocols {
        builder = builder.alpn_protocols(
            alpn_protocols
                .into_iter()
                .map(|protocol| parse_alpn_protocol(&protocol))
                .collect::<Result<Vec<_>>>()?,
        );
    }

    if let Some(alps_protocols) = options.alps_protocols {
        builder = builder.alps_protocols(
            alps_protocols
                .into_iter()
                .map(|protocol| parse_alps_protocol(&protocol))
                .collect::<Result<Vec<_>>>()?,
        );
    }

    if let Some(value) = options.alps_use_new_codepoint {
        builder = builder.alps_use_new_codepoint(value);
    }
    if let Some(value) = options.session_ticket {
        builder = builder.session_ticket(value);
    }
    if let Some(value) = options.min_tls_version {
        builder = builder.min_tls_version(Some(parse_tls_version(&value)?));
    }
    if let Some(value) = options.max_tls_version {
        builder = builder.max_tls_version(Some(parse_tls_version(&value)?));
    }
    if let Some(value) = options.pre_shared_key {
        builder = builder.pre_shared_key(value);
    }
    if let Some(value) = options.enable_ech_grease {
        builder = builder.enable_ech_grease(value);
    }
    if let Some(value) = options.permute_extensions {
        builder = builder.permute_extensions(Some(value));
    }
    if let Some(value) = options.grease_enabled {
        builder = builder.grease_enabled(Some(value));
    }
    if let Some(value) = options.enable_ocsp_stapling {
        builder = builder.enable_ocsp_stapling(value);
    }
    if let Some(value) = options.enable_signed_cert_timestamps {
        builder = builder.enable_signed_cert_timestamps(value);
    }
    if let Some(value) = options.record_size_limit {
        builder = builder.record_size_limit(Some(value));
    }
    if let Some(value) = options.psk_skip_session_ticket {
        builder = builder.psk_skip_session_ticket(value);
    }
    if let Some(value) = options.psk_dhe_ke {
        builder = builder.psk_dhe_ke(value);
    }
    if let Some(value) = options.renegotiation {
        builder = builder.renegotiation(value);
    }
    if let Some(value) = options.delegated_credentials {
        builder = builder.delegated_credentials(value);
    }
    if let Some(value) = options.curves_list {
        builder = builder.curves_list(value);
    }
    if let Some(value) = options.cipher_list {
        builder = builder.cipher_list(value);
    }
    if let Some(value) = options.sigalgs_list {
        builder = builder.sigalgs_list(value);
    }
    if let Some(value) = options.certificate_compression_algorithms {
        builder = builder.certificate_compressors(
            value
                .into_iter()
                .map(|algorithm| parse_certificate_compressor(&algorithm))
                .collect::<Result<Vec<_>>>()?,
        );
    }
    if let Some(value) = options.extension_permutation {
        builder = builder.extension_permutation(
            value
                .into_iter()
                .map(ExtensionType::from)
                .collect::<Vec<_>>(),
        );
    }
    if let Some(value) = options.aes_hw_override {
        builder = builder.aes_hw_override(Some(value));
    }
    if let Some(value) = options.preserve_tls13_cipher_list {
        builder = builder.preserve_tls13_cipher_list(Some(value));
    }
    if let Some(value) = options.random_aes_hw_override {
        builder = builder.random_aes_hw_override(value);
    }

    Ok(builder.build())
}

fn build_http1_options(options: CustomHttp1Options) -> Result<Http1Options> {
    let mut builder = Http1Options::builder();

    if let Some(value) = options.http09_responses {
        builder = builder.http09_responses(value);
    }
    if let Some(value) = options.writev {
        builder = builder.writev(Some(value));
    }
    if let Some(value) = options.max_headers {
        builder = builder.max_headers(value);
    }
    if let Some(value) = options.read_buf_exact_size {
        builder = builder.read_buf_exact_size(Some(value));
    }
    if let Some(value) = options.max_buf_size {
        if value < 8192 {
            bail!("Invalid emulation http1Options.maxBufSize: must be at least 8192");
        }
        builder = builder.max_buf_size(value);
    }
    if options.read_buf_exact_size.is_some() && options.max_buf_size.is_some() {
        bail!("Invalid emulation http1Options: readBufExactSize and maxBufSize cannot both be set");
    }
    if let Some(value) = options.ignore_invalid_headers_in_responses {
        builder = builder.ignore_invalid_headers_in_responses(value);
    }
    if let Some(value) = options.allow_spaces_after_header_name_in_responses {
        builder = builder.allow_spaces_after_header_name_in_responses(value);
    }
    if let Some(value) = options.allow_obsolete_multiline_headers_in_responses {
        builder = builder.allow_obsolete_multiline_headers_in_responses(value);
    }

    Ok(builder.build())
}

fn build_http2_options(options: CustomHttp2Options) -> Result<Http2Options> {
    let mut builder = Http2Options::builder();

    if let Some(value) = options.adaptive_window {
        builder = builder.adaptive_window(value);
    }
    if let Some(value) = options.initial_stream_id {
        builder = builder.initial_stream_id(Some(value));
    }
    if let Some(value) = options.initial_connection_window_size {
        builder = builder.initial_connection_window_size(Some(value));
    }
    if let Some(value) = options.initial_window_size {
        builder = builder.initial_window_size(Some(value));
    }
    if let Some(value) = options.initial_max_send_streams {
        builder = builder.initial_max_send_streams(Some(value));
    }
    if let Some(value) = options.max_frame_size {
        builder = builder.max_frame_size(Some(value));
    }
    if let Some(value) = options.keep_alive_interval {
        builder = builder.keep_alive_interval(Some(Duration::from_millis(value)));
    }
    if let Some(value) = options.keep_alive_timeout {
        builder = builder.keep_alive_timeout(Duration::from_millis(value));
    }
    if let Some(value) = options.keep_alive_while_idle {
        builder = builder.keep_alive_while_idle(value);
    }
    if let Some(value) = options.max_concurrent_reset_streams {
        builder = builder.max_concurrent_reset_streams(value);
    }
    if let Some(value) = options.max_send_buffer_size {
        builder = builder.max_send_buf_size(value);
    }
    if let Some(value) = options.max_concurrent_streams {
        builder = builder.max_concurrent_streams(Some(value));
    }
    if let Some(value) = options.max_header_list_size {
        builder = builder.max_header_list_size(value);
    }
    if let Some(value) = options.max_pending_accept_reset_streams {
        builder = builder.max_pending_accept_reset_streams(Some(value));
    }
    if let Some(value) = options.enable_push {
        builder = builder.enable_push(value);
    }
    if let Some(value) = options.header_table_size {
        builder = builder.header_table_size(Some(value));
    }
    if let Some(value) = options.enable_connect_protocol {
        builder = builder.enable_connect_protocol(value);
    }
    if let Some(value) = options.no_rfc7540_priorities {
        builder = builder.no_rfc7540_priorities(value);
    }
    if let Some(settings_order) = options.settings_order {
        builder = builder.settings_order(Some(build_settings_order(settings_order)?));
    }
    if let Some(pseudo_order) = options.headers_pseudo_order {
        builder = builder.headers_pseudo_order(Some(build_pseudo_order(pseudo_order)?));
    }
    if let Some(dep) = options.headers_stream_dependency {
        builder = builder.headers_stream_dependency(Some(StreamDependency::new(
            StreamId::from(dep.dependency_id),
            dep.weight,
            dep.exclusive,
        )));
    }
    if let Some(priorities) = options.priorities {
        builder = builder.priorities(Some(build_priorities(priorities)?));
    }
    Ok(builder.build())
}

fn build_pseudo_order(pseudo_order: Vec<String>) -> Result<PseudoOrder> {
    let mut builder = PseudoOrder::builder();
    let mut seen = HashSet::with_capacity(pseudo_order.len());

    for pseudo_id in &pseudo_order {
        let id = parse_pseudo_id(pseudo_id)?;
        if !seen.insert(pseudo_id.clone()) {
            bail!("Duplicate emulation http2Options.headersPseudoOrder entry: {pseudo_id}");
        }
        builder = builder.push(id);
    }

    Ok(builder.build())
}

fn build_settings_order(settings_order: Vec<String>) -> Result<SettingsOrder> {
    let mut builder = SettingsOrder::builder();
    let mut seen = HashSet::with_capacity(settings_order.len());

    for setting in settings_order {
        let setting_id = parse_http2_setting_id(&setting)?;
        if !seen.insert(setting_id.clone()) {
            bail!("Duplicate emulation http2Options.settingsOrder entry: {setting}");
        }
        builder = builder.push(setting_id);
    }

    Ok(builder.build())
}

fn build_priorities(priorities: Vec<CustomHttp2Priority>) -> Result<Priorities> {
    let mut builder = Priorities::builder();
    let mut seen_stream_ids = HashSet::with_capacity(priorities.len());

    for priority in priorities {
        if priority.stream_id == 0 {
            bail!(
                "Invalid emulation http2Options.priorities entry: streamId must be greater than 0"
            );
        }
        if !seen_stream_ids.insert(priority.stream_id) {
            bail!(
                "Duplicate emulation http2Options.priorities streamId: {}",
                priority.stream_id
            );
        }

        let dependency = StreamDependency::new(
            StreamId::from(priority.dependency.dependency_id),
            priority.dependency.weight,
            priority.dependency.exclusive,
        );

        builder = builder.push(Priority::new(
            StreamId::from(priority.stream_id),
            dependency,
        ));
    }

    Ok(builder.build())
}

fn parse_tls_version(value: &str) -> Result<TlsVersion> {
    match value {
        "1.0" | "TLS1.0" => Ok(TlsVersion::TLS_1_0),
        "1.1" | "TLS1.1" => Ok(TlsVersion::TLS_1_1),
        "1.2" | "TLS1.2" => Ok(TlsVersion::TLS_1_2),
        "1.3" | "TLS1.3" => Ok(TlsVersion::TLS_1_3),
        other => bail!("Invalid TLS version: {other}"),
    }
}

fn parse_alpn_protocol(value: &str) -> Result<AlpnProtocol> {
    match value {
        "HTTP1" => Ok(AlpnProtocol::HTTP1),
        "HTTP2" => Ok(AlpnProtocol::HTTP2),
        "HTTP3" => Ok(AlpnProtocol::HTTP3),
        other => bail!("Invalid ALPN protocol: {other}"),
    }
}

fn parse_alps_protocol(value: &str) -> Result<AlpsProtocol> {
    match value {
        "HTTP1" => Ok(AlpsProtocol::HTTP1),
        "HTTP2" => Ok(AlpsProtocol::HTTP2),
        "HTTP3" => Ok(AlpsProtocol::HTTP3),
        other => bail!("Invalid ALPS protocol: {other}"),
    }
}

fn parse_certificate_compressor(value: &str) -> Result<&'static dyn CertificateCompressor> {
    match value {
        "zlib" => Ok(&ZlibCompressor),
        "brotli" => Ok(&BrotliCompressor),
        "zstd" => Ok(&ZstdCompressor),
        other => bail!("Invalid certificate compression algorithm: {other}"),
    }
}

fn parse_pseudo_id(value: &str) -> Result<PseudoId> {
    match value {
        "Method" => Ok(PseudoId::Method),
        "Scheme" => Ok(PseudoId::Scheme),
        "Authority" => Ok(PseudoId::Authority),
        "Path" => Ok(PseudoId::Path),
        "Protocol" => Ok(PseudoId::Protocol),
        other => bail!("Invalid HTTP/2 pseudo-header id: {other}"),
    }
}

fn parse_http2_setting_id(value: &str) -> Result<SettingId> {
    match value {
        "HeaderTableSize" => Ok(SettingId::HeaderTableSize),
        "EnablePush" => Ok(SettingId::EnablePush),
        "MaxConcurrentStreams" => Ok(SettingId::MaxConcurrentStreams),
        "InitialWindowSize" => Ok(SettingId::InitialWindowSize),
        "MaxFrameSize" => Ok(SettingId::MaxFrameSize),
        "MaxHeaderListSize" => Ok(SettingId::MaxHeaderListSize),
        "EnableConnectProtocol" => Ok(SettingId::EnableConnectProtocol),
        "NoRfc7540Priorities" => Ok(SettingId::NoRfc7540Priorities),
        other => bail!("Invalid HTTP/2 setting id: {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wreq::header::USER_AGENT;

    fn preset_overlay_payload() -> &'static str {
        r#"{
          "tlsOptions": {
            "sessionTicket": false,
            "alpsProtocols": ["HTTP2"],
            "certificateCompressionAlgorithms": ["brotli"],
            "extensionPermutation": [10, 16]
          },
          "headers": [["X-Test", "overlay"]],
          "origHeaders": ["X-Test", "User-Agent"]
        }"#
    }

    #[test]
    fn preset_path_builds_and_overlays_custom_fields() {
        let emulation = resolve_preset_emulation(
            BrowserEmulation::Chrome142,
            BrowserEmulationOS::MacOS,
            Some(preset_overlay_payload()),
        )
        .expect("preset emulation should build");

        let tls = emulation
            .tls_options
            .clone()
            .expect("preset overlay should install tls options");
        assert!(!tls.session_ticket);
        assert_eq!(
            tls.alps_protocols
                .expect("alps protocols set")
                .as_ref()
                .len(),
            1
        );
        assert_eq!(
            tls.extension_permutation
                .expect("extension permutation set")
                .as_ref()
                .len(),
            2
        );

        let header_value = emulation
            .headers
            .get("x-test")
            .and_then(|value| value.to_str().ok());
        assert_eq!(header_value, Some("overlay"));
        assert_eq!(emulation.orig_headers.len(), 2);
    }

    #[test]
    fn standalone_custom_path_builds_tls_only_payload() {
        let emulation = resolve_custom_emulation(
            r#"{"tlsOptions":{"alpnProtocols":["HTTP2"],"sessionTicket":false,"minTlsVersion":"1.2"}}"#,
        )
        .expect("tls-only custom emulation should build");

        assert!(emulation.http1_options.is_none());
        assert!(emulation.http2_options.is_none());

        let tls = emulation
            .tls_options
            .clone()
            .expect("tls options should be present");
        assert!(!tls.session_ticket);
        assert_eq!(tls.min_tls_version, Some(TlsVersion::TLS_1_2));
    }

    #[test]
    fn standalone_custom_path_builds_http1_only_payload() {
        let emulation = resolve_custom_emulation(
            r#"{"http1Options":{"http09Responses":true,"maxHeaders":32,"ignoreInvalidHeadersInResponses":true}}"#,
        )
        .expect("http1-only custom emulation should build");

        let http1 = emulation
            .http1_options
            .clone()
            .expect("http1 options should be present");
        assert!(http1.h09_responses);
        assert_eq!(http1.h1_max_headers, Some(32));
        assert!(http1.ignore_invalid_headers_in_responses);
        assert!(emulation.tls_options.is_none());
        assert!(emulation.http2_options.is_none());
    }

    #[test]
    fn standalone_custom_path_builds_http2_only_payload() {
        let emulation = resolve_custom_emulation(
            r#"{
              "http2Options": {
                "initialStreamId": 3,
                "settingsOrder": ["HeaderTableSize", "EnablePush"],
                "priorities": [
                  {
                    "streamId": 3,
                    "dependency": {"dependencyId": 0, "weight": 42, "exclusive": true}
                  }
                ]
              }
            }"#,
        )
        .expect("http2-only custom emulation should build");

        let http2 = emulation
            .http2_options
            .clone()
            .expect("http2 options should be present");
        assert_eq!(http2.initial_stream_id, Some(3));
        assert!(http2.settings_order.is_some());
        assert!(http2.priorities.is_some());
    }

    #[test]
    fn standalone_custom_path_builds_headers_only_payload() {
        let emulation = resolve_custom_emulation(
            r#"{"headers":[["User-Agent","custom-agent"],["X-Test","alpha"]],"origHeaders":["User-Agent","X-Test"]}"#,
        )
        .expect("headers-only custom emulation should build");

        let user_agent = emulation
            .headers
            .get(USER_AGENT)
            .and_then(|value| value.to_str().ok());
        assert_eq!(user_agent, Some("custom-agent"));
        assert_eq!(emulation.orig_headers.len(), 2);
    }

    #[test]
    fn standalone_custom_path_builds_combined_payload() {
        let emulation = resolve_custom_emulation(
            r#"{
              "tlsOptions":{"alpnProtocols":["HTTP2"]},
              "http1Options":{"writev":true},
              "http2Options":{"maxConcurrentStreams":10},
              "headers":[["X-Test","combined"]],
              "origHeaders":["X-Test"]
            }"#,
        )
        .expect("combined custom emulation should build");

        assert!(emulation.tls_options.is_some());
        assert!(emulation.http1_options.is_some());
        assert!(emulation.http2_options.is_some());
        assert!(emulation.headers.contains_key("x-test"));
        assert_eq!(emulation.orig_headers.len(), 1);
    }

    #[test]
    fn alps_cert_compression_and_extension_permutation_parse() {
        let emulation = resolve_custom_emulation(
            r#"{
              "tlsOptions":{
                "alpsProtocols":["HTTP1","HTTP2"],
                "certificateCompressionAlgorithms":["zlib","brotli","zstd"],
                "extensionPermutation":[0,16,43]
              }
            }"#,
        )
        .expect("tls extras should parse");

        let tls = emulation
            .tls_options
            .clone()
            .expect("tls options should be present");
        assert_eq!(
            tls.alps_protocols.expect("alps protocols").as_ref().len(),
            2
        );
        assert_eq!(
            tls.certificate_compressors
                .expect("certificate compressors")
                .as_ref()
                .len(),
            3
        );
        assert_eq!(
            tls.extension_permutation
                .expect("extension permutation")
                .as_ref()
                .len(),
            3
        );
    }

    #[test]
    fn settings_order_and_priorities_build() {
        let emulation = resolve_custom_emulation(
            r#"{
              "http2Options":{
                "settingsOrder":["HeaderTableSize","EnablePush","MaxConcurrentStreams"],
                "priorities":[
                  {"streamId":3,"dependency":{"dependencyId":0,"weight":1,"exclusive":false}},
                  {"streamId":5,"dependency":{"dependencyId":3,"weight":10,"exclusive":true}}
                ]
              }
            }"#,
        )
        .expect("http2 extras should parse");

        let http2 = emulation
            .http2_options
            .clone()
            .expect("http2 options should be present");
        assert!(http2.settings_order.is_some());
        assert!(http2.priorities.is_some());
    }

    #[test]
    fn invalid_orig_headers_fail_with_targeted_error() {
        let error = resolve_custom_emulation(r#"{"origHeaders":["X-Test","x-test"]}"#)
            .expect_err("should fail");
        assert!(
            error
                .to_string()
                .contains("Duplicate emulation origHeaders entry")
        );
    }

    #[test]
    fn duplicate_priority_ids_fail_with_targeted_error() {
        let error = resolve_custom_emulation(
            r#"{
              "http2Options":{
                "priorities":[
                  {"streamId":3,"dependency":{"dependencyId":0,"weight":1,"exclusive":false}},
                  {"streamId":3,"dependency":{"dependencyId":0,"weight":10,"exclusive":true}}
                ]
              }
            }"#,
        )
        .expect_err("should fail");
        assert!(
            error
                .to_string()
                .contains("Duplicate emulation http2Options.priorities streamId")
        );
    }
}
