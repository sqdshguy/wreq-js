---

title: Architecture Overview
description: Internal architecture notes covering JS, Neon, and Rust request flow.
noindex: true
---

# Architecture Overview

## Request Flow

```
┌─────────────────────────────────────┐
│  JavaScript/TypeScript Code         │
└──────────────┬──────────────────────┘
               ↓
┌──────────────────────────────────────┐
│  TypeScript Wrapper (wreq-js.ts)     │
│  - Validate inputs                   │
│  - Convert to options object         │
└──────────────┬───────────────────────┘
               ↓ (NAPI-RS)
┌──────────────────────────────────────┐
│  Rust Native Module (lib.rs)         │
│  - Parse JS objects                  │
│  - Call Rust client                  │
│  - Convert response back to JS       │
└──────────────┬───────────────────────┘
               ↓
┌──────────────────────────────────────┐
│  Browser Client (client.rs)          │
│  - Select browser profile            │
│  - Build HTTP request                │
│  - Apply headers & options           │
└──────────────┬───────────────────────┘
               ↓
┌──────────────────────────────────────┐
│  wreq HTTP Client                    │
│  - Browser profile aware networking  │
│  - TLS and protocol behavior in      │
│    native layer                      │
└──────────────┬───────────────────────┘
               ↓
┌──────────────────────────────────────┐
│  BoringSSL (TLS)                     │
│  - TLS implementation details are    │
│    handled by native dependencies    │
└──────────────┬───────────────────────┘
               ↓
┌──────────────────────────────────────┐
│  HTTP Protocol Layer                 │
│  - Protocol settings and framing     │
│    are handled by native layer       │
└──────────────────────────────────────┘
```

## References

- [wreq GitHub](https://github.com/0x676e67/wreq)
- [BoringSSL](https://boringssl.googlesource.com/boringssl/)
- [NAPI-RS](https://napi.rs/)
