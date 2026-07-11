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
# Also installs goodvibes-agent (the always-on personal agent) by default,
# as a compiled binary from its own repository's release — the whole install
# is pure-binary and checksum-verified; nothing is fetched through a package
# manager.
#
# Options (environment variables, so the pipe-to-sh form stays one command):
#   GOODVIBES_VERSION         install a specific TUI tag, e.g. v1.14.0 (default: latest)
#   GOODVIBES_INSTALL_DIR     target directory (default: ~/.local/bin)
#   GOODVIBES_AGENT           set to 0 to skip installing goodvibes-agent (default: 1)
#   GOODVIBES_AGENT_VERSION   install a specific agent tag (default: latest)
#   GOODVIBES_RESTART_DAEMON  set to 0 to leave running daemon/agent untouched (default: 1)
#
# This file is versioned in the goodvibes-tui repository at scripts/install.sh
# and published to goodvibes.sh on release. The `/update` command re-runs the
# same download-verify-swap logic; keep the two in lockstep.

set -eu

REPO="mgd34msu/goodvibes-tui"
AGENT_REPO="mgd34msu/goodvibes-agent"
INSTALL_DIR="${GOODVIBES_INSTALL_DIR:-$HOME/.local/bin}"
REQUESTED_VERSION="${GOODVIBES_VERSION:-latest}"
REQUESTED_AGENT_VERSION="${GOODVIBES_AGENT_VERSION:-latest}"
WITH_AGENT="${GOODVIBES_AGENT:-1}"
RESTART_DAEMON="${GOODVIBES_RESTART_DAEMON:-1}"

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

# --- resolve a release tag for a repo ---
resolve_tag() {
  # resolve_tag <repo> <requested> — prints the tag (vX.Y.Z)
  tag_repo="$1"
  tag_requested="$2"
  if [ "$tag_requested" = "latest" ]; then
    # GitHub serves the tag in the redirect Location for /releases/latest.
    if command -v curl >/dev/null 2>&1; then
      redirect=$(curl -fsSI -o /dev/null -w '%{redirect_url}' "https://github.com/$tag_repo/releases/latest") ||
        fail "could not resolve the latest release tag for $tag_repo"
      tag="${redirect##*/}"
    else
      redirect=$(wget -q --max-redirect=0 --server-response "https://github.com/$tag_repo/releases/latest" 2>&1 |
        awk '/Location:/ {print $2}' | tr -d '\r' | head -1)
      tag="${redirect##*/}"
    fi
    [ -n "$tag" ] || fail "could not resolve the latest release tag for $tag_repo"
  else
    tag="$tag_requested"
  fi
  case "$tag" in v*) : ;; *) tag="v$tag" ;; esac
  printf '%s' "$tag"
}

resolve_version() {
  VERSION=$(resolve_tag "$REPO" "$REQUESTED_VERSION")
}

# --- restart on upgrade ---
# The curl one-liner doubles as the upgrade path. Replacing a binary on disk
# does not affect a running process (it keeps executing the old inode), so an
# already-running daemon/agent must be restarted for the upgrade to take
# effect. systemd-managed services are restarted through their unit; bare
# processes are stopped and relaunched with their original arguments.

restart_systemd_unit() {
  # restart_systemd_unit <unit> <expected-binary> — returns 0 if it handled a
  # running unit (restarted or reported), 1 if no active unit exists.
  unit="$1"
  expected_bin="$2"
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user is-active --quiet "$unit" 2>/dev/null || return 1
  say ""
  say "Restarting the running ${unit%.service} (systemd user service) ..."
  if systemctl --user restart "$unit" 2>/dev/null; then
    say "  restarted  $unit"
    exec_start=$(systemctl --user show -p ExecStart --value "$unit" 2>/dev/null || true)
    case "$exec_start" in
      ""|*"$expected_bin"*) : ;;
      *)
        say "  NOTE: the service does not exec $expected_bin, so it may still be"
        say "  running a different (older) install. Inspect it with:"
        say "    systemctl --user cat $unit"
        ;;
    esac
  else
    say "  NOTE: restart failed — restart it yourself with:"
    say "    systemctl --user restart $unit"
  fi
  return 0
}

