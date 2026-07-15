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
# It also downloads and verifies the platform's sqlite-vec native addon and
# places it at $INSTALL_DIR/lib/sqlite-vec-<os>-<arch>/vec0.<suffix> — the path
# the SDK resolves next to the running binary — so semantic vector search works
# for pure-binary installs (npm installs already ship it in the platform
# package). One copy in $INSTALL_DIR/lib serves goodvibes, goodvibes-daemon, and
# goodvibes-agent, since all three share $INSTALL_DIR. On macOS the addon is
# installed for consistency but Apple's system SQLite blocks extension loading,
# so the runtime reports the vector index unavailable and memory search stays
# literal — see docs/getting-started.md.
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
#   GOODVIBES_VECTOR          set to 0 to skip the sqlite-vec native addon (default: 1)
#   GOODVIBES_DAEMON_SERVICE  set to 0 to skip first-run daemon service setup (default: 1)
#   GOODVIBES_UNINSTALL       set to 1 to remove installer-managed files and stop
#                             the daemon/agent, then exit — no downloads (default: 0)
#
# First-run daemon service setup (GOODVIBES_DAEMON_SERVICE=1): when no daemon is
# running and no service unit exists yet, the installer registers the daemon as a
# user service (systemd user unit on Linux, launchd LaunchAgent on macOS) so a
# fresh install comes up with a running, auto-restarting daemon. It never
# overwrites an existing unit (installer-managed or hand-written) — the
# upgrade-restart path owns an already-running service — and falls back to
# printing the manual run command when no user service manager is available.
#
# Uninstall mode (GOODVIBES_UNINSTALL=1) takes precedence over everything else
# (no downloads happen): it stops the running daemon/agent, removes only the
# files this installer manages (the three binaries, the sqlite-vec addon dirs,
# the service unit/plist ONLY when it carries the installer-managed marker,
# and the PATH line in the shell rc file if one was ever added), deliberately
# preserves ~/.goodvibes user data, and prints a summary.
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
WITH_VECTOR="${GOODVIBES_VECTOR:-1}"
DAEMON_SERVICE="${GOODVIBES_DAEMON_SERVICE:-1}"
UNINSTALL="${GOODVIBES_UNINSTALL:-0}"

# The marker string written into every installer-created service unit/plist.
# The uninstall path keys on it to tell an installer-managed unit (safe to
# remove) apart from a hand-written one (never deleted, only reported). The
# systemd unit carries it as a `# managed by goodvibes install.sh` comment; the
# launchd plist carries it both as an XML comment and a GoodVibesManagedBy key —
# a plain substring grep for this string matches either form.
INSTALLER_MARKER="managed by goodvibes install.sh"

# Service unit / LaunchAgent identities. The systemd unit name is the SAME one
# the product's own service setup manages (src/daemon/service-commands.ts ->
# buildManagedDaemonServiceManager writes `goodvibes.service` with an
# args-driven ExecStart). Installer create/restart/uninstall all target this
# single canonical name so a curl install and the in-app `install-service`
# command never fight over two different units.
SYSTEMD_DAEMON_UNIT="goodvibes.service"
LAUNCHD_DAEMON_LABEL="sh.goodvibes.daemon"

# The prior generation of this installer created the daemon unit under the name
# `goodvibes-daemon.service` with a bare `ExecStart=<bin>` (no args). That unit
# name is retired: the upgrade path (migrate_legacy_installer_unit) disables and
# removes an installer-MARKER-managed one after the canonical unit is in place,
# and uninstall removes it too. A hand-written goodvibes-daemon.service (no
# marker) is always left alone and only reported.
LEGACY_SYSTEMD_DAEMON_UNIT="goodvibes-daemon.service"

# The canonical unit's ExecStart deliberately carries NO endpoint flags
# (--hostname/--port): the daemon resolves controlPlane.hostMode/host/port from
# the user's settings at boot, so a host configured for hostMode=network or a
# non-default port keeps that endpoint across installer upgrades. The in-app
# install-service writes the same shape (buildManagedDaemonServiceManager),
# so both paths produce the identical running daemon — pinning endpoint
# constants here is what silently re-pinned custom-configured hosts back to
# loopback:3421 behind a success receipt. Only --daemon-home is baked: it names
# where the settings live, not what they say.

# Verify settle used by the supervised transfer: seconds between the two
# post-start probes (a Type=simple unit reports 'active' from fork onward, so a
# single instant is-active proves nothing). Overridable so tests run fast.
VERIFY_SETTLE_SECS="${GOODVIBES_INSTALL_VERIFY_SETTLE_SECS:-1}"

say() { printf '%s\n' "$*"; }
fail() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

# Paths depend on $HOME; recomputed via functions so an overridden HOME (tests)
# is always honored.
systemd_daemon_unit_path() { printf '%s' "$HOME/.config/systemd/user/$SYSTEMD_DAEMON_UNIT"; }
launchd_daemon_plist_path() { printf '%s' "$HOME/Library/LaunchAgents/$LAUNCHD_DAEMON_LABEL.plist"; }
# Generic form of the above for any systemd user unit name (daemon or agent) —
# used by the restart path to find and back up a broken unit file on disk.
systemd_unit_path() { printf '%s' "$HOME/.config/systemd/user/$1"; }

# First line of `systemctl --version` is "systemd NNN (...)"; prints NNN, or
# nothing when systemctl is absent or the output is unrecognized.
detect_systemd_major_version() {
  systemctl --version 2>/dev/null | sed -n '1s/^systemd \([0-9][0-9]*\).*/\1/p'
}

# RestartSteps=/RestartMaxDelaySec= (escalating restart delays) landed in
# systemd 254. On older systemd — or when the version cannot be read — the
# unit degrades to the flat RestartSec retry, which StartLimitIntervalSec=0
# already keeps retrying forever instead of tombstoning.
systemd_supports_restart_steps() {
  _sysd_major="$1"
  [ -n "$_sysd_major" ] && [ "$_sysd_major" -ge 254 ] 2>/dev/null
}

# Whether lingering is enabled for the current user — the readback that makes
# "starts at boot" an observed fact rather than a hope. `loginctl enable-linger`
# can exit 0 without taking effect in some polkit setups, so the show-user
# property is the source of truth, checked before and after enabling.
linger_enabled() {
  loginctl show-user "$(id -un)" --property=Linger 2>/dev/null | grep -q '^Linger=yes'
}

# A user unit with WantedBy=default.target only starts when its user logs in.
# Lingering starts the user's systemd instance at boot, so the daemon comes up
# on a machine nobody has logged into (the always-on-box case). Returns 0 only
# when lingering is VERIFIED on; on any failure it prints exactly one honest
# instruction naming the command to run once, and returns 1 so the caller's
# closing copy says "on login" instead of "at boot".
ensure_linger() {
  if ! command -v loginctl >/dev/null 2>&1; then
    say "  NOTE: loginctl not found — could not enable lingering, so the daemon starts"
    say "  at login rather than at boot. Enable it once yourself with:"
    say "    loginctl enable-linger $(id -un)"
    return 1
  fi
  if linger_enabled; then
    say "  lingering  already enabled for $(id -un)"
    return 0
  fi
  loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
  if linger_enabled; then
    say "  lingering  enabled for $(id -un)"
    return 0
  fi
  say "  NOTE: could not enable lingering (polkit may require an interactive session),"
  say "  so the daemon starts at login rather than at boot. Enable it once yourself with:"
  say "    loginctl enable-linger $(id -un)"
  return 1
}

# --- PATH line (installer-managed, same marker discipline as service units) ---
#
# "Start with: goodvibes" must not be a false promise. When
# $INSTALL_DIR is not on PATH, the installer used to print a session-local
# `export PATH=...` line the user had to copy-paste themselves — and still
# ended with "Start with: goodvibes" regardless, which was false on a fresh
# shell. Instead the installer now writes an idempotent, marker-tagged PATH
# line into the user's actual shell rc itself (uninstall removes it, same as
# it does for service units), and the final line states a command that works
# RIGHT NOW in the current shell (the absolute path), never a promise that
# depends on a shell restart the user hasn't done yet.

# Resolve the rc file for the user's actual login shell ($SHELL — set by the
# environment regardless of this script's own #!/bin/sh execution), not a
# guess. Falls back to .profile for anything unrecognized.
resolve_shell_rc() {
  case "${SHELL:-}" in
    */zsh) printf '%s' "$HOME/.zshrc" ;;
    */fish) printf '%s' "$HOME/.config/fish/config.fish" ;;
    */bash)
      # bash reads .bashrc for the interactive non-login shells most
      # terminal emulators start; fall back to .bash_profile only when that
      # already exists and .bashrc does not.
      if [ -f "$HOME/.bashrc" ] || [ ! -f "$HOME/.bash_profile" ]; then
        printf '%s' "$HOME/.bashrc"
      else
        printf '%s' "$HOME/.bash_profile"
      fi
      ;;
    *) printf '%s' "$HOME/.profile" ;;
  esac
}

