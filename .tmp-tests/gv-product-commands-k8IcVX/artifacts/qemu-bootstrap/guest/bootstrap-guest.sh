#!/usr/bin/env bash
set -euo pipefail

# GoodVibes guest bootstrap scaffold
# Run this inside a Linux guest image after first boot.

if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y openssh-server python3 tar
fi

sudo mkdir -p /workspace
id -u goodvibes >/dev/null 2>&1 || sudo useradd -m -s /bin/bash goodvibes
sudo chown -R goodvibes:goodvibes /workspace
sudo systemctl enable ssh || true
sudo systemctl restart ssh || true