restart_bare_processes() {
  # restart_bare_processes <pgrep-pattern> <new-binary>
  pattern="$1"
  new_bin="$2"
  pids=$(pgrep -f "$pattern" 2>/dev/null || true)
  [ -n "$pids" ] || return 0
  for pid in $pids; do
    # Recover the original arguments so flags (port, host, home dir) survive.
    if [ -r "/proc/$pid/cmdline" ]; then
      args=$(tr '\0' '\n' < "/proc/$pid/cmdline" | tail -n +2 | tr '\n' ' ')
    else
      args=$(ps -o args= -p "$pid" 2>/dev/null | sed 's/^[^ ]* *//')
    fi
    args=$(printf '%s' "${args:-}" | sed 's/[[:space:]]*$//')
    say ""
    say "Restarting running ${new_bin##*/} (pid $pid) ..."
    kill "$pid" 2>/dev/null || continue
    waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 10 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      say "  NOTE: pid $pid did not exit within 10s — not starting a second instance."
      say "  Stop it, then start the new one: $new_bin ${args:-}"
      continue
    fi
    # shellcheck disable=SC2086  # args is intentionally word-split
    nohup "$new_bin" ${args:-} >/dev/null 2>&1 &
    newpid=$!
    sleep 1
    if kill -0 "$newpid" 2>/dev/null; then
      say "  restarted  pid $newpid${args:+ (args: $args)}"
    else
      say "  NOTE: the new process did not stay up — start it yourself and check its output:"
      say "    $new_bin ${args:-}"
    fi
  done
}

restart_running_daemon() {
  [ "$RESTART_DAEMON" = "1" ] || return 0
  restart_systemd_unit goodvibes-daemon.service "$INSTALL_DIR/goodvibes-daemon" && return 0
  restart_bare_processes '[g]oodvibes-daemon' "$INSTALL_DIR/goodvibes-daemon"
}

restart_running_agent() {
  [ "$RESTART_DAEMON" = "1" ] || return 0
  restart_systemd_unit goodvibes-agent.service "$INSTALL_DIR/goodvibes-agent" && return 0
  restart_bare_processes '[g]oodvibes-agent' "$INSTALL_DIR/goodvibes-agent"
}

# --- goodvibes-agent: compiled binary from its own repository's release ---
install_agent() {
  say ""
  AGENT_VERSION=$(resolve_tag "$AGENT_REPO" "$REQUESTED_AGENT_VERSION")
  agent_base_url="https://github.com/$AGENT_REPO/releases/download/$AGENT_VERSION"
  artifact="goodvibes-agent-$PLATFORM_SUFFIX"

  say "Installing goodvibes-agent $AGENT_VERSION ..."
  fetch "$agent_base_url/SHA256SUMS.txt" "$WORKDIR/agent-SHA256SUMS.txt"

  say "  downloading $artifact ..."
  fetch "$agent_base_url/$artifact" "$WORKDIR/$artifact"

  expected=$(awk -v name="$artifact" '$2 == name || $2 == "*"name {print $1}' "$WORKDIR/agent-SHA256SUMS.txt" | head -1)
  [ -n "$expected" ] || fail "SHA256SUMS.txt has no entry for $artifact — refusing to install an unverified binary"
  actual=$(sha256_of "$WORKDIR/$artifact")
  [ "$expected" = "$actual" ] || fail "checksum mismatch for $artifact (expected $expected, got $actual)"
  say "  verified   $artifact"

  chmod +x "$WORKDIR/$artifact"
  mv -f "$WORKDIR/$artifact" "$INSTALL_DIR/goodvibes-agent"
  say "  installed  $INSTALL_DIR/goodvibes-agent"

  if agent_version_out=$("$INSTALL_DIR/goodvibes-agent" --version 2>/dev/null); then
    say "  running:   $agent_version_out"
  else
    fail "the installed goodvibes-agent binary failed to run ('goodvibes-agent --version')"
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

  restart_running_daemon

  if [ "$WITH_AGENT" = "1" ]; then
    install_agent
    restart_running_agent
  fi

  say ""
  say "Done. Start with: goodvibes   (health check: goodvibes doctor)"
  if [ "$WITH_AGENT" = "1" ]; then
    say "Personal agent:   goodvibes-agent"
  fi
}

main