# The PATH-export line itself, in the syntax the target shell understands.
path_export_line() {
  case "${SHELL:-}" in
    */fish) printf 'set -gx PATH %s $PATH' "$INSTALL_DIR" ;;
    *) printf 'export PATH="%s:$PATH"' "$INSTALL_DIR" ;;
  esac
}

# Set by ensure_path_on_shell_rc() so main() can print an honest final line.
PATH_LINE_ADDED=0
RC_FILE_USED=""

# Idempotent: does nothing if $INSTALL_DIR is already on PATH, or if a prior
# run already added the marker-tagged line (this shell just hasn't re-sourced
# its rc file yet). Otherwise appends the marker comment + export line.
ensure_path_on_shell_rc() {
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) return 0 ;;
  esac
  rc_file=$(resolve_shell_rc)
  if [ -f "$rc_file" ] && grep -qF "$INSTALLER_MARKER" "$rc_file" 2>/dev/null; then
    return 0
  fi
  mkdir -p "$(dirname "$rc_file")" 2>/dev/null || true
  printf '\n# %s\n%s\n' "$INSTALLER_MARKER" "$(path_export_line)" >> "$rc_file"
  PATH_LINE_ADDED=1
  RC_FILE_USED="$rc_file"
  say ""
  say "Added $INSTALL_DIR to PATH in $rc_file (installer-managed; uninstall removes it)."
}

# Uninstall-side removal of the PATH line: only the marker comment line and
# the one export/set line immediately after it — the exact two lines
# ensure_path_on_shell_rc() appended — never anything else in the file.
uninstall_shell_rc_path_line() {
  rc_file=$(resolve_shell_rc)
  [ -f "$rc_file" ] || return 0
  grep -qF "$INSTALLER_MARKER" "$rc_file" 2>/dev/null || return 0
  tmp_file="$rc_file.goodvibes-uninstall-tmp"
  awk -v marker="$INSTALLER_MARKER" '
    index($0, marker) > 0 { skip = 1; next }
    skip > 0 { skip--; next }
    { print }
  ' "$rc_file" > "$tmp_file" && mv "$tmp_file" "$rc_file"
  say "  removed    PATH line from $rc_file"
  record_removed "PATH line in $rc_file (installer-managed)"
}

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
  # The sqlite-vec addon uses the Node-style platform tag (linux|darwin) and the
  # shared-library suffix the SDK's loader resolves — distinct from the release
  # binaries' os_tag (linux|macos).
  case "$os_tag" in
    linux) VEC_OS="linux"; VEC_SUFFIX="so" ;;
    macos) VEC_OS="darwin"; VEC_SUFFIX="dylib" ;;
  esac
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
#
# A unit or bare process is only a valid restart target when it can actually
# run the new binary. Before restarting a unit, its ExecStart binary is
# resolved and checked; before relaunching a bare process, its real
# executable (/proc/<pid>/exe) must live under $INSTALL_DIR. Either check
# failing means the old install is treated as gone, not restarted — this is
# exactly the case left behind by `bun remove -g @pellux/goodvibes-tui
# @pellux/goodvibes-agent`, which deletes the binaries but can leave the
# bun-era systemd user unit, and even its still-running process, behind.
# Falling through in that case lets first-run service setup below bring up a
# working daemon instead of silently doing nothing.

# proc_belongs_to_install_dir <pid> — true only when the process's executable
# lives under $INSTALL_DIR, so acting on one install never touches a
# daemon/agent launched from a different install dir (bun's global bin dir,
# a different $GOODVIBES_INSTALL_DIR elsewhere on the host, etc.). Shared by
# the restart path (skip relaunching a foreign process) and uninstall (only
# stop processes this install actually owns).
proc_belongs_to_install_dir() {
  _pid="$1"
  if [ -r "/proc/$_pid/exe" ]; then
    _exe=$(readlink -f "/proc/$_pid/exe" 2>/dev/null || true)
  else
    _exe=$(ps -o args= -p "$_pid" 2>/dev/null | sed 's/ .*$//')
  fi
  case "$_exe" in
    "$INSTALL_DIR"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Extract the ExecStart binary path systemd reports for a unit, out of the
# structured `{ path=... ; argv[]=... ; ... }` that
# `systemctl show -p ExecStart --value` prints. Empty when it cannot be
# determined (missing unit, no systemd, unrecognized format) — callers must
# treat that as "unknown", never as "broken".
systemd_unit_exec_binary() {
  _raw=$(systemctl --user show -p ExecStart --value "$1" 2>/dev/null || true)
  printf '%s' "$_raw" | sed -n 's/.*path=\([^ ;]*\).*/\1/p' | head -1
}

# The MainPID systemd reports for a user unit, or nothing when unknown.
systemd_unit_main_pid() {
  _mp=$(systemctl --user show -p MainPID --value "$1" 2>/dev/null || true)
  case "$_mp" in
    ''|0) : ;;
    *[!0-9]*) : ;;
    *) printf '%s' "$_mp" ;;
  esac
}

# Tri-state activity of a systemd user unit — prints one of:
#   active    is-active exited 0
#   inactive  is-active exited 3 AND printed a recognized final state
#   unknown   anything else: no systemctl, bus unreachable (exit 1), timeout,
#             unparseable output
# The distinction is load-bearing: 'cannot ask systemd' must never be read as
# 'nothing is running'. Every destructive/demoting decision below requires an
# AFFIRMATIVE answer; unknown always refuses.
unit_active_state() {
  if ! command -v systemctl >/dev/null 2>&1; then
    printf 'unknown'
    return 0
  fi
  # The assignment is an AND-OR list so a non-zero is-active (expected!) never
  # trips `set -e`.
  _rc=0
  _out=$(systemctl --user is-active "$1" 2>/dev/null) || _rc=$?
  if [ "$_rc" -eq 0 ]; then
    printf 'active'
    return 0
  fi
  # LSB exit 4 = "no such unit": modern systemd (verified on this repo's own
  # deployment host, systemd 260: prints 'inactive', rc 4) answers it for any
  # unit with NO unit file. That is an AFFIRMATIVE answer — nothing exists to
  # be running — and must never be read as "cannot ask systemd": mapping it to
  # unknown made every fail-safe branch refuse the primary upgrade path on
  # modern systemd. Old systemd answers rc 3 'inactive' for missing units,
  # which the inactive case below already covers.
  if [ "$_rc" -eq 4 ]; then
    printf 'absent'
    return 0
  fi
  if [ "$_rc" -eq 3 ]; then
    case "$_out" in
      inactive|failed|dead) printf 'inactive'; return 0 ;;
      # Transitional states: the unit exists and has (or is acquiring/releasing)
      # processes — treat as active so nothing destructive happens around it,
      # and never as a false "service manager unreachable".
      activating|deactivating|reloading|refreshing) printf 'active'; return 0 ;;
    esac
  fi
  printf 'unknown'
}

# True only when a unit is AFFIRMATIVELY serving: reports active AND its
# MainPID resolves to a live process. A Type=simple unit reports 'active' from
# fork onward — including the pre-bind window of a crash-looping daemon — so
# bare is-active is never used to justify retiring another unit.
unit_serving() {
  [ "$(unit_active_state "$1")" = "active" ] || return 1
  _sp=$(systemd_unit_main_pid "$1")
  [ -n "$_sp" ] || return 1
  kill -0 "$_sp" 2>/dev/null
}

