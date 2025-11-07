# Build Instructions

This guide is for developers who want to build `wreq-js` from source. If you just want to use the library, see the main [README.md](../README.md) — pre-built binaries are included with the npm package.

## Prerequisites

### 1. [Install Rust](https://rust-lang.org/tools/install)

### 2. Install CMake

CMake is required for building BoringSSL:

```bash
# macOS
brew install cmake

# Ubuntu/Debian
sudo apt-get install cmake

# Verify installation
cmake --version
```

## Building the Project

### Step 1: Install Dependencies

```bash
npm install
```

### Step 2: Build Rust Module

```bash
npm run build:rust
```

This will:
1. Compile Rust code with release optimizations
2. Create the native Node.js addon (`rust/index.node`)

**Troubleshooting:**

If you get errors about missing dependencies:

```bash
# macOS - install build tools
xcode-select --install

# Ubuntu/Debian
sudo apt-get install build-essential pkg-config libssl-dev

# Update Rust
rustup update stable
```

### Step 3: Build TypeScript

```bash
npm run build:ts
```

This will compile TypeScript files to `dist/` folder.

## Development Workflow

### Full Build

```bash
npm run build
```

This runs both Rust and TypeScript builds.

### Watch Mode (TypeScript only)

```bash
npm run build:ts -- --watch
```

### Clean Build

```bash
npm run clean
npm run build
```

## Platform-Specific Notes

### macOS

- Xcode Command Line Tools required

### Linux

Requires OpenSSL development libraries:

```bash
# Ubuntu/Debian
sudo apt-get install pkg-config libssl-dev build-essential

# Fedora/RHEL
sudo dnf install openssl-devel gcc
```

### Windows

- Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)
- Or use WSL2 (recommended)

```bash
# In WSL2 Ubuntu
sudo apt-get install build-essential pkg-config libssl-dev
```

## Performance Optimization

The Rust module is already optimized with:

```toml
[profile.release]
opt-level = 3        # Maximum optimization
lto = true           # Link-time optimization
codegen-units = 1    # Single codegen unit
```

For even better performance, you can use:

```bash
RUSTFLAGS="-C target-cpu=native" npm run build:rust
```

This will optimize for your specific CPU architecture.

## Troubleshooting

### Error: "Cannot find module 'index.node'"

```bash
npm run build:rust
```

### Error: "napi build failed"

```bash
# Update napi-rs
npm install

# Clean and rebuild
rm -rf rust/target
npm run build:rust
```

## Cross-Platform Building

### Build for Different Targets

```bash
# List available targets
rustup target list

# Add target
rustup target add x86_64-unknown-linux-gnu
rustup target add aarch64-unknown-linux-gnu
rustup target add x86_64-pc-windows-msvc

# Build for specific target
npm run build:rust -- --target x86_64-unknown-linux-gnu
```

## Debugging

### Enable Rust Logging

```bash
RUST_LOG=debug npm test
```

### Enable Verbose Build

```bash
npm run build:rust -- --verbose
```

### Check Binary Info

```bash
# macOS/Linux
file rust/index.node
otool -L rust/index.node  # macOS
ldd rust/index.node       # Linux

# Check size
ls -lh rust/index.node
```
