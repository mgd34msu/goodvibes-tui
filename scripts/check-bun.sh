#!/bin/sh
set -eu

if ! command -v bun >/dev/null 2>&1; then
  cat >&2 <<'EOF'
goodvibes-tui requires Bun.

Install Bun first, then install GoodVibes from the npm registry with:

  bun add -g @pellux/goodvibes-tui

npm install -g @pellux/goodvibes-tui also works, but Bun must already be installed and available on PATH.
EOF
  exit 1
fi

if ! bun --version >/dev/null 2>&1; then
  echo "goodvibes-tui requires a working Bun executable on PATH." >&2
  exit 1
fi