# Tri-state supervision of a PID — prints one of:
#   supervised  a service manager owns this process (systemd .service unit, or
#               one of our launchd labels reports it)
#   free        affirmatively NOT service-managed (systemd resolves it to a
#               session/app scope, or no unit at all)
#   unknown     supervision cannot be determined (no manager reachable)
# Uses `systemctl status <pid>` (unit lookup by pid — covers ANY unit name, not
# a hardcoded list) in the user scope, then the system scope. The bare-process
# kill/relaunch fallback runs ONLY on 'free': SIGTERM + nohup on a supervised
# process demotes it to an unsupervised one with its still-enabled unit left
# behind — the exact two-daemon state at the next login this installer exists
# to prevent. Unknown is treated exactly like supervised.
pid_supervision() {
  _q="$1"
  if [ "$os_tag" = "macos" ]; then
    if command -v launchctl >/dev/null 2>&1; then
      for _label in "$LAUNCHD_DAEMON_LABEL" sh.goodvibes.agent; do
        if launchctl print "gui/$(id -u)/$_label" 2>/dev/null | grep -q "pid = $_q"; then
          printf 'supervised'
          return 0
        fi
      done
      # Our labels do not own it. launchd supervision under a foreign label is
      # not cheaply enumerable; the practical supervision surface for the
      # goodvibes binaries is our own labels.
      printf 'free'
      return 0
    fi
    printf 'unknown'
    return 0
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    printf 'unknown'
    return 0
  fi
  _rc=0
  _out=$(systemctl --user status "$_q" 2>/dev/null) || _rc=$?
  if [ "$_rc" -eq 0 ] || [ "$_rc" -eq 3 ]; then
    if printf '%s\n' "$_out" | head -1 | grep -q '\.service'; then
      printf 'supervised'
    else
      printf 'free'
    fi
    return 0
  fi
  if [ "$_rc" -eq 4 ]; then
    # The user manager does not know the pid — it may belong to a SYSTEM unit.
    _rc=0
    _out=$(systemctl status "$_q" 2>/dev/null) || _rc=$?
    if [ "$_rc" -eq 0 ] || [ "$_rc" -eq 3 ]; then
      if printf '%s\n' "$_out" | head -1 | grep -q '\.service'; then
        printf 'supervised'
      else
        printf 'free'
      fi
      return 0
    fi
    if [ "$_rc" -eq 4 ]; then
      printf 'free'
      return 0
    fi
  fi
  printf 'unknown'
}

# Tri-state enablement of a systemd user unit — prints yes | no | unknown.
# Used by the transfer rollback so it can RESTORE the pre-run enablement state
# instead of blanket-disabling a unit the user had enabled before this run.
unit_enabled_state() {
  command -v systemctl >/dev/null 2>&1 || { printf 'unknown'; return 0; }
  _erc=0
  _eout=$(systemctl --user is-enabled "$1" 2>/dev/null) || _erc=$?
  [ "$_erc" -eq 0 ] && { printf 'yes'; return 0; }
  case "$_eout" in
    disabled|not-found|masked|static) printf 'no'; return 0 ;;
  esac
  printf 'unknown'
}

# Whether the legacy unit file is installer-marker-managed. Prints one of:
# managed | hand-written | unreadable | absent.
legacy_unit_provenance() {
  _lp=$(systemd_unit_path "$LEGACY_SYSTEMD_DAEMON_UNIT")
  [ -f "$_lp" ] || { printf 'absent'; return 0; }
  [ -r "$_lp" ] || { printf 'unreadable'; return 0; }
  if grep -q "$INSTALLER_MARKER" "$_lp" 2>/dev/null; then
    printf 'managed'
  else
    printf 'hand-written'
  fi
}

# The exact Description the product's own unit writer emits (see
# MANAGED_SERVICE_DESCRIPTION in src/runtime/legacy-daemon-migration.ts) — the
# fingerprint that identifies a unit written by the in-app install-service /
# onboarding, which carry no installer marker but are just as platform-owned
# (the product overwrites its own units freely whenever install-service runs).
PRODUCT_UNIT_FINGERPRINT='GoodVibes daemon (shared session broker + companion host)'

# Provenance of a CANONICAL unit/plist file:
# managed (installer marker OR the product writer's fingerprint) |
# hand-written | unreadable | absent.
canonical_unit_provenance() {
  _cp="$1"
  [ -f "$_cp" ] || { printf 'absent'; return 0; }
  [ -r "$_cp" ] || { printf 'unreadable'; return 0; }
  if grep -q "$INSTALLER_MARKER" "$_cp" 2>/dev/null ||
     grep -q "$PRODUCT_UNIT_FINGERPRINT" "$_cp" 2>/dev/null; then
    printf 'managed'
  else
    printf 'hand-written'
  fi
}

# True when a unit/plist file bakes the endpoint flags this generation no
# longer uses. Released v1.14.0-v1.18.0 in-app installs (and one unreleased
# installer generation) pinned '--hostname <host> --port <port>' into the
# launch, snapshotting config-at-install-time — those pins override the
# controlPlane settings on every boot until the file is re-derived.
unit_is_endpoint_pinned() {
  grep -qe '--hostname' -e '--port' "$1" 2>/dev/null
}

# Upgrade-time content currency for the CANONICAL unit (Linux): a
# platform-managed unit still carrying pinned endpoint flags is regenerated to
# the config-derived shape (file + daemon-reload only — the ordinary restart
# path right after this applies it to a running daemon). A hand-written unit
# is never rewritten: honest notice only. Runs BEFORE restart_running_daemon
# so the restart picks up the new content in the same run.
refresh_pinned_canonical_unit() {
  [ "$os_tag" = "linux" ] || return 0
  _rp=$(systemd_daemon_unit_path)
  [ -f "$_rp" ] || return 0
  unit_is_endpoint_pinned "$_rp" || return 0
  case "$(canonical_unit_provenance "$_rp")" in
    managed)
      say ""
      say "Regenerating $SYSTEMD_DAEMON_UNIT: it pins endpoint flags (--hostname/--port) from an older release,"
      say "  which override the controlPlane settings on every boot. The daemon now resolves its endpoint from"
      say "  settings at startup."
      write_systemd_unit "$_rp"
      command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload 2>/dev/null || true
      say "  rewrote    $_rp (config-derived launch)"
      if [ "$RESTART_DAEMON" != "1" ]; then
        say "  NOTE: GOODVIBES_RESTART_DAEMON=0 — the running daemon keeps the old pinned endpoint until restarted."
      fi
      ;;
    hand-written)
      say ""
      say "NOTE: $SYSTEMD_DAEMON_UNIT at $_rp pins endpoint flags (--hostname/--port), which override the"
      say "  controlPlane settings — and the unit is not recognizably platform-managed, so it was left untouched."
      say "  Remove those flags yourself so the daemon follows your settings."
      ;;
  esac
}

restart_systemd_unit() {
  # restart_systemd_unit <unit> <expected-binary> — returns 0 if it handled a
  # running unit (restarted, replaced, or reported), 1 if no active unit
  # exists, or its unit was just replaced because it could no longer run —
  # either way the caller should fall through to bare-process handling and
  # then first-run service setup.
  unit="$1"
  expected_bin="$2"
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user is-active --quiet "$unit" 2>/dev/null || return 1

  # A unit whose ExecStart binary no longer exists cannot be brought back by
  # restarting it — that only "restarts" a corpse. Stop it, back up its unit
  # file (never silently destroyed), and let the caller fall through so
  # first-run setup replaces it with a working, installer-managed unit. A
  # unit whose ExecStart is a DIFFERENT but still-existing binary (a
  # genuinely hand-written working unit) is untouched by this check — it
  # keeps the ordinary restart-and-note-the-mismatch behavior below.
  exec_bin=$(systemd_unit_exec_binary "$unit")
  if [ -n "$exec_bin" ] && [ ! -x "$exec_bin" ]; then
    say ""
    say "${unit} points at $exec_bin, which no longer exists — replacing it."
    systemctl --user disable --now "$unit" 2>/dev/null ||
      systemctl --user stop "$unit" 2>/dev/null || true
    unit_path=$(systemd_unit_path "$unit")
    if [ -f "$unit_path" ]; then
      backup="$unit_path.bak.$(date +%Y%m%d%H%M%S)"
      mv -f "$unit_path" "$backup"
      say "  moved      $unit_path -> $backup"
    fi
    systemctl --user daemon-reload 2>/dev/null || true
    return 1
  fi

  say ""
  say "Restarting the running ${unit%.service} (systemd user service) ..."
  if systemctl --user restart "$unit" 2>/dev/null; then
    say "  restarted  $unit"
    case "$exec_bin" in
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
    # A service-managed process is NEVER killed/relaunched here: its unit owns
    # the restart, and a SIGTERM + nohup relaunch would demote it to an
    # unsupervised process with its enabled unit left behind. When supervision
    # CANNOT be determined (no reachable service manager), the process is
    # treated as supervised — 'cannot ask' is never read as 'safe to kill'.
    _supervision=$(pid_supervision "$pid")
    if [ "$_supervision" = "supervised" ]; then
      say ""
      say "Skipping pid $pid — it is supervised by a service manager; its unit owns the restart."
      continue
    fi
    if [ "$_supervision" = "unknown" ]; then
      say ""
      say "Skipping pid $pid — cannot determine whether it is service-managed (service manager unreachable)."
      say "  Nothing was touched. Restart it yourself after the upgrade if needed."
      continue
    fi
    if ! proc_belongs_to_install_dir "$pid"; then
      # Its real executable is gone or lives outside $INSTALL_DIR — a
      # leftover from a different install. Recovering its argv and
      # relaunching would either restart a binary that no longer exists, or
      # (worse) mangle a foreign process's arguments: the argv[0]-stripping
      # below assumes argv[0] IS the daemon binary, which is not true for a
      # process launched through another runtime (e.g. bun). Stop it and let
      # first-run setup (or a manual start) bring up the new binary instead.
      say ""
      say "Stopping ${new_bin##*/} (pid $pid) — its executable is gone or is not $new_bin; not relaunching it."
      kill "$pid" 2>/dev/null || continue
      waited=0
      while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 10 ]; do
        sleep 1
        waited=$((waited + 1))
      done
      if kill -0 "$pid" 2>/dev/null; then
        say "  NOTE: pid $pid did not exit within 10s — stop it yourself: kill $pid"
      else
        say "  stopped    pid $pid (start the new binary yourself, or let first-run setup do it: $new_bin)"
      fi
      continue
    fi
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

