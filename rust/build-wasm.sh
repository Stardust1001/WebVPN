#!/bin/bash
# 构建 WASM AST 改写模块，部署到 public/rewrite.wasm
# 用法：bash rust/build-wasm.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WASM_CRATE_DIR="$SCRIPT_DIR/wasm"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT="$PROJECT_ROOT/public/rewrite.wasm"

# 确保 wasm32 目标已安装
rustup target add wasm32-unknown-unknown 2>/dev/null || true

echo "Building WASM crate in $WASM_CRATE_DIR ..."
cd "$WASM_CRATE_DIR"
cargo build --release --target wasm32-unknown-unknown

WASM_FILE="target/wasm32-unknown-unknown/release/webvpn_rewrite_wasm.wasm"
if [ ! -f "$WASM_FILE" ]; then
    echo "ERROR: WASM output not found at $WASM_FILE"
    exit 1
fi

cp "$WASM_FILE" "$OUTPUT"
SIZE=$(wc -c < "$OUTPUT" | tr -d ' ')
echo "Deployed: $OUTPUT ($SIZE bytes)"
