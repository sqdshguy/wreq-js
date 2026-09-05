//! Hand large response bodies to JS without copying them.
//!
//! `napi_create_external_buffer` wraps a Rust allocation in a `Buffer` and frees it
//! through a finalizer when the JS object is collected. That skips copying the
//! body into a runtime-owned buffer. Peak memory still depends on allocation
//! sizes, request rate, and the runtime's garbage collection behavior.
//!
//! Runtimes built with V8's sandbox (Electron) refuse external buffers with
//! `napi_no_external_buffers_allowed`. neon's `JsBuffer::external` unwraps that
//! status, so the function is resolved here directly and probed once at module load;
//! when refused, every body falls back to a copy, as napi-rs does.
//!
//! The sizes are deliberately not reported through `napi_adjust_external_memory`.
//! Node's V8 already accounts external backing stores. On Bun, JSC cannot see the
//! bytes at all, and reporting them made things worse: it scales its next collection
//! threshold by the reported size, so peak memory grew to gigabytes instead of
//! shrinking. The JS side therefore keeps external buffers off on Bun (see
//! `configureRuntime`), where every body is copied as before.

use std::ffi::c_void;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

use bytes::Bytes;
use neon::prelude::*;
use neon::sys::bindings::{Env as RawEnv, Value as RawValue};
use neon::types::buffer::TypedArray;

/// Smaller buffers are copied: equal-rate Node benchmarks showed lower resident
/// memory at 64 KiB with negligible throughput differences. Keep larger buffers
/// external to retain the throughput and CPU benefits on large full-body reads.
pub const EXTERNAL_BUFFER_MIN: usize = 256 * 1024;

const NAPI_OK: u32 = 0;
const NAPI_NO_EXTERNAL_BUFFERS_ALLOWED: u32 = 22;

type NapiFinalize = unsafe extern "C" fn(env: RawEnv, data: *mut c_void, hint: *mut c_void);
type CreateExternalBufferFn = unsafe extern "C" fn(
    env: RawEnv,
    length: usize,
    data: *mut c_void,
    finalize_cb: Option<NapiFinalize>,
    finalize_hint: *mut c_void,
    result: *mut RawValue,
) -> u32;
struct NapiFns {
    create_external_buffer: CreateExternalBufferFn,
}

static NAPI: OnceLock<Option<NapiFns>> = OnceLock::new();
static ALLOWED: AtomicBool = AtomicBool::new(false);

fn resolve_napi() -> Option<NapiFns> {
    // The host process (node, bun, electron) exports Node-API; look symbols up there,
    // the same way neon loads its own function table.
    #[cfg(unix)]
    let host = libloading::os::unix::Library::this();
    #[cfg(windows)]
    let host = libloading::os::windows::Library::this().ok()?;

    // SAFETY: the symbol signatures match the Node-API C declarations.
    let create_external_buffer = unsafe {
        host.get::<CreateExternalBufferFn>(b"napi_create_external_buffer\0")
            .ok()
            .map(|symbol| *symbol)?
    };
    // Symbols from the host program stay valid for the life of the process.
    std::mem::forget(host);

    Some(NapiFns {
        create_external_buffer,
    })
}

unsafe extern "C" fn drop_vec(_env: RawEnv, _data: *mut c_void, hint: *mut c_void) {
    // SAFETY: `hint` is the Box<Vec<u8>> handed to napi_create_external_buffer below,
    // and the runtime calls this exactly once when the buffer is collected.
    drop(unsafe { Box::<Vec<u8>>::from_raw(hint.cast()) });
}

enum Created {
    Buffer(RawValue),
    /// The runtime refused external buffers; the data comes back for copying.
    Refused(Vec<u8>),
    Failed(u32),
}

/// Try to wrap `data` in an external buffer.
unsafe fn create_external(env: RawEnv, data: Vec<u8>) -> Created {
    let Some(Some(fns)) = NAPI.get() else {
        return Created::Refused(data);
    };

    // Box first so the Vec header has a stable address to hand to the finalizer.
    let mut boxed = Box::new(data);
    let ptr = boxed.as_mut_ptr().cast::<c_void>();
    let len = boxed.len();
    let hint = Box::into_raw(boxed);
    let finalize: NapiFinalize = drop_vec;
    let mut result: RawValue = std::ptr::null_mut();

    // SAFETY: `env` is valid for this thread; on failure the runtime has not taken
    // ownership, so the Box is reclaimed below.
    let status = unsafe {
        (fns.create_external_buffer)(env, len, ptr, Some(finalize), hint.cast(), &mut result)
    };

    if status != NAPI_OK {
        let data = *unsafe { Box::from_raw(hint) };
        return if status == NAPI_NO_EXTERNAL_BUFFERS_ALLOWED {
            Created::Refused(data)
        } else {
            Created::Failed(status)
        };
    }

    Created::Buffer(result)
}

/// Resolve the Node-API symbols and probe once whether this runtime accepts external
/// buffers. Called from module initialization.
pub fn init<'cx, C: Context<'cx>>(cx: &mut C) {
    let fns = NAPI.get_or_init(resolve_napi);
    if fns.is_none() {
        return;
    }
    let env = cx.to_raw();
    // SAFETY: called on the JS thread during module init with a valid env.
    let allowed = matches!(
        unsafe { create_external(env, vec![0u8]) },
        Created::Buffer(_)
    );
    ALLOWED.store(allowed, Ordering::Relaxed);
}

/// Allow JS to turn external buffers off for a runtime where they misbehave.
pub fn set_enabled(enabled: bool) {
    if !enabled {
        ALLOWED.store(false, Ordering::Relaxed);
    }
}

/// Convert body bytes to a JS `Buffer`: external (zero-copy when the `Bytes` uniquely
/// owns its allocation) above the threshold, copied otherwise.
pub fn bytes_to_js_buffer<'cx, C: Context<'cx>>(
    cx: &mut C,
    bytes: Bytes,
) -> JsResult<'cx, JsBuffer> {
    if bytes.len() < EXTERNAL_BUFFER_MIN || !ALLOWED.load(Ordering::Relaxed) {
        return copy_buffer(cx, &bytes);
    }

    let owned: Vec<u8> = bytes.into();
    // SAFETY: on the JS thread with the context's env.
    match unsafe { create_external(cx.to_raw(), owned) } {
        // SAFETY: the runtime just returned this value as a Buffer for this env.
        Created::Buffer(value) => Ok(unsafe { JsBuffer::from_raw(cx, value) }),
        Created::Refused(data) => {
            // The runtime changed its mind (or the probe was wrong); copy from now on.
            ALLOWED.store(false, Ordering::Relaxed);
            copy_buffer(cx, &data)
        }
        Created::Failed(status) => cx.throw_error(format!(
            "napi_create_external_buffer failed with status {status}"
        )),
    }
}

fn copy_buffer<'cx, C: Context<'cx>>(cx: &mut C, bytes: &[u8]) -> JsResult<'cx, JsBuffer> {
    // SAFETY: every byte is initialized immediately, before the buffer is exposed
    // to JavaScript. Avoid zero-filling memory that the copy will overwrite.
    let mut buffer = unsafe { JsBuffer::uninitialized(cx, bytes.len())? };
    buffer.as_mut_slice(cx).copy_from_slice(bytes);
    Ok(buffer)
}