# Restart a loaded launchd agent in place (`kickstart -k`), so a binary swap
# takes effect WITHOUT SIGTERM + nohup demoting a launchd-supervised process
# to an unsupervised one that then fights the KeepAlive respawn for the port.
# Returns 0 when it handled a loaded agent, 1 when the label is not loaded
# (caller falls through to the guarded bare-process path).
restart_launchd_agent() {
  _label="$1"
  command -v launchctl >/dev/null 2>&1 || return 1
  launchctl print "gui/$(id -u)/$_label" >/dev/null 2>&1 || return 1
  say ""
  say "Restarting the running $_label (launchd user agent) ..."
  if launchctl kickstart -k "gui/$(id -u)/$_label" 2>/dev/null; then
    say "  restarted  $_label"
  else
    say "  NOTE: restart failed — restart it yourself with:"
    say "    launchctl kickstart -k gui/$(id -u)/$_label"
  fi
  return 0
}

restart_running_daemon() {
  [ "$RESTART_DAEMON" = "1" ] || return 0
  if [ "$os_tag" = "macos" ]; then
    restart_launchd_agent "$LAUNCHD_DAEMON_LABEL" && return 0
    restart_bare_processes '[g]oodvibes-daemon' "$INSTALL_DIR/goodvibes-daemon"
    return 0
  fi
  restart_systemd_unit "$SYSTEMD_DAEMON_UNIT" "$INSTALL_DIR/goodvibes-daemon" && return 0
  case "$(unit_active_state "$LEGACY_SYSTEMD_DAEMON_UNIT")" in
    active)
      # The daemon is supervised by the LEGACY goodvibes-daemon.service unit.
      # Never fall through to the bare-process kill/nohup path (that would
      # SIGTERM a supervised daemon and relaunch it outside systemd). What
      # happens next depends on the unit's provenance — the printed line must
      # only promise what a later step actually does:
      #   managed      the migration step transfers supervision to the
      #                canonical unit (write/stop/start/verify/retire).
      #   hand-written the migration step never touches it, so restart the
      #                unit HERE (non-destructive `systemctl --user restart`)
      #                so the swapped binary actually starts serving.
      case "$(legacy_unit_provenance)" in
        managed)
          say ""
          say "The daemon is running under the installer-managed $LEGACY_SYSTEMD_DAEMON_UNIT unit — the migration step below transfers it to $SYSTEMD_DAEMON_UNIT."
          ;;
        *)
          # Hand-written or unreadable: this tool won't modify the unit, but
          # the upgrade must still take effect — restart it in place.
          restart_systemd_unit "$LEGACY_SYSTEMD_DAEMON_UNIT" "$INSTALL_DIR/goodvibes-daemon" || {
            say ""
            say "NOTE: could not restart $LEGACY_SYSTEMD_DAEMON_UNIT — restart it yourself so the upgraded binary takes effect:"
            say "    systemctl --user restart $LEGACY_SYSTEMD_DAEMON_UNIT"
          }
          ;;
      esac
      return 0
      ;;
    unknown)
      # Cannot ask systemd (no user bus in this session?). Touching processes
      # on a guess replays the demotion incident — refuse, and say how to
      # finish the restart by hand.
      say ""
      say "NOTE: cannot determine the daemon service state (user service manager unreachable from this session)."
      say "  No process was touched. After the upgrade, restart the service yourself from a logged-in session:"
      say "    systemctl --user restart $SYSTEMD_DAEMON_UNIT   (or $LEGACY_SYSTEMD_DAEMON_UNIT if that is the unit in use)"
      return 0
      ;;
  esac
  restart_bare_processes '[g]oodvibes-daemon' "$INSTALL_DIR/goodvibes-daemon"
}

restart_running_agent() {
  [ "$RESTART_DAEMON" = "1" ] || return 0
  if [ "$os_tag" = "macos" ]; then
    restart_launchd_agent sh.goodvibes.agent && return 0
    restart_bare_processes '[g]oodvibes-agent' "$INSTALL_DIR/goodvibes-agent"
    return 0
  fi
  restart_systemd_unit goodvibes-agent.service "$INSTALL_DIR/goodvibes-agent" && return 0
  restart_bare_processes '[g]oodvibes-agent' "$INSTALL_DIR/goodvibes-agent"
}

# --- daemon liveness detection (shared by first-run setup and uninstall) ---
# A systemd user unit reported active, OR a bare goodvibes-daemon process.

daemon_systemd_active() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user is-active --quiet "$SYSTEMD_DAEMON_UNIT" 2>/dev/null
}

daemon_bare_process_running() {
  pgrep -f '[g]oodvibes-daemon' >/dev/null 2>&1
}

daemon_running() {
  daemon_systemd_active && return 0
  daemon_bare_process_running
}

# --- first-run daemon service setup ---
# A brand-new install gets binaries but nothing running. When no daemon is
# running AND no service unit exists yet, register the daemon as a user service
# so it comes up now and on every login. Never overwrites an existing unit
# (installer-managed or hand-written) — the upgrade-restart path owns an
# already-running service. Every outcome is stated plainly; success is never
# faked.

write_systemd_unit() {
  # write_systemd_unit <path> [systemd-major-version] — writes the
  # installer-managed unit text only, no activation. Split out so tests can
  # validate the generated text without touching the host's systemd; the
  # optional version argument lets tests pin the systemd feature level instead
  # of inheriting whatever the host runs.
  #
  # Restart posture: StartLimitIntervalSec=0 disables the start-rate limiter,
  # so a crashing daemon keeps retrying (spaced by the delays below) instead
  # of landing in the permanent "start-limit-hit" failed state that only a
  # manual reset-failed clears. On systemd >= 254 the retry delay escalates
  # from RestartSec up to RestartMaxDelaySec across RestartSteps attempts; on
  # older systemd those two directives are omitted (they would be ignored with
  # a warning) and the flat RestartSec applies to every retry.
  _unit_path="$1"
  _sysd_version="${2:-$(detect_systemd_major_version)}"
  _restart_escalation=""
  if systemd_supports_restart_steps "$_sysd_version"; then
    _restart_escalation="
RestartSteps=8
RestartMaxDelaySec=300"
  fi
  mkdir -p "$(dirname "$_unit_path")"
  cat > "$_unit_path" <<EOF
# $INSTALLER_MARKER
# The uninstall path (GOODVIBES_UNINSTALL=1) keys on the marker line above to
# know this unit is installer-managed and safe to remove. Delete that line and
# the installer treats this unit as hand-written and never touches it.
[Unit]
Description=GoodVibes daemon (shared session broker + companion host)
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart="$INSTALL_DIR/goodvibes-daemon" --daemon-home "$HOME"
Restart=on-failure
RestartSec=2$_restart_escalation

[Install]
WantedBy=default.target
EOF
}

write_launchd_plist() {
  # write_launchd_plist <path> — writes the installer-managed LaunchAgent text
  # only, no activation. The GoodVibesManagedBy key and the XML comment both
  # carry the marker string the uninstall path greps for.
  _plist_path="$1"
  mkdir -p "$(dirname "$_plist_path")"
  cat > "$_plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!-- $INSTALLER_MARKER -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LAUNCHD_DAEMON_LABEL</string>
  <key>GoodVibesManagedBy</key>
  <string>$INSTALLER_MARKER</string>
  <key>ProgramArguments</key>
  <array>
    <string>$INSTALL_DIR/goodvibes-daemon</string>
    <string>--daemon-home</string>
    <string>$HOME</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
</dict>
</plist>
EOF
}

