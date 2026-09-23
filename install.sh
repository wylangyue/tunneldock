#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$HOME/.local/bin"
chmod +x "$ROOT_DIR/bin/tunneldock"
ln -sfn "$ROOT_DIR/bin/tunneldock" "$HOME/.local/bin/tunneldock"

export PATH="$HOME/.local/bin:$PATH"
exec "$ROOT_DIR/bin/tunneldock" install
