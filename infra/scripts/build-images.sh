#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$SCRIPT_DIR/build-signer-dmz.sh"
"$SCRIPT_DIR/build-signer.sh"
"$SCRIPT_DIR/build-control-plane.sh"
