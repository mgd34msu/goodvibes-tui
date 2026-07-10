#!/bin/sh
# GoodVibes installer — https://goodvibes.sh/install.sh
#
#   curl -fsSL https://goodvibes.sh/install.sh | sh
#
# Downloads the self-contained goodvibes + goodvibes-daemon binaries for this
# platform from the GitHub release, verifies both against SHA256SUMS.txt
# (a missing manifest entry is a hard failure, never a skip), installs them
# into ~/.local/bin (override with GOODVIBES_INSTALL_DIR), and runs the
# doctor install self-check when possible.
#
# Also installs goodvibes-agent (the always-on personal agent) by default.
# The agent has no compiled binary — it runs on Bun — so this step uses an
# existing Bun install or installs Bun first via its official installer.
#
# Options (environment variables, so the pipe-to-sh form stays one command):
#   GOODVIBES_VERSION      install a specific tag, e.g. v1.13.1 (default: latest)
#   GOODVIBES_INSTALL_DIR  target directory (default: ~/.local/bin)
#   GOODVIBES_AGENT        set to 0 to skip installing goodvibes-agent (default: 1)
#
# This file is versioned in the goodvibes-tui repository at scripts/install.sh
# and published to goodvibes.sh on release. The `/update` command re-runs the
# same download-verify-swap logic; keep the two in lockstep.

set -eu

REPO="mgd34msu/goodvibes-tui"
INSTALL_DIR="${GOODVIBES_INSTALL_DIR:-$HOME/.local/bin}"
REQUESTED_VERSION="${GOODVIBES_VERSION:-latest}"
WITH_AGENT="${GOODVIBES_AGENT:-1}"

say() { printf '%s\n' "$*"; }
fail() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

# --- platform detection (release asset naming: goodvibes[-daemon]-{linux|macos}-{x64|arm64}) ---
resolve_platform() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Linux) os_tag="linux" ;;
    Darwin) os_tag="macos" ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      fail "native Windows is not supported yet. Install WSL2 and run GoodVibes inside it (the Linux binaries apply unchanged):
    1. In an elevated PowerShell:  wsl --install
    2. Open your WSL2 distribution, then re-run:  curl -fsSL https://goodvibes.sh/install.sh | sh
  WSL2 setup and native-Windows status: https://github.com/$REPO/blob/main/docs/windows.md" ;;
    *) fail "unsupported operating system: $os (Windows: use WSL2 — see https://github.com/$REPO/blob/main/docs/windows.md)" ;;
  esac
  case "$arch" in
    x86_64|amd64) arch_tag="x64" ;;
    aarch64|arm64) arch_tag="arm64" ;;
    *) fail "unsupported architecture: $arch" ;;
  esac
  PLATFORM_SUFFIX="${os_tag}-${arch_tag}"
}

# --- tooling: curl or wget, and a sha256 command ---
fetch() {
  # fetch <url> <dest>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https' --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    fail "need curl or wget"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "need sha256sum or shasum to verify downloads"
  fi
}

# --- resolve version tag ---
resolve_version() {
  if [ "$REQUESTED_VERSION" = "latest" ]; then
    # GitHub serves the tag in the redirect Location for /releases/latest.
    if command -v curl >/dev/null 2>&1; then
      redirect=$(curl -fsSI -o /dev/null -w '%{redirect_url}' "https://github.com/$REPO/releases/latest") ||
        fail "could not resolve the latest release tag"
      VERSION="${redirect##*/}"
    else
      redirect=$(wget -q --max-redirect=0 --server-response "https://github.com/$REPO/releases/latest" 2>&1 |
        awk '/Location:/ {print $2}' | tr -d '\r' | head -1)
      VERSION="${redirect##*/}"
    fi
    [ -n "$VERSION" ] || fail "could not resolve the latest release tag"
  else
    VERSION="$REQUESTED_VERSION"
  fi
  case "$VERSION" in v*) : ;; *) VERSION="v$VERSION" ;; esac
}

