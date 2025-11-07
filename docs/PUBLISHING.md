# Publishing Guide

## How to Publish wreq-js

This package uses a **single npm package** that includes pre-built native binaries for all supported platforms.

### Package Structure

When published, the package includes:
- TypeScript compiled code (`dist/`)
- Native binaries for all platforms (`rust/*.node`)

Supported platforms:
- 🍎 macOS Intel (x64)
- 🍎 macOS Apple Silicon (arm64)
- 🐧 Linux x64
- 🪟 Windows x64

### Publishing Process

#### 1. Prerequisites

- npm account with publish permissions
- GitHub repository set up
- `NPM_TOKEN` configured in GitHub Secrets

#### 1. Update Version

```bash
# Bump version using npm
npm version patch  # 0.1.0 → 0.1.1
npm version minor  # 0.1.0 → 0.2.0
npm version major  # 0.1.0 → 1.0.0
```

#### 2. Create GitHub Release

```bash
# Push version tag
git push --follow-tags

# Or manually create tag
git tag v0.1.0
git push origin v0.1.0
```

Then create a GitHub Release from this tag. This will trigger the build workflow.

#### 3. Automated Build & Publish

GitHub Actions will automatically:
1. Build native binaries for all platforms (macOS, Linux, Windows)
2. Collect all binaries into the `rust/` directory
3. Build TypeScript code
4. Publish the package to npm with all binaries included

### Local Testing Before Publishing

```bash
# Build everything
npm run build

# Run tests
npm test

# Pack to see what will be published
npm pack

# Extract and inspect
tar -tzf wreq-js-*.tgz

# Test in another project
cd /path/to/test-project
npm install /path/to/wreq-js/wreq-js-*.tgz
```

### Manual Publishing (Not Recommended)

If you need to publish manually:

```bash
# Build TypeScript
npm run build:ts

# Ensure all platform binaries are in rust/ directory
ls rust/*.node

# Publish
npm publish --access public
```

**Note:** Manual publishing requires you to have all platform binaries built locally, which is difficult without cross-compilation setup. Use GitHub Actions instead.

## Troubleshooting

### Build Fails in CI

- Check that all platform targets are properly configured
- Verify Rust toolchain is installed correctly
- Check CMake is available (required for BoringSSL)

### Module Load Error After Install

- Verify `rust/*.node` files are included in the published package
- Check that the binary was built for the user's platform
- Ensure file permissions are correct