setup_daemon_service_systemd() {
  unit_path=$(systemd_daemon_unit_path)
  if [ -f "$unit_path" ]; then
    say "A ${SYSTEMD_DAEMON_UNIT} unit already exists at $unit_path — leaving it as is."
    say "  Start it yourself if it is not running:"
    say "    systemctl --user start $SYSTEMD_DAEMON_UNIT"
    return 0
  fi

  say "Setting up the goodvibes daemon as a systemd user service ..."
  write_systemd_unit "$unit_path"
  say "  wrote      $unit_path"

  if ! systemctl --user daemon-reload 2>/dev/null; then
    say "  NOTE: 'systemctl --user daemon-reload' failed — a user systemd instance"
    say "  may not be running for this session. Enable it yourself later with:"
    say "    systemctl --user enable --now $SYSTEMD_DAEMON_UNIT"
    return 0
  fi

  if systemctl --user enable --now "$SYSTEMD_DAEMON_UNIT" 2>/dev/null; then
    # Lingering decides whether "enabled" means boot or merely login, so the
    # closing line below states whichever one was actually verified.
    if ensure_linger; then
      _daemon_starts="at boot"
    else
      _daemon_starts="on login"
    fi
    if systemctl --user is-active --quiet "$SYSTEMD_DAEMON_UNIT" 2>/dev/null; then
      say "  started    $SYSTEMD_DAEMON_UNIT (active)"
      say "  The daemon starts $_daemon_starts and restarts on failure."
    else
      say "  NOTE: enabled $SYSTEMD_DAEMON_UNIT but it is not active yet. Inspect it with:"
      say "    systemctl --user status $SYSTEMD_DAEMON_UNIT"
    fi
  else
    say "  NOTE: 'systemctl --user enable --now $SYSTEMD_DAEMON_UNIT' failed. Enable it yourself with:"
    say "    systemctl --user enable --now $SYSTEMD_DAEMON_UNIT"
  fi
}

setup_daemon_service_launchd() {
  plist_path=$(launchd_daemon_plist_path)
  if [ -f "$plist_path" ]; then
    say "A LaunchAgent already exists at $plist_path — leaving it as is."
    say "  Load it yourself if it is not running:"
    say "    launchctl bootstrap gui/$(id -u) $plist_path"
    return 0
  fi

  say "Setting up the goodvibes daemon as a launchd user agent ..."
  write_launchd_plist "$plist_path"
  say "  wrote      $plist_path"

  uid=$(id -u)
  # Prefer the modern bootstrap; fall back to legacy load on older macOS.
  if launchctl bootstrap "gui/$uid" "$plist_path" 2>/dev/null ||
     launchctl load "$plist_path" 2>/dev/null; then
    if launchctl print "gui/$uid/$LAUNCHD_DAEMON_LABEL" >/dev/null 2>&1 ||
       launchctl list "$LAUNCHD_DAEMON_LABEL" >/dev/null 2>&1; then
      say "  started    $LAUNCHD_DAEMON_LABEL (loaded)"
      say "  The daemon starts on login and restarts on failure."
    else
      say "  NOTE: loaded the agent but could not confirm it is running. Inspect it with:"
      say "    launchctl print gui/$uid/$LAUNCHD_DAEMON_LABEL"
    fi
  else
    say "  NOTE: could not load the LaunchAgent automatically. Load it yourself with:"
    say "    launchctl bootstrap gui/$uid $plist_path"
  fi
}

setup_daemon_service() {
  if [ "$DAEMON_SERVICE" != "1" ]; then
    say ""
    say "Daemon service setup skipped (GOODVIBES_DAEMON_SERVICE=0). Run it yourself with:"
    say "  $INSTALL_DIR/goodvibes-daemon"
    return 0
  fi

  # New-user only: if a daemon is already running, the upgrade-restart path
  # (restart_running_daemon) already handled it — do not also set up a service.
  daemon_running && return 0

  say ""
  case "$os_tag" in
    linux)
      if command -v systemctl >/dev/null 2>&1; then
        setup_daemon_service_systemd
        return 0
      fi
      ;;
    macos)
      if command -v launchctl >/dev/null 2>&1; then
        setup_daemon_service_launchd
        return 0
      fi
      ;;
  esac

  # No supported user service manager available (or the tool is missing).
  say "No user service manager (systemd/launchd) is available to run the daemon"
  say "automatically. Start it yourself with:"
  say "  $INSTALL_DIR/goodvibes-daemon"
}

# --- upgrade path: retire the legacy `goodvibes-daemon.service` unit name ---
# The prior installer created the daemon unit as `goodvibes-daemon.service`
# with a bare `ExecStart=<bin>` (no args). This installer now unifies on
# `goodvibes.service` (the same name the in-app install-service manages).
# The migration handles every upgrade state honestly:
#   - legacy ACTIVE and canonical not: supervised transfer — write the
#     canonical unit, stop legacy, start canonical, VERIFY it is active, and
#     only then retire the legacy unit. A canonical unit that fails to come up
#     rolls back (legacy restarted, nothing removed).
#   - canonical VERIFIED ACTIVE: the legacy unit is redundant — disable+remove
#     it (checking every exit status; the unit file is only removed after a
#     SUCCESSFUL disable, so a busless run never leaves a dangling enablement
#     symlink behind a false "disabled + removed" receipt).
#   - neither active: retire the inactive legacy unit only when a canonical
#     unit file exists, and state the canonical unit's real (inactive) state.
# Marker-gated throughout: a hand-written goodvibes-daemon.service is never
# touched, and an UNREADABLE unit file is reported as unreadable, never
# misdiagnosed as hand-written. GOODVIBES_RESTART_DAEMON=0 documents "leave
# running daemon untouched" — with it set, an ACTIVE legacy unit is never
# stopped (a notice explains how to migrate later).
migrate_legacy_installer_unit() {
  case "$os_tag" in
    linux) migrate_legacy_systemd_unit ;;
    macos) migrate_legacy_launchd_plist ;;
  esac
}

