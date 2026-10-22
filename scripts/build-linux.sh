#!/usr/bin/env bash
#
# Build the Linux bundles of this project. Run it from inside Linux — WSL2, a
# container, or a bare machine.
#
#   bash scripts/build-linux.sh              # deb + AppImage
#   bash scripts/build-linux.sh --bundles deb
#
# Why a script instead of just `npm run dist`:
#
#   * Tauri cannot be cross-compiled from Windows. webkit2gtk and libsoup are
#     native libraries resolved through pkg-config and there is no usable
#     sysroot, so the build has to happen where those libraries live.
#   * Building on /mnt/c is roughly an order of magnitude slower than on the
#     Linux filesystem, and cargo's file locking over 9p is not reliable. The
#     sources are therefore rsynced to a cache directory before building.
#   * The frontend bundle is platform-independent, so when Node is unavailable
#     the already-built dist/ is reused and Vite is skipped.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="${MDRAFT_BUILD_DIR:-$HOME/.cache/mdraft-build}"
BUNDLES=""

while [ $# -gt 0 ]; do
  case "$1" in
    --bundles) BUNDLES="${2:?--bundles needs a value}"; shift 2 ;;
    --bundles=*) BUNDLES="${1#*=}"; shift ;;
    --build-dir) BUILD_DIR="${2:?--build-dir needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ---- prerequisites ---------------------------------------------------------

for tool in cargo rsync pkg-config; do
  command -v "$tool" >/dev/null || die "$tool is not on PATH"
done

missing=()
for pkg in webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0 gtk+-3.0 hunspell; do
  pkg-config --exists "$pkg" 2>/dev/null || missing+=("$pkg")
