#!/usr/bin/env bash
#
# One-time bootstrap for the @wreq-js/binding-* platform packages.
#
# npm cannot configure a trusted publisher for a package that does not exist
# yet ("Package must exist" — https://docs.npmjs.com/cli/v12/commands/npm-trust),
# so the release workflow's OIDC publish has nothing to authenticate against
# until each name has been claimed once. This script claims all seven names
# with an empty 0.0.0 placeholder and then points them at the release workflow.
#
# Run it once, locally, from a logged-in npm account with 2FA enabled. Every
# release after that is handled entirely by .github/workflows/build.yml.
#
# Usage: scripts/bootstrap-platform-packages.sh [--dry-run]

set -euo pipefail

REPO="sqdshguy/wreq-js"
WORKFLOW="build.yml"
PLACEHOLDER_VERSION="0.0.0"

DRY_RUN=""
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN="--dry-run"
fi

cd "$(dirname "$0")/.."

if [[ ! -d npm ]]; then
  echo "npm/ not found. Run 'npm run npm:dirs' first." >&2
  exit 1
fi

# npm 11 advertises --allow-publish in `npm trust github --help` but never
# defines the flag, so it fails to parse; and since May 2026 the registry
# requires a trusted publisher to name at least one allowed action, which
# npm 11 cannot send. Fail early rather than half-way through the loop.
npm_major=$(npm --version | cut -d. -f1)
if [[ -z "$DRY_RUN" && "$npm_major" -lt 12 ]]; then
  echo "npm $(npm --version) cannot configure trusted publishing (needs 11.15+ with a" >&2
  echo "working --allow-publish, i.e. npm 12 or later)." >&2
  echo "Upgrade with: npm install -g npm@latest" >&2
  exit 1
fi

echo "Bootstrapping platform packages for $REPO (workflow: $WORKFLOW)"
echo "npm user: $(npm whoami)"
echo

for dir in npm/*/; do
  name=$(node -p "require('./${dir}package.json').name")
  echo "==> $name"

  if npm view "$name" version >/dev/null 2>&1; then
    echo "    already on the registry, skipping placeholder publish"
  else
    # Publish from a copy so the working tree keeps the real version.
    staging=$(mktemp -d)
    cp "${dir}package.json" "$staging/"
    if [[ -f "${dir}README.md" ]]; then
      cp "${dir}README.md" "$staging/"
    fi
    (cd "$staging" && npm pkg set version="$PLACEHOLDER_VERSION" >/dev/null)
    npm publish "$staging" --access public $DRY_RUN
    rm -rf "$staging"
    echo "    claimed at $PLACEHOLDER_VERSION"
  fi

  if [[ -z "$DRY_RUN" ]]; then
    # Existing configurations are left alone; npm errors on a duplicate.
    if npm trust list "$name" 2>/dev/null | grep -q "$WORKFLOW"; then
      echo "    trusted publisher already configured"
    else
      npm trust github "$name" \
        --file "$WORKFLOW" \
        --repo "$REPO" \
        --allow-publish \
        --yes
      echo "    trusted publisher configured"
    fi
  fi

  # npm rate-limits back-to-back trust calls; the 2FA skip window covers these.
  sleep 2
done

echo
echo "Done. Verify with: npm trust list @wreq-js/binding-linux-x64-gnu"