migrate_legacy_systemd_unit() {
  legacy_path=$(systemd_unit_path "$LEGACY_SYSTEMD_DAEMON_UNIT")
  [ -f "$legacy_path" ] || return 0

  case "$(legacy_unit_provenance)" in
    unreadable)
      say ""
      say "NOTE: a $LEGACY_SYSTEMD_DAEMON_UNIT unit exists at $legacy_path but could not be read"
      say "  (permissions?) — leaving it untouched. Inspect it yourself; if it is redundant:"
      say "    systemctl --user disable --now $LEGACY_SYSTEMD_DAEMON_UNIT && rm $legacy_path && systemctl --user daemon-reload"
      return 0
      ;;
    hand-written)
      # Hand-written legacy unit: never touched, only reported.
      say ""
      say "A hand-written $LEGACY_SYSTEMD_DAEMON_UNIT (no installer marker) exists at $legacy_path."
      say "  This installer now manages $SYSTEMD_DAEMON_UNIT instead; your unit is left in place."
      say "  If it is redundant, retire it yourself:"
      say "    systemctl --user disable --now $LEGACY_SYSTEMD_DAEMON_UNIT && rm $legacy_path && systemctl --user daemon-reload"
      return 0
      ;;
  esac

  if ! command -v systemctl >/dev/null 2>&1; then
    say ""
    say "NOTE: found the installer-managed $LEGACY_SYSTEMD_DAEMON_UNIT at $legacy_path but systemctl is not"
    say "  available — nothing was changed. Retire it yourself once systemd is reachable:"
    say "    systemctl --user disable --now $LEGACY_SYSTEMD_DAEMON_UNIT && rm $legacy_path && systemctl --user daemon-reload"
    return 0
  fi

  legacy_state=$(unit_active_state "$LEGACY_SYSTEMD_DAEMON_UNIT")
  canonical_state=$(unit_active_state "$SYSTEMD_DAEMON_UNIT")
  canonical_path=$(systemd_daemon_unit_path)

  # FAIL-SAFE ON UNKNOWN: if either unit's state cannot be read (no user bus
  # in this session, timeout), every branch below would be acting on a guess —
  # a stop/disable could take down the only running daemon. Refuse.
  if [ "$legacy_state" = "unknown" ] || [ "$canonical_state" = "unknown" ]; then
    say ""
    say "NOTE: cannot determine the daemon units' state (user service manager unreachable from this"
    say "  session?) — nothing was changed. Re-run the installer from a logged-in session, or migrate"
    say "  deliberately with: goodvibes-daemon migrate-service"
    return 0
  fi

  # GOODVIBES_RESTART_DAEMON=0 means "leave running daemon/agent untouched" —
  # that contract covers the migration's stop/disable of an ACTIVE unit too.
  if [ "$legacy_state" = "active" ] && [ "$RESTART_DAEMON" != "1" ]; then
    say ""
    say "NOTE: $LEGACY_SYSTEMD_DAEMON_UNIT is running and GOODVIBES_RESTART_DAEMON=0 — leaving it untouched."
    say "  Re-run the installer without GOODVIBES_RESTART_DAEMON=0 to migrate it to $SYSTEMD_DAEMON_UNIT."
    return 0
  fi

  if [ "$canonical_state" = "active" ] && unit_serving "$SYSTEMD_DAEMON_UNIT"; then
    if [ "$legacy_state" = "active" ]; then
      # BOTH units are running their own daemon (a port fight, or the legacy
      # daemon serving a configured endpoint the canonical one does not).
      # Stopping either automatically could take down the endpoint clients
      # actually use — refuse, and point at the consented migration.
      say ""
      say "NOTE: both $SYSTEMD_DAEMON_UNIT and $LEGACY_SYSTEMD_DAEMON_UNIT are currently running."
      say "  Stopping either one automatically could take down the endpoint your clients use, so"
      say "  nothing was changed. Migrate deliberately with: goodvibes-daemon migrate-service"
      return 0
    fi
    # The canonical unit is serving (active with a live main process) and the
    # legacy unit is NOT running: the legacy unit is redundant.
    say ""
    say "Retiring the redundant installer-managed $LEGACY_SYSTEMD_DAEMON_UNIT ($SYSTEMD_DAEMON_UNIT is serving) ..."
    if systemctl --user disable --now "$LEGACY_SYSTEMD_DAEMON_UNIT" 2>/dev/null; then
      rm -f "$legacy_path"
      systemctl --user daemon-reload 2>/dev/null || true
      say "  disabled + removed $legacy_path"
      say "  the canonical $SYSTEMD_DAEMON_UNIT keeps running (verified: active with a live main process)."
    else
      say "  NOTE: could not disable $LEGACY_SYSTEMD_DAEMON_UNIT (is the user service manager reachable?)."
      say "  Its unit file was left in place — this tool removed nothing. Retire it yourself:"
      say "    systemctl --user disable --now $LEGACY_SYSTEMD_DAEMON_UNIT && rm $legacy_path && systemctl --user daemon-reload"
    fi
    return 0
  fi

  if [ "$legacy_state" = "active" ]; then
    # Dominant upgrade state: the legacy unit is the ONLY serving unit.
    # Supervised transfer: canonical unit written first, then stop-legacy /
    # start-canonical / VERIFY (settled: active with the SAME live main
    # process across two probes — a Type=simple unit reports 'active' from
    # fork onward, so a single instant is-active proves nothing), and only
    # then retire the legacy unit.
    say ""
    say "Transferring daemon supervision from $LEGACY_SYSTEMD_DAEMON_UNIT to $SYSTEMD_DAEMON_UNIT ..."
    # A pre-existing canonical unit that still pins endpoint flags would make
    # the transfer start a daemon on the WRONG endpoint and retire the legacy
    # unit that was serving the configured one — behind a receipt that only
    # verifies liveness. Platform-managed pinned units are re-derived first;
    # a hand-written pinned unit refuses the transfer honestly.
    if [ -f "$canonical_path" ] && unit_is_endpoint_pinned "$canonical_path"; then
      case "$(canonical_unit_provenance "$canonical_path")" in
        managed)
          write_systemd_unit "$canonical_path"
          say "  rewrote    $canonical_path (replaced older pinned endpoint flags with the config-derived launch)"
          ;;
        *)
          say "  NOTE: the existing $SYSTEMD_DAEMON_UNIT pins endpoint flags (--hostname/--port) and is not"
          say "  recognizably platform-managed — transferring supervision onto it could bind the wrong endpoint."
          say "  Nothing was changed; remove those flags yourself, or migrate deliberately with:"
          say "    goodvibes-daemon migrate-service"
          return 0
          ;;
      esac
    fi
    wrote_canonical=0
    if [ ! -f "$canonical_path" ]; then
      write_systemd_unit "$canonical_path"
      wrote_canonical=1
      say "  wrote      $canonical_path"
    fi
    # Record the canonical unit's PRE-RUN enablement so a rollback can restore
    # it exactly — never blanket-disable a unit the user had enabled before.
    canonical_pre_enabled=$(unit_enabled_state "$SYSTEMD_DAEMON_UNIT")
    systemctl --user daemon-reload 2>/dev/null || true
    if ! systemctl --user stop "$LEGACY_SYSTEMD_DAEMON_UNIT" 2>/dev/null; then
      say "  NOTE: could not stop $LEGACY_SYSTEMD_DAEMON_UNIT — nothing was changed; the daemon keeps"
      say "  running under the legacy unit. Migrate later with: goodvibes-daemon migrate-service"
      [ "$wrote_canonical" = "1" ] && rm -f "$canonical_path"
      return 0
    fi

    transfer_verified=0
    if systemctl --user enable --now "$SYSTEMD_DAEMON_UNIT" 2>/dev/null; then
      sleep "$VERIFY_SETTLE_SECS"
      _pid1=$(systemd_unit_main_pid "$SYSTEMD_DAEMON_UNIT")
      if [ "$(unit_active_state "$SYSTEMD_DAEMON_UNIT")" = "active" ] &&
         [ -n "$_pid1" ] && kill -0 "$_pid1" 2>/dev/null; then
        sleep "$VERIFY_SETTLE_SECS"
        sleep "$VERIFY_SETTLE_SECS"
        _pid2=$(systemd_unit_main_pid "$SYSTEMD_DAEMON_UNIT")
        if [ "$(unit_active_state "$SYSTEMD_DAEMON_UNIT")" = "active" ] &&
           [ "$_pid2" = "$_pid1" ] && kill -0 "$_pid2" 2>/dev/null; then
          transfer_verified=1
        fi
      fi
    fi

    if [ "$transfer_verified" = "1" ]; then
      say "  started    $SYSTEMD_DAEMON_UNIT (verified: active with a stable live main process)"
      if systemctl --user disable "$LEGACY_SYSTEMD_DAEMON_UNIT" 2>/dev/null; then
        rm -f "$legacy_path"
        say "  retired    $LEGACY_SYSTEMD_DAEMON_UNIT (disabled, unit file removed)"
      else
        say "  NOTE: $SYSTEMD_DAEMON_UNIT is active, but $LEGACY_SYSTEMD_DAEMON_UNIT could not be disabled —"
        say "  its unit file was left in place. Retire it yourself:"
        say "    systemctl --user disable --now $LEGACY_SYSTEMD_DAEMON_UNIT && rm $legacy_path && systemctl --user daemon-reload"
      fi
      systemctl --user daemon-reload 2>/dev/null || true
    else
      # Rollback: the canonical unit did not come up healthy. Restore the
      # PRE-RUN state: remove only what this run wrote, restore the canonical
      # unit's prior enablement, and restart the legacy unit. Never leave the
      # host with no supervised daemon, and never leave the canonical unit
      # disabled when it was enabled before this run.
      say "  NOTE: $SYSTEMD_DAEMON_UNIT did not come up healthy — rolling back."
      if [ "$wrote_canonical" = "1" ]; then
        systemctl --user disable --now "$SYSTEMD_DAEMON_UNIT" 2>/dev/null || true
        rm -f "$canonical_path"
        say "  removed    $canonical_path (written by this run)"
      else
        systemctl --user stop "$SYSTEMD_DAEMON_UNIT" 2>/dev/null || true
        if [ "$canonical_pre_enabled" = "no" ]; then
          # This run's enable created the enablement — undo it.
          systemctl --user disable "$SYSTEMD_DAEMON_UNIT" 2>/dev/null || true
        fi
        # Pre-enabled (or unknown): the enablement is the user's — left as found.
      fi
      systemctl --user daemon-reload 2>/dev/null || true
      if systemctl --user start "$LEGACY_SYSTEMD_DAEMON_UNIT" 2>/dev/null; then
        say "  restarted  $LEGACY_SYSTEMD_DAEMON_UNIT — the daemon keeps running under the legacy unit."
      else
        say "  NOTE: the legacy unit could not be restarted either — start it yourself:"
        say "    systemctl --user start $LEGACY_SYSTEMD_DAEMON_UNIT"
      fi
    fi
    return 0
  fi

  # Neither unit is running a daemon. Retire the inactive legacy unit only
  # when a canonical unit file exists — never remove the only daemon unit.
  if [ ! -f "$canonical_path" ]; then
    say ""
    say "Found the installer-managed $LEGACY_SYSTEMD_DAEMON_UNIT (inactive) but no $SYSTEMD_DAEMON_UNIT unit —"
    say "  leaving it alone so the host is never left without a daemon unit."
    return 0
  fi
  say ""
  say "Retiring the inactive installer-managed $LEGACY_SYSTEMD_DAEMON_UNIT (superseded by $SYSTEMD_DAEMON_UNIT) ..."
  if systemctl --user disable --now "$LEGACY_SYSTEMD_DAEMON_UNIT" 2>/dev/null; then
    rm -f "$legacy_path"
    systemctl --user daemon-reload 2>/dev/null || true
    say "  disabled + removed $legacy_path"
    if [ "$canonical_state" = "active" ]; then
      # 'active' but not serving (no confirmed live main process): say so
      # rather than claiming health.
      say "  NOTE: $SYSTEMD_DAEMON_UNIT reports active but its main process could not be confirmed —"
      say "  check it with: systemctl --user status $SYSTEMD_DAEMON_UNIT"
    else
      say "  NOTE: $SYSTEMD_DAEMON_UNIT is present but not active — start it with:"
      say "    systemctl --user start $SYSTEMD_DAEMON_UNIT"
    fi
  else
    say "  NOTE: could not disable $LEGACY_SYSTEMD_DAEMON_UNIT (is the user service manager reachable?)."
    say "  Its unit file was left in place — this tool removed nothing. Retire it yourself:"
    say "    systemctl --user disable --now $LEGACY_SYSTEMD_DAEMON_UNIT && rm $legacy_path && systemctl --user daemon-reload"
  fi
}