done
if [ ${#missing[@]} -gt 0 ]; then
  cat >&2 <<EOF
error: missing Tauri Linux dependencies: ${missing[*]}

On Debian/Ubuntu:
  sudo apt update && sudo apt install -y \\
    libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev \\
    libgtk-3-dev librsvg2-dev patchelf libhunspell-dev
EOF
  exit 1
fi

# A cargo-installed CLI needs no Node at all; otherwise use the version pinned
# in package.json through npx.
if command -v cargo-tauri >/dev/null; then
  TAURI=(cargo-tauri)
  CLI_KIND="cargo-tauri ($(cargo-tauri --version 2>/dev/null | head -1))"
elif command -v node >/dev/null && command -v npm >/dev/null; then
  TAURI=(npx tauri)
  CLI_KIND="npx tauri ($(node --version))"
else
  die "need either cargo-tauri (cargo install tauri-cli) or node + npm on PATH"
fi

# ---- stage the sources on the Linux filesystem -----------------------------

say "staging sources into $BUILD_DIR"
mkdir -p "$BUILD_DIR"
rsync -a --delete \
  --exclude 'node_modules' \
  --exclude 'src-tauri/target' \
  --exclude 'bin' \
  --exclude '.git' \
  "$REPO/" "$BUILD_DIR/"

[ -f "$BUILD_DIR/src-tauri/tauri.conf.json" ] || die "the stage is missing tauri.conf.json"

# ---- frontend --------------------------------------------------------------

CONFIG_OVERRIDE=()
if command -v node >/dev/null && command -v npm >/dev/null; then
  say "installing frontend dependencies (npm ci)"
  ( cd "$BUILD_DIR" && npm ci --no-audit --no-fund )
  say "building the frontend with Vite"
  ( cd "$BUILD_DIR" && npm run build )
elif [ -f "$BUILD_DIR/dist/index.html" ]; then
  # The dist/ copied from the host is plain HTML/CSS/JS plus fonts and is
  # platform-independent, so it can be reused verbatim.
  say "no Node found: reusing the pre-built dist/ copied from the host"
  CONFIG_OVERRIDE=(--config '{"build":{"beforeBuildCommand":"true"}}')
else
  die "no Node on PATH and no dist/index.html to reuse
       Either install Node, or run 'npm run build' on the host first so dist/ exists."
fi

say "toolchain: $CLI_KIND"
say "cargo:     $(cargo --version)"

# ---- build -----------------------------------------------------------------

BUNDLE_ARG=()
[ -n "$BUNDLES" ] && BUNDLE_ARG=(--bundles "$BUNDLES")

# The cache is not part of the source and survives between builds, so after a
# rename it still holds the previous name's installers beside the new ones. The
# collection loop below copies every bundle it finds, which is how an old
# MDraft_*.deb once shipped next to a new one. Clear the bundle kinds so only
# what this build produced can be collected.
rm -rf "$BUILD_DIR"/src-tauri/target/release/bundle/{deb,rpm,appimage}

say "building and bundling${BUNDLES:+ ($BUNDLES)}"
( cd "$BUILD_DIR" && "${TAURI[@]}" build "${BUNDLE_ARG[@]}" "${CONFIG_OVERRIDE[@]}" )

# ---- collect ---------------------------------------------------------------

DEST="$REPO/bin/linux/amd64"
mkdir -p "$DEST"
say "collecting artefacts into bin/linux/amd64"

# The destination is not cleaned by the copy loop either, so an installer from an
# earlier release would stay beside the new one — the same stale-artefact trap as
# the cache directories cleared above, one step later. Remove what this script
# stages; the manifest and checksums are rewritten below.
rm -f "$DEST"/*.deb "$DEST"/*.rpm "$DEST"/*.AppImage

copied=0
for pattern in \
  "src-tauri/target/release/bundle/deb/*.deb" \
  "src-tauri/target/release/bundle/rpm/*.rpm" \
  "src-tauri/target/release/bundle/appimage/*.AppImage"
do
  for file in $BUILD_DIR/$pattern; do
    [ -e "$file" ] || continue
    cp -f "$file" "$DEST/"
    printf '  %-46s %s\n' "$(basename "$file")" "$(du -h "$file" | cut -f1)"
    copied=$((copied + 1))
  done
done

BIN="$BUILD_DIR/src-tauri/target/release/mdraft"
if [ -f "$BIN" ]; then
  cp -f "$BIN" "$DEST/mdraft"
  printf '  %-46s %s\n' "mdraft" "$(du -h "$BIN" | cut -f1)"
  copied=$((copied + 1))
fi

[ "$copied" -gt 0 ] || die "the build produced no artefacts"

# Same format as the Windows staging step, so `sha256sum -c` works either way.
( cd "$DEST" && sha256sum ./* > SHA256SUMS.txt 2>/dev/null || true )

# And the same manifest schema as scripts/stage-artifacts.mjs. CI runs that
# script natively on Linux, so without this the local helper and CI disagree and
# a release carries a manifest for one platform only.
#
# `product` is the display name from the base config, never the lowercase
# bundle name the platform config gives Tauri: the manifest describes the
# product, while the filenames beside it follow the platform's naming.
config_value() {
  grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$BUILD_DIR/src-tauri/tauri.conf.json" |
    head -1 | sed 's/.*:[[:space:]]*"\([^"]*\)"$/\1/'
}

{
  printf '{\n  "product": "%s",\n  "version": "%s",\n  "os": "linux",\n  "arch": "amd64",\n  "generatedAt": "%s",\n  "files": [\n' \
    "$(config_value productName)" "$(config_value version)" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  first=1
  for file in "$DEST"/*; do
    [ -f "$file" ] || continue
    name=$(basename "$file")
    [ "$name" = "manifest.json" ] && continue
    [ "$first" = 1 ] || printf ',\n'
    first=0
    printf '    { "name": "%s", "bytes": %s, "sha256": "%s" }' \
      "$name" "$(stat -c %s "$file")" "$(sha256sum "$file" | cut -d' ' -f1)"
  done
  printf '\n  ]\n}\n'
} > "$DEST/manifest.json"
say "wrote manifest.json and SHA256SUMS.txt"

say "$copied artefact(s) in bin/linux/amd64"
