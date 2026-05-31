#!/usr/bin/env bash
#
# Rebuilds the public release/ tree from the private justscale/ source tree.
#
# Idempotent: safe to re-run after every source change.
#
# Each package has up to two lists:
#   - STRIP: paths that are present in source but must NOT exist in release
#            (private compiler plugins, LSP, plugin tests, cluster proto codec).
#            These are `rm -rf`'d from release first, then `--exclude`'d from
#            the rsync so they don't come back.
#   - KEEP:  paths that exist in both trees but diverge intentionally
#            (release-only-edited files). These are `--exclude`'d from rsync
#            so the release version is preserved untouched.
#
# Release-only files (KEEP list):
#   - packages/core/typescript/src/index.ts      (no proto/capnp re-exports)
#   - packages/core/typescript/src/api.ts        (no ProtoModuleResolver)
#   - packages/core/typescript/package.json      (no proto/graphql/vscode deps,
#                                                 no `lsp` bin, no `./lsp` export)
#
# Root-level release-only files (never touched by this script):
#   - README.md, package.json, pnpm-workspace.yaml, tsconfig.json
#
# Usage:
#   ./scripts/build-public-release.sh                # default paths
#   SOURCE=/path/to/justscale ./scripts/build-public-release.sh

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RELEASE_ROOT="$(cd "$HERE/.." && pwd)"
SOURCE="${SOURCE:-$(cd "$RELEASE_ROOT/../justscale" && pwd)}"

if [ ! -d "$SOURCE/packages/core/core" ]; then
  echo "fatal: source tree not found at $SOURCE" >&2
  exit 1
fi

echo "source : $SOURCE"
echo "release: $RELEASE_ROOT"
echo

COMMON_EXCLUDES=(
  --exclude=/node_modules
  --exclude=/dist
  --exclude=/lib
  --exclude=/.turbo
)

# strip_from_release PKG PATH1 PATH2 ...
strip_from_release() {
  local pkg="$1"
  shift
  for p in "$@"; do
    rm -rf "$RELEASE_ROOT/$pkg/$p"
  done
}

# sync_pkg PKG [PATH_TO_EXCLUDE ...]
# Excluded paths are not copied from source. Combined with strip_from_release,
# they're removed from release and prevented from coming back.
sync_pkg() {
  local pkg="$1"
  shift
  local exclude_args=()
  local p
  for p in "$@"; do
    exclude_args+=(--exclude="/$p")
  done
  rsync -a --delete "${COMMON_EXCLUDES[@]}" \
    ${exclude_args[@]+"${exclude_args[@]}"} \
    "$SOURCE/$pkg/" "$RELEASE_ROOT/$pkg/"
  echo "sync   $pkg"
}

# --- core ---
CORE_STRIP=(
  src/cluster/proto-codec.ts
  src/cluster/cluster.proto
)
CORE_KEEP=(
  # has 3 v1.1-deferred it.todo blocks stripped for release
  test/process/runtime/subprocess-lifecycle.test.ts
)
strip_from_release packages/core/core "${CORE_STRIP[@]}"
sync_pkg            packages/core/core "${CORE_STRIP[@]}" "${CORE_KEEP[@]}"

# --- typescript ---
TS_STRIP=(
  src/plugins/capnp
  src/plugins/graphql
  src/plugins/protobuf
  src/lsp
  test/capnp-integration.test.ts
  test/protobuf-integration.test.ts
  test/protobuf-diagnostics.test.ts
  test/protobuf-sourcemaps.test.ts
  test/protobuf
  test/lsp
)
TS_KEEP=(
  src/index.ts
  src/api.ts
  package.json
  # cli.test.ts and tsserver-e2e.test.ts have proto-specific tests stripped
  test/cli.test.ts
  test/tsserver-e2e.test.ts
)
strip_from_release packages/core/typescript "${TS_STRIP[@]}"
sync_pkg            packages/core/typescript "${TS_STRIP[@]}" "${TS_KEEP[@]}"

# --- rest (clean mirrors) ---
sync_pkg packages/core/testing
sync_pkg packages/protocol/http
sync_pkg packages/protocol/websocket
sync_pkg packages/adapters/postgres
sync_pkg packages/feature/auth
sync_pkg packages/feature/permission
sync_pkg packages/misc/install

# --- examples (public-facing showcase apps) ---
# Only examples that depend solely on the shipped package set
# (core/typescript/testing/http/postgres/auth/sse/permission) belong here.
# .justscale is a dev-time process cache, never shipped.
#
# package.json is KEEP-excluded for the showcases: the release copies are
# renamed to the @justscale-examples/ scope so the publish workflow's
# `^@justscale/` package grep never picks them up. chat-app also KEEP-excludes
# src/dev.ts (release runs without the internal-only @justscale/feature-shell).
sync_pkg examples/order-fulfillment .justscale
sync_pkg examples/webshop      .justscale package.json
sync_pkg examples/crowdfunding .justscale package.json
sync_pkg examples/chat-app     .justscale package.json src/dev.ts

echo
echo "swap   plugins/index.ts <- plugins/index.public.ts"
cp "$RELEASE_ROOT/packages/core/typescript/src/plugins/index.public.ts" \
   "$RELEASE_ROOT/packages/core/typescript/src/plugins/index.ts"

ROOT_FILES=(
  CONTRIBUTING.md
  CODE_OF_CONDUCT.md
  SECURITY.md
  LICENSE
  eslint.config.js
  turbo.json
  docker-compose.yml
  .npmrc
  .nvmrc
  .gitignore
  .github/workflows/publish.yml
)

echo
for f in "${ROOT_FILES[@]}"; do
  if [ -f "$SOURCE/$f" ]; then
    mkdir -p "$RELEASE_ROOT/$(dirname "$f")"
    cp "$SOURCE/$f" "$RELEASE_ROOT/$f"
    echo "sync   $f"
  fi
done

echo
echo "done. now: pnpm install && pnpm build && pnpm test"
