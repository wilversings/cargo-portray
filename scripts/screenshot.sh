#!/usr/bin/env bash
# Refreshes the README screenshot: cargo-portray drawing itself.
#
#   scripts/screenshot.sh [output.png]
#
# Needs a Chromium-family browser — chromium, chrome or brave, from PATH or
# from flatpak. Everything it starts, it stops.
#
# The browser profile is kept in target/ rather than a temp directory: a
# flatpak browser tends to hang the first time it opens a cold profile while a
# copy of itself is already running, and to be fine once that profile is warm.
# Hence the second attempt below.
set -euo pipefail
cd "$(dirname "$0")/.."

out=${1:-assets/overview.png}
port=${PORT:-7879}
size=${SIZE:-1600,1000}
# Long enough for the Graphviz WebAssembly module to load and lay the crate out.
budget=${BUDGET:-20000}

mkdir -p "$(dirname "$out")"
out=$(cd "$(dirname "$out")" && pwd)/$(basename "$out")
profile=$PWD/target/screenshot-profile
mkdir -p "$profile"

browser=()
for candidate in chromium chromium-browser google-chrome google-chrome-stable brave-browser; do
  if command -v "$candidate" >/dev/null 2>&1; then
    browser=("$candidate")
    break
  fi
done
if [ ${#browser[@]} -eq 0 ] && command -v flatpak >/dev/null 2>&1; then
  for app in org.chromium.Chromium com.google.Chrome com.brave.Browser; do
    if flatpak info "$app" >/dev/null 2>&1; then
      # A flatpak browser cannot see the output path or its own profile
      # unless it is told about them.
      browser=(flatpak run --filesystem="$(dirname "$out")" --filesystem="$profile" "$app")
      break
    fi
  done
fi
if [ ${#browser[@]} -eq 0 ]; then
  echo "no chromium, chrome or brave found" >&2
  exit 1
fi

cargo build --release

./target/release/cargo-portray serve . --port "$port" >/dev/null 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT

curl -sf --retry 30 --retry-delay 1 --retry-connrefused -o /dev/null "http://127.0.0.1:$port/"

shoot() {
  timeout 120 "${browser[@]}" \
    --headless=new \
    --disable-gpu \
    --no-sandbox \
    --no-first-run \
    --password-store=basic \
    --user-data-dir="$profile" \
    --window-size="$size" \
    --virtual-time-budget="$budget" \
    --screenshot="$out" \
    "http://127.0.0.1:$port/" >/dev/null 2>&1 || true
}

rm -f "$out"
shoot
[ -s "$out" ] || shoot

if [ ! -s "$out" ]; then
  echo "the browser produced no image" >&2
  exit 1
fi
echo "wrote $out"
