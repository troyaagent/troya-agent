#!/usr/bin/env bash
# Fetches Lighter's official browser signer (lighter-go v1.0.12) and the Go 1.25.5 wasm_exec.js it was built with,
# checks the sha256 GitHub publishes for the release asset, and pre-gzips it for the server.
set -euo pipefail
D="$(cd "$(dirname "$0")/.." && pwd)/public/vendor/lighter"
mkdir -p "$D"
curl -sL -o "$D/lighter-signer-web.wasm" https://github.com/elliottech/lighter-go/releases/download/v1.0.12/lighter-signer-web.wasm
echo "95c9dd38373405691498c52c0feb72338e6bb00e90362227efe59fb12523c5ae  $D/lighter-signer-web.wasm" | shasum -a 256 -c -
curl -s -o "$D/wasm_exec.js" https://raw.githubusercontent.com/golang/go/go1.25.5/lib/wasm/wasm_exec.js
gzip -9 -f -k "$D/lighter-signer-web.wasm"
echo "ok: $D"