# macOS analog: the launchd label never changed, but the OLD installer's plist
# carried a bare ProgramArguments (binary only). The marker proves the plist is
# installer-owned and safe to regenerate, so an upgrade rewrites it to the
# current launch form. A hand-written plist (no marker) is never touched.
# Run-state discipline mirrors the systemd side exactly:
#   - a LOADED agent is reloaded (bootout + bootstrap), gated on
#     GOODVIBES_RESTART_DAEMON — with it off, the file is updated and the
#     running agent honestly keeps the old arguments until reloaded;
#   - an agent the user has booted out (NOT loaded) is never started by a
#     migration: the file is updated, the agent stays stopped, and the load
#     command is printed. Rewriting a file must never override a user's stop.
migrate_legacy_launchd_plist() {
  plist_path=$(launchd_daemon_plist_path)
  [ -f "$plist_path" ] || return 0
  grep -q "$INSTALLER_MARKER" "$plist_path" 2>/dev/null || return 0
  # Already the current launch form — nothing to migrate. Current means
  # --daemon-home present AND no pinned endpoint flags: the middle generation
  # carried --daemon-home PLUS --hostname/--port, and keying the gate on
  # --daemon-home alone declared those pinned plists current forever.
  if grep -q -- '--daemon-home' "$plist_path" 2>/dev/null &&
     ! unit_is_endpoint_pinned "$plist_path"; then
    return 0
  fi

  # Record the agent's CURRENT load state BEFORE touching anything.
  agent_loaded=0
  if command -v launchctl >/dev/null 2>&1 &&
     launchctl print "gui/$(id -u)/$LAUNCHD_DAEMON_LABEL" >/dev/null 2>&1; then
    agent_loaded=1
  fi

  say ""
  say "Upgrading the installer-managed LaunchAgent to the current launch form ..."
  write_launchd_plist "$plist_path"
  say "  rewrote    $plist_path"

  if [ "$agent_loaded" != "1" ]; then
    say "  NOTE: the agent is not currently loaded — leaving it stopped (matching its current state)."
    say "  Load it yourself when ready:"
    say "    launchctl bootstrap gui/$(id -u) $plist_path"
    return 0
  fi
  if [ "$RESTART_DAEMON" != "1" ]; then
    say "  NOTE: GOODVIBES_RESTART_DAEMON=0 — the running agent keeps its old arguments until you reload it:"
    say "    launchctl bootout gui/$(id -u)/$LAUNCHD_DAEMON_LABEL ; launchctl bootstrap gui/$(id -u) $plist_path"
    return 0
  fi
  uid=$(id -u)
  launchctl bootout "gui/$uid/$LAUNCHD_DAEMON_LABEL" 2>/dev/null ||
    launchctl unload "$plist_path" 2>/dev/null || true
  if launchctl bootstrap "gui/$uid" "$plist_path" 2>/dev/null ||
     launchctl load "$plist_path" 2>/dev/null; then
    say "  reloaded   $LAUNCHD_DAEMON_LABEL with the new launch arguments"
  else
    say "  NOTE: could not reload the LaunchAgent — load it yourself:"
    say "    launchctl bootstrap gui/$uid $plist_path"
  fi
}

