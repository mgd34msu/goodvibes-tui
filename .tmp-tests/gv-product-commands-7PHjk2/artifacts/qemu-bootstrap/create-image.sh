#!/usr/bin/env bash
set -euo pipefail

IMAGE_PATH="${1:-/home/buzzkill/Projects/goodvibes-tui/.tmp-tests/gv-product-commands-7PHjk2/artifacts/qemu-bootstrap/images/goodvibes-sandbox.qcow2}"
SIZE_GB="${2:-20}"
QEMU_IMG_BIN="${QEMU_IMG_BIN:-qemu-img}"

exec "$QEMU_IMG_BIN" create -f qcow2 "$IMAGE_PATH" "${SIZE_GB}G"