# --- goodvibes-agent: npm package running on Bun (no compiled binary exists) ---
install_agent() {
  say ""
  say "Installing goodvibes-agent ..."

  bun_bin=""
  if command -v bun >/dev/null 2>&1; then
    bun_bin="bun"
  elif [ -x "${BUN_INSTALL:-$HOME/.bun}/bin/bun" ]; then
    bun_bin="${BUN_INSTALL:-$HOME/.bun}/bin/bun"
  else
    say "  goodvibes-agent runs on Bun; installing Bun first (official installer) ..."
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 ||
        fail "Bun install failed. The TUI is installed and working; install Bun manually (https://bun.sh), then run: bun add -g @pellux/goodvibes-agent"
    else
      wget -qO- https://bun.sh/install | bash >/dev/null 2>&1 ||
        fail "Bun install failed. The TUI is installed and working; install Bun manually (https://bun.sh), then run: bun add -g @pellux/goodvibes-agent"
    fi
    bun_bin="${BUN_INSTALL:-$HOME/.bun}/bin/bun"
    [ -x "$bun_bin" ] || fail "Bun installer finished but bun was not found at $bun_bin. The TUI is installed and working; run: bun add -g @pellux/goodvibes-agent"
  fi

  "$bun_bin" add -g @pellux/goodvibes-agent >/dev/null 2>&1 ||
    fail "goodvibes-agent install failed. The TUI is installed and working; retry with: $bun_bin add -g @pellux/goodvibes-agent"

  # Global bin dir for bun installs (agent has no postinstall and needs no trust step).
  # `bun pm bin -g` prints the directory itself.
  agent_bin_dir=$("$bun_bin" pm bin -g 2>/dev/null) || agent_bin_dir="${BUN_INSTALL:-$HOME/.bun}/bin"
  if [ -x "$agent_bin_dir/goodvibes-agent" ]; then
    say "  installed  $agent_bin_dir/goodvibes-agent"
    case ":$PATH:" in
      *":$agent_bin_dir:"*) : ;;
      *)
        say "  NOTE: $agent_bin_dir is not on your PATH. Add it with:"
        say "    export PATH=\"$agent_bin_dir:\$PATH\""
        ;;
    esac
  else
    say "  installed (run 'bun pm bin -g' to locate the goodvibes-agent command)"
  fi
}

main() {
  resolve_platform
  resolve_version

  BASE_URL="https://github.com/$REPO/releases/download/$VERSION"
  WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/goodvibes-install.XXXXXX")
  trap 'rm -rf "$WORKDIR"' EXIT INT TERM

  say "Installing GoodVibes $VERSION for $PLATFORM_SUFFIX into $INSTALL_DIR"

  fetch "$BASE_URL/SHA256SUMS.txt" "$WORKDIR/SHA256SUMS.txt"

  for artifact in "goodvibes-$PLATFORM_SUFFIX" "goodvibes-daemon-$PLATFORM_SUFFIX"; do
    say "  downloading $artifact ..."
    fetch "$BASE_URL/$artifact" "$WORKDIR/$artifact"

    expected=$(awk -v name="$artifact" '$2 == name || $2 == "*"name {print $1}' "$WORKDIR/SHA256SUMS.txt" | head -1)
    [ -n "$expected" ] || fail "SHA256SUMS.txt has no entry for $artifact — refusing to install an unverified binary"
    actual=$(sha256_of "$WORKDIR/$artifact")
    [ "$expected" = "$actual" ] || fail "checksum mismatch for $artifact (expected $expected, got $actual)"
    say "  verified   $artifact"
  done

  mkdir -p "$INSTALL_DIR"
  for artifact in "goodvibes-$PLATFORM_SUFFIX" "goodvibes-daemon-$PLATFORM_SUFFIX"; do
    # Strip the platform suffix for the installed command name.
    target="$INSTALL_DIR/$(printf '%s' "$artifact" | sed "s/-$PLATFORM_SUFFIX\$//")"
    # Install atomically: write next to the target, then rename over it, so a
    # running binary is replaced cleanly (the old inode stays alive for
    # existing processes — this is also what /update relies on).
    chmod +x "$WORKDIR/$artifact"
    mv -f "$WORKDIR/$artifact" "$target"
    say "  installed  $target"
  done

  case ":$PATH:" in
    *":$INSTALL_DIR:"*) : ;;
    *)
      say ""
      say "NOTE: $INSTALL_DIR is not on your PATH. Add it with:"
      say "  export PATH=\"$INSTALL_DIR:\$PATH\""
      ;;
  esac

  # Smoke test: the installed binary must at least report its version.
  # (doctor is a next-step suggestion, not an install gate — it exits non-zero
  # on advisory findings, which would make healthy installs look broken here.)
  say ""
  if installed_version=$("$INSTALL_DIR/goodvibes" --version 2>/dev/null); then
    say "Installed: $installed_version"
  else
    fail "the installed binary failed to run ('goodvibes --version'); the download may not match this platform"
  fi

  if [ "$WITH_AGENT" = "1" ]; then
    install_agent
  fi

  say ""
  say "Done. Start with: goodvibes   (health check: goodvibes doctor)"
  if [ "$WITH_AGENT" = "1" ]; then
    say "Personal agent:   goodvibes-agent"
  fi
}

main