# --- sqlite-vec native addon: restores semantic vector search ---
# The SDK resolves the addon at <execDir>/lib/sqlite-vec-<os>-<arch>/vec0.<suffix>
# next to the running binary, so one copy in $INSTALL_DIR/lib serves goodvibes,
# goodvibes-daemon, and goodvibes-agent (they share $INSTALL_DIR). Verified
# against the same SHA256SUMS.txt as the binaries — a missing manifest entry is
# a hard failure, never a skip. Placed with an atomic rename so a running
# process never dlopen()s a half-written file.
install_sqlite_vec() {
  [ "$WITH_VECTOR" = "1" ] || return 0
  addon_asset="sqlite-vec-${VEC_OS}-${arch_tag}.${VEC_SUFFIX}"

  # The addon is verified against the SAME SHA256SUMS.txt as the binaries, so
  # the manifest entry decides whether this release even ships it. A release
  # that predates the addon has no entry — that is an older build with nothing
  # to install here, so note it and continue (the binaries still run; semantic
  # vector search stays unavailable, exactly as before the addon shipped). This
  # is the only non-fatal case. When the entry IS present the download and its
  # checksum are mandatory: a 404 or a mismatch is fatal, never a silent
  # unverified install.
  expected=$(awk -v name="$addon_asset" '$2 == name || $2 == "*"name {print $1}' "$WORKDIR/SHA256SUMS.txt" | head -1)
  if [ -z "$expected" ]; then
    say ""
    say "  note: release $VERSION does not ship $addon_asset — semantic vector"
    say "  search will be unavailable; upgrade to a release that includes it."
    return 0
  fi

  addon_dir="$INSTALL_DIR/lib/sqlite-vec-${VEC_OS}-${arch_tag}"
  addon_target="$addon_dir/vec0.${VEC_SUFFIX}"

  say ""
  say "  downloading $addon_asset ..."
  fetch "$BASE_URL/$addon_asset" "$WORKDIR/$addon_asset"

  actual=$(sha256_of "$WORKDIR/$addon_asset")
  [ "$expected" = "$actual" ] || fail "checksum mismatch for $addon_asset (expected $expected, got $actual)"
  say "  verified   $addon_asset"

  mkdir -p "$addon_dir"
  mv -f "$WORKDIR/$addon_asset" "$addon_target"
  say "  installed  $addon_target"
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

# --- uninstall mode (GOODVIBES_UNINSTALL=1) ---
# Stops the running daemon/agent and removes ONLY what this installer manages:
# the three binaries, the sqlite-vec addon dirs, and the service unit/plist when
# (and only when) it carries the installer-managed marker. ~/.goodvibes user
# data is preserved deliberately. No downloads happen in this mode.

UNINSTALL_REMOVED=""
UNINSTALL_KEPT=""
record_removed() { UNINSTALL_REMOVED="${UNINSTALL_REMOVED}  $1
"; }
record_kept() { UNINSTALL_KEPT="${UNINSTALL_KEPT}  $1
"; }

stop_bare_processes() {
  # stop_bare_processes <pgrep-pattern> <label> — TERM processes matching the
  # pattern whose executable lives under $INSTALL_DIR. A process that cannot be
  # attributed to $INSTALL_DIR is left alone and reported, never killed.
  pattern="$1"
  label="$2"
  pids=$(pgrep -f "$pattern" 2>/dev/null || true)
  [ -n "$pids" ] || return 0
  for pid in $pids; do
    if ! proc_belongs_to_install_dir "$pid"; then
      continue
    fi
    say "Stopping $label (pid $pid) ..."
    kill "$pid" 2>/dev/null || continue
    waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 10 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      say "  NOTE: pid $pid did not exit within 10s — stop it yourself: kill $pid"
    else
      say "  stopped    $label (pid $pid)"
      record_removed "$label process (pid $pid)"
    fi
  done
}

uninstall_systemd_service() {
  # uninstall_systemd_service <unit> <unit_path>
  unit="$1"
  unit_path="$2"
  command -v systemctl >/dev/null 2>&1 || return 0

  unit_present=0
  systemctl --user cat "$unit" >/dev/null 2>&1 && unit_present=1
  [ -f "$unit_path" ] && unit_present=1
  [ "$unit_present" = "1" ] || return 0

  managed=0
  [ -f "$unit_path" ] && grep -q "$INSTALLER_MARKER" "$unit_path" 2>/dev/null && managed=1

  if [ "$managed" = "1" ]; then
    say "Stopping and removing installer-managed $unit ..."
    systemctl --user disable --now "$unit" 2>/dev/null ||
      systemctl --user stop "$unit" 2>/dev/null || true
    rm -f "$unit_path"
    systemctl --user daemon-reload 2>/dev/null || true
    say "  removed    $unit_path"
    record_removed "$unit_path (installer-managed unit)"
  else
    say "Stopping $unit (present but not installer-managed) ..."
    systemctl --user stop "$unit" 2>/dev/null || true
    if [ -f "$unit_path" ]; then
      # A hand-written unit is never removed by uninstall, but it is still
      # worth saying plainly when its ExecStart binary is already gone (e.g.
      # a bun-era unit left behind by `bun remove -g`) rather than reporting
      # it identically to a working hand-written unit.
      exec_bin=$(systemd_unit_exec_binary "$unit")
      if [ -n "$exec_bin" ] && [ ! -x "$exec_bin" ]; then
        say "  NOTE: $unit_path points at $exec_bin, which no longer exists (a broken,"
        say "  non-installer-managed unit) — it is left in place; remove it yourself:"
      else
        say "  KEPT       $unit_path is not installer-managed (no marker) — leaving it in place."
        say "  Remove it yourself:"
      fi
      say "    systemctl --user disable --now $unit && rm $unit_path && systemctl --user daemon-reload"
      record_kept "$unit_path (hand-written $unit — not installer-managed)"
    fi
  fi
}

uninstall_launchd_agent() {
  # uninstall_launchd_agent <label> <plist_path>
  label="$1"
  plist_path="$2"
  command -v launchctl >/dev/null 2>&1 || return 0
  uid=$(id -u)

  present=0
  launchctl print "gui/$uid/$label" >/dev/null 2>&1 && present=1
  [ -f "$plist_path" ] && present=1
  [ "$present" = "1" ] || return 0

  managed=0
  [ -f "$plist_path" ] && grep -q "$INSTALLER_MARKER" "$plist_path" 2>/dev/null && managed=1

  say "Stopping launchd user agent $label ..."
  launchctl bootout "gui/$uid/$label" 2>/dev/null ||
    launchctl unload "$plist_path" 2>/dev/null || true

  if [ "$managed" = "1" ]; then
    rm -f "$plist_path"
    say "  removed    $plist_path"
    record_removed "$plist_path (installer-managed agent)"
  elif [ -f "$plist_path" ]; then
    say "  KEPT       $plist_path is not installer-managed (no marker) — leaving it in place."
    say "  Remove it yourself:"
    say "    launchctl bootout gui/$uid/$label ; rm $plist_path"
    record_kept "$plist_path (hand-written agent — not installer-managed)"
  fi
}

uninstall_services_and_processes() {
  case "$os_tag" in
    linux)
      uninstall_systemd_service "$SYSTEMD_DAEMON_UNIT" "$(systemd_daemon_unit_path)"
      # Also clean up the retired goodvibes-daemon.service unit name: removed
      # when installer-marker-managed, left in place (and reported) otherwise.
      uninstall_systemd_service "$LEGACY_SYSTEMD_DAEMON_UNIT" "$(systemd_unit_path "$LEGACY_SYSTEMD_DAEMON_UNIT")"
      uninstall_systemd_service goodvibes-agent.service "$HOME/.config/systemd/user/goodvibes-agent.service"
      ;;
    macos)
      uninstall_launchd_agent "$LAUNCHD_DAEMON_LABEL" "$(launchd_daemon_plist_path)"
      uninstall_launchd_agent sh.goodvibes.agent "$HOME/Library/LaunchAgents/sh.goodvibes.agent.plist"
      ;;
  esac
  # Any bare (non-service) processes launched from this INSTALL_DIR.
  stop_bare_processes '[g]oodvibes-daemon' goodvibes-daemon
  stop_bare_processes '[g]oodvibes-agent' goodvibes-agent
}

run_uninstall() {
  say "Uninstalling GoodVibes (installer-managed files) from $INSTALL_DIR"
  say ""

  uninstall_services_and_processes

  # Binaries the installer places.
  for name in goodvibes goodvibes-daemon goodvibes-agent; do
    bin_path="$INSTALL_DIR/$name"
    if [ -e "$bin_path" ]; then
      rm -f "$bin_path"
      say "  removed    $bin_path"
      record_removed "$bin_path"
    fi
  done

  # sqlite-vec addon dirs the installer places under $INSTALL_DIR/lib.
  for addon_dir in "$INSTALL_DIR"/lib/sqlite-vec-*; do
    [ -d "$addon_dir" ] || continue
    rm -rf "$addon_dir"
    say "  removed    $addon_dir"
    record_removed "$addon_dir"
  done
  # Drop the lib dir only if the installer left it empty.
  rmdir "$INSTALL_DIR/lib" 2>/dev/null || true

  # The installer-managed PATH line, if one was ever added.
  uninstall_shell_rc_path_line

  say ""
  say "Uninstall summary"
  say "-----------------"
  if [ -n "$UNINSTALL_REMOVED" ]; then
    say "Removed:"
    printf '%s' "$UNINSTALL_REMOVED"
  else
    say "Removed: nothing — no installer-managed files were found in $INSTALL_DIR."
  fi
  say ""
  say "Preserved:"
  say "  $HOME/.goodvibes (your GoodVibes data — settings, sessions, memory) is left untouched."
  if [ -n "$UNINSTALL_KEPT" ]; then
    printf '%s' "$UNINSTALL_KEPT"
  fi
  say ""
  say "To also erase all GoodVibes user data, remove it yourself:"
  say "  rm -rf $HOME/.goodvibes"
}

main() {
  resolve_platform

  if [ "$UNINSTALL" = "1" ]; then
    run_uninstall
    return 0
  fi

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

  ensure_path_on_shell_rc

  # Smoke test: the installed binary must at least report its version.
  # (doctor is a next-step suggestion, not an install gate: a healthy install
  # exits 0 — advisory findings render as notes, not failures — so there is
  # no "healthy install reports broken" case here to work around.)
  say ""
  if installed_version=$("$INSTALL_DIR/goodvibes" --version 2>/dev/null); then
    say "Installed: $installed_version"
  else
    fail "the installed binary failed to run ('goodvibes --version'); the download may not match this platform"
  fi

  # Install the sqlite-vec addon before restarting the daemon so the restarted
  # process picks it up and semantic vector search is live immediately.
  install_sqlite_vec

  # Bring a platform-managed canonical unit up to the current (config-derived)
  # launch shape BEFORE the restart below, so the restart applies it.
  refresh_pinned_canonical_unit

  restart_running_daemon

  if [ "$WITH_AGENT" = "1" ]; then
    install_agent
    restart_running_agent
  fi

  # First-run only: register the daemon as a user service when nothing is
  # running and no unit exists yet (a no-op on an upgrade, which the restart
  # path above already handled).
  setup_daemon_service

  # Upgrade path: once the canonical goodvibes.service is in place, retire a
  # leftover installer-managed goodvibes-daemon.service (the retired unit name)
  # so the host never runs two competing daemon units. A hand-written legacy
  # unit is left alone and only reported.
  migrate_legacy_installer_unit

  say ""
  if [ "$PATH_LINE_ADDED" = "1" ]; then
    # $INSTALL_DIR was just added to PATH in $RC_FILE_USED, but THIS shell
    # session hasn't re-sourced it yet — the bare 'goodvibes' command would
    # not resolve here. State a command that works RIGHT NOW instead of a
    # promise that depends on a shell restart the user hasn't done.
    say "Done. Start with: $INSTALL_DIR/goodvibes   (health check: $INSTALL_DIR/goodvibes doctor)"
    say "PATH updated in $RC_FILE_USED — open a new shell (or run: . $RC_FILE_USED) to use the plain 'goodvibes' command from then on."
  else
    say "Done. Start with: goodvibes   (health check: goodvibes doctor)"
  fi
  if [ "$WITH_AGENT" = "1" ]; then
    say "Personal agent:   goodvibes-agent"
  fi
}

# Run unless sourced as a library. The shell-level tests source this file with
# GOODVIBES_INSTALL_SH_LIB=1 to exercise individual functions (unit generation,
# uninstall file handling) without performing a network install.
if [ "${GOODVIBES_INSTALL_SH_LIB:-0}" != "1" ]; then
  main
fi
