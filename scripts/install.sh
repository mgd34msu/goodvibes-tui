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
# It also downloads and verifies the agent's browser driver archive and extracts
# it to $INSTALL_DIR/playwright-core, which is what makes goodvibes-agent able to
# drive a browser at all (a compiled binary carries no node_modules).
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
#   GOODVIBES_SHADOW_REMOVE   what to do about another copy of an installed command
#                             that sits earlier on PATH: ask (default, prompts on a
#                             terminal), 1 (remove recognised copies without asking),
#                             0 (report only, never remove)
#
# PATH shadowing check: installing a file is not the same as making it
# reachable. After everything is placed, the installer enumerates every copy of
# goodvibes / goodvibes-daemon / goodvibes-agent on PATH and checks that the
# copy it maintains is the one the shell would run. When an earlier PATH entry
# provides the same command — a leftover `bun add -g` link, an npm global, an
# older standalone install — it says which path wins and what version each is,
# offers to remove the shadowing copy when that copy is recognisably one of our
# own programs and lives inside the user's home directory, and exits non-zero
# if a shadow remains. An install nobody can reach is a failed install: it is
# how two successful installs in a row can leave an old build answering while
# the version number reports itself current.
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
# the browser driver dir,
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
WITH_WAKE_MODEL="${GOODVIBES_WAKE_MODEL:-1}"
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
#
# --daemon-home takes the daemon's own STATE directory ($HOME/.goodvibes/daemon)
# — the one holding operator-tokens.json, auth-users.json and
# daemon-settings.json — not $HOME. Both writers baked $HOME, so a serviced
# daemon filed its identity a level above where every reader looks and the
# client that talks to it kept reading an empty operator-tokens.json under
# .goodvibes/daemon.

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
# proc_exe_path <pid> — the executable behind a pid, or empty when it cannot
# be determined. Printed to the operator when a foreign process is left alone,
# so "something else owns this" names WHICH something else.
proc_exe_path() {
  _pid="$1"
  if [ -r "/proc/$_pid/exe" ]; then
    _resolved=$(readlink -f "/proc/$_pid/exe" 2>/dev/null || true)
    if [ -n "$_resolved" ] && [ -e "$_resolved" ]; then
      printf '%s' "$_resolved"
      return 0
    fi
    # An upgrade that REPLACES the binary leaves the running process pointing
    # at a deleted inode, which `readlink -f` cannot resolve. The raw link
    # still records the path it was launched from, so this install's own
    # daemon stays attributable to it across exactly the upgrade this script
    # performs — without it, the process the restart path exists to restart
    # would look foreign and be skipped.
    _raw=$(readlink "/proc/$_pid/exe" 2>/dev/null || true)
    _raw=${_raw% (deleted)}
    if [ -n "$_raw" ]; then
      printf '%s' "$_raw"
      return 0
    fi
  fi
  ps -o args= -p "$_pid" 2>/dev/null | sed 's/ .*$//'
}

proc_belongs_to_install_dir() {
  _exe=$(proc_exe_path "$1")
  case "$_exe" in
    "$INSTALL_DIR"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# pids_owned_by_install <pgrep-pattern> — pids matching the pattern whose
# executable resolves under $INSTALL_DIR.
#
# `pgrep -f` matches on a COMMAND LINE, which is a host-global namespace: it
# cannot tell this install's daemon from one belonging to another checkout, a
# worktree, a dev copy, or another user's tree. Every site that acts on the
# result must filter first — a machine deliberately running more than one
# goodvibes node is the case the clustering work exists to support, and an
# installer that kills the other nodes defeats it.
pids_owned_by_install() {
  _matched=$(pgrep -f "$1" 2>/dev/null || true)
  [ -n "$_matched" ] || return 0
  for _p in $_matched; do
    if proc_belongs_to_install_dir "$_p"; then
      printf '%s\n' "$_p"
    fi
  done
}

# report_foreign_processes <pgrep-pattern> <label> — name the processes this
# script matched but will NOT touch, so an operator who expected the installer
# to restart something can see why it did not.
report_foreign_processes() {
  _matched=$(pgrep -f "$1" 2>/dev/null || true)
  [ -n "$_matched" ] || return 0
  for _p in $_matched; do
    proc_belongs_to_install_dir "$_p" && continue
    _foreign_exe=$(proc_exe_path "$_p")
    # `pgrep -f` matches command lines, so anything that merely MENTIONS the
    # binary — this script, a shell running it, an editor, a log tail — also
    # matches. Reporting those as "a different install" would be false. Only
    # a process whose executable is actually named like the one being managed
    # is worth telling the operator about; the rest are skipped in silence
    # because they were never candidates.
    [ -n "$_foreign_exe" ] || continue
    [ "${_foreign_exe##*/}" = "$2" ] || continue
    say ""
    say "Leaving $2 (pid $_p) alone — it belongs to a different install:"
    say "  $_foreign_exe"
    say "  This install manages only $INSTALL_DIR. Restart that one yourself if you meant to."
  done
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
      # Tri-state like the systemd branch: a print failure is NOT the same as
      # "label not loaded". launchctl exits 113 for could-not-find-service
      # (affirmatively not loaded); any other failure (e.g. the gui domain
      # unreachable from an ssh session — 'Bad request') means the manager
      # could not be ASKED, and cannot-ask is never read as free-to-kill.
      _saw_print_failure=0
      for _label in "$LAUNCHD_DAEMON_LABEL" goodvibes sh.goodvibes.agent; do
        _lrc=0
        _lout=$(launchctl print "gui/$(id -u)/$_label" 2>/dev/null) || _lrc=$?
        if [ "$_lrc" -eq 0 ]; then
          if printf '%s\n' "$_lout" | grep -q "pid = $_q"; then
            printf 'supervised'
            return 0
          fi
        elif [ "$_lrc" -ne 113 ]; then
          _saw_print_failure=1
        fi
      done
      if [ "$_saw_print_failure" = "1" ]; then
        printf 'unknown'
        return 0
      fi
      # Our labels affirmatively do not own it. launchd supervision under a
      # foreign label is not cheaply enumerable; the practical supervision
      # surface for the goodvibes binaries is our own labels.
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

# Timestamped backup of a unit/plist file about to be regenerated, with a
# receipt naming it. Fingerprint/structural provenance is only PROBABLY
# platform-owned — a user may have customized a product-written unit in place
# (extra Environment lines, a different binary path) while keeping its
# recognizable shape — so a regeneration must never destroy the prior
# content: recovery is one mv away.
backup_unit_file() {
  _bf="$1"
  _bak="$_bf.bak.$(date +%Y%m%d%H%M%S)"
  cp -p "$_bf" "$_bak" 2>/dev/null || cp "$_bf" "$_bak"
  say "  backed up  $_bf -> $_bak"
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
      backup_unit_file "$_rp"
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
  # restart_systemd_unit <unit> <expected-binary> [replace-broken] — returns 0
  # if it handled a running unit (restarted, replaced, or reported), 1 if no
  # active unit exists, or its unit was just replaced because it could no
  # longer run — either way the caller should fall through to bare-process
  # handling and then first-run service setup. The optional third argument
  # (default 1) gates the broken-ExecStart replacement branch: callers that
  # have classified the unit as HAND-WRITTEN pass 0, because this tool never
  # disables, renames, or rewrites a hand-written unit — not even a broken one.
  unit="$1"
  expected_bin="$2"
  replace_broken="${3:-1}"
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
    if [ "$replace_broken" != "1" ]; then
      # Hand-written unit in the corpse state: the running daemon may be
      # executing a deleted inode. Touch NOTHING — restarting would kill the
      # daemon with no binary to relaunch, and disabling/renaming is exactly
      # the never-touch violation this gate exists to prevent. Say so.
      say ""
      say "NOTE: ${unit} points at $exec_bin, which no longer exists, and the unit is not one this"
      say "  tool may replace — leaving it (and its running daemon, which may be executing a deleted"
      say "  binary) untouched."
      say "  Fix the unit's ExecStart yourself, then: systemctl --user restart $unit"
      return 0
    fi
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
  #
  # The RELAUNCH INVOCATION is canonical for goodvibes-daemon, never read off
  # the process being replaced. An earlier version captured the outgoing
  # process's raw /proc/<pid>/cmdline and replayed it verbatim on relaunch —
  # so ANY process merely matching the pgrep pattern (a manually launched
  # diagnostic copy, a bun-compiled binary whose cmdline carries its own
  # internal argv[1], leftover --hostname/--port flags from an old pinned
  # unit) had its exact argv, and — via plain `nohup` — this shell's own
  # current working directory, relaunched as if it were this install's real
  # daemon. Live incident: a stray goodvibes-daemon process running from a
  # scratch directory got killed and relaunched with its own captured
  # `/$bunfs/root/goodvibes-daemon-linux-x64 --daemon-home ./fresh-home
  # --port 3499`, in whatever directory the installer happened to be run
  # from. write_systemd_unit's canonical shape
  # ("$INSTALL_DIR/goodvibes-daemon" --daemon-home "$HOME") is used instead
  # for the daemon: it resolves everything else (host/port, etc.) from
  # settings at startup, so nothing is lost by not replaying old flags, and
  # the relaunch runs from $HOME rather than the installer's own (possibly
  # scratch/temp) cwd. goodvibes-agent has no canonical invocation known to
  # this installer (it is not a unit this script writes), so its original
  # arguments are still recovered from the process being replaced.
  pattern="$1"
  new_bin="$2"
  _is_daemon=0
  [ "${new_bin##*/}" = "goodvibes-daemon" ] && _is_daemon=1
  # Only ever this install's own processes; anything else is named and left
  # running. See pids_owned_by_install.
  report_foreign_processes "$pattern" "${new_bin##*/}"
  pids=$(pids_owned_by_install "$pattern")
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
    # Belt and braces: `pids` already came from pids_owned_by_install, so a
    # process that is not this install's cannot reach here. It is re-checked
    # rather than assumed because everything below this line signals a pid,
    # and the previous version of this block SIGTERMed exactly the processes
    # it had just identified as belonging to somebody else.
    if ! proc_belongs_to_install_dir "$pid"; then
      continue
    fi

    if [ "$_is_daemon" = "1" ]; then
      # Canonical only — never derived from the process being replaced.
      # display_args is for the human-readable notices below only.
      display_args="--daemon-home $HOME"
    else
      # No canonical shape known for this binary — recover the original
      # arguments so flags survive.
      if [ -r "/proc/$pid/cmdline" ]; then
        args=$(tr '\0' '\n' < "/proc/$pid/cmdline" | tail -n +2 | tr '\n' ' ')
      else
        args=$(ps -o args= -p "$pid" 2>/dev/null | sed 's/^[^ ]* *//')
      fi
      args=$(printf '%s' "${args:-}" | sed 's/[[:space:]]*$//')
      display_args="${args:-}"
    fi

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
      say "  Stop it, then start the new one: $new_bin ${display_args:-}"
      continue
    fi

    if [ "$_is_daemon" = "1" ]; then
      # Canonical relaunch: fixed binary + --daemon-home "$HOME" only, run
      # from $HOME — never the installer's own (possibly scratch/temp) cwd,
      # and never any argv carried over from the process just stopped.
      (
        cd "$HOME" 2>/dev/null || cd / 2>/dev/null || true
        exec nohup "$new_bin" --daemon-home "$HOME" >/dev/null 2>&1
      ) &
      newpid=$!
    else
      # shellcheck disable=SC2086  # args is intentionally word-split
      nohup "$new_bin" ${args:-} >/dev/null 2>&1 &
      newpid=$!
    fi
    sleep 1
    if kill -0 "$newpid" 2>/dev/null; then
      say "  restarted  pid $newpid${display_args:+ (args: $display_args)}"
    else
      say "  NOTE: the new process did not stay up — start it yourself and check its output:"
      say "    $new_bin ${display_args:-}"
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
  # Tri-state the load probe: exit 113 = could-not-find-service (affirmatively
  # not loaded — the caller may use the guarded bare-process path); any other
  # failure means launchd could not be ASKED (gui domain unreachable from this
  # session) — refuse with an honest note and report handled, so the caller
  # never falls through to kill/nohup on a guess.
  _prc=0
  launchctl print "gui/$(id -u)/$_label" >/dev/null 2>&1 || _prc=$?
  if [ "$_prc" -ne 0 ]; then
    [ "$_prc" -eq 113 ] && return 1
    say ""
    say "NOTE: cannot determine the $_label agent state (launchctl print failed — is the GUI session"
    say "  reachable from this session?). No process was touched; restart the agent yourself from a"
    say "  logged-in session:  launchctl kickstart -k gui/$(id -u)/$_label"
    return 0
  fi
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
    # The in-app install-service registers the daemon under the PRODUCT label
    # 'goodvibes' (~/Library/LaunchAgents/goodvibes.plist) — a loaded agent
    # there is the same daemon and gets the same in-place restart.
    restart_launchd_agent goodvibes && return 0
    restart_bare_processes '[g]oodvibes-daemon' "$INSTALL_DIR/goodvibes-daemon"
    return 0
  fi
  # The broken-ExecStart replacement branch is provenance-gated at EVERY
  # call site: only a provably platform-managed canonical unit may be
  # replaced; a hand-written (or unreadable/absent-file) one is never
  # disabled, renamed, or rewritten — not even in the corpse state.
  _canon_replace=0
  [ "$(canonical_unit_provenance "$(systemd_daemon_unit_path)")" = "managed" ] && _canon_replace=1
  restart_systemd_unit "$SYSTEMD_DAEMON_UNIT" "$INSTALL_DIR/goodvibes-daemon" "$_canon_replace" && return 0
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
          # the upgrade must still take effect — restart it in place. The
          # third argument gates the broken-ExecStart replacement branch OFF:
          # a hand-written unit is never disabled, renamed, or rewritten,
          # corpse state included.
          restart_systemd_unit "$LEGACY_SYSTEMD_DAEMON_UNIT" "$INSTALL_DIR/goodvibes-daemon" 0 || {
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
  # The installer never writes a goodvibes-agent.service unit, so any agent
  # unit on disk is product- or hand-written: the replacement branch is
  # always gated off here.
  restart_systemd_unit goodvibes-agent.service "$INSTALL_DIR/goodvibes-agent" 0 && return 0
  restart_bare_processes '[g]oodvibes-agent' "$INSTALL_DIR/goodvibes-agent"
}

# --- daemon liveness detection (shared by first-run setup and uninstall) ---
# A systemd user unit reported active, OR a bare goodvibes-daemon process.

daemon_systemd_active() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user is-active --quiet "$SYSTEMD_DAEMON_UNIT" 2>/dev/null
}

daemon_bare_process_running() {
  # Scoped to THIS install. Answering "yes" for a daemon belonging to another
  # checkout made first-run setup decide a daemon was already running and skip
  # registering the service — so a fresh install silently ended up with no
  # daemon of its own on any machine that already ran one.
  [ -n "$(pids_owned_by_install '[g]oodvibes-daemon')" ]
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
ExecStart="$INSTALL_DIR/goodvibes-daemon" --daemon-home "$HOME/.goodvibes/daemon"
Restart=on-failure
RestartSec=2$_restart_escalation

[Install]
WantedBy=default.target
EOF
}

write_launchd_plist() {
  # write_launchd_plist <path> [label] — writes the installer-managed
  # LaunchAgent text only, no activation. The GoodVibesManagedBy key and the
  # XML comment both carry the marker string the uninstall path greps for.
  # The label defaults to the installer's own; regenerating the product's
  # goodvibes.plist passes 'goodvibes' so label/path correspondence survives.
  _plist_path="$1"
  _plist_label="${2:-$LAUNCHD_DAEMON_LABEL}"
  mkdir -p "$(dirname "$_plist_path")"
  cat > "$_plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!-- $INSTALLER_MARKER -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$_plist_label</string>
  <key>GoodVibesManagedBy</key>
  <string>$INSTALLER_MARKER</string>
  <key>ProgramArguments</key>
  <array>
    <string>$INSTALL_DIR/goodvibes-daemon</string>
    <string>--daemon-home</string>
    <string>$HOME/.goodvibes/daemon</string>
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
          backup_unit_file "$canonical_path"
          write_systemd_unit "$canonical_path"
          say "  rewrote    $canonical_path (replaced older pinned endpoint flags with the config-derived launch)"
          ;;
        *)
          say "  NOTE: the existing $SYSTEMD_DAEMON_UNIT pins endpoint flags (--hostname/--port) and is not"
          say "  recognizably platform-managed — transferring supervision onto it could bind the wrong endpoint."
          say "  The units were not changed; remove those flags yourself, or migrate deliberately with:"
          say "    goodvibes-daemon migrate-service"
          # The restart path deferred the in-place restart to this transfer
          # ('the migration step below transfers it') — the promise must not
          # die with the refusal: restart the legacy unit here so the swapped
          # binary actually starts serving.
          if systemctl --user restart "$LEGACY_SYSTEMD_DAEMON_UNIT" 2>/dev/null; then
            say "  restarted  $LEGACY_SYSTEMD_DAEMON_UNIT — the daemon keeps running there, now on the upgraded binary."
          else
            say "  NOTE: could not restart $LEGACY_SYSTEMD_DAEMON_UNIT — the running daemon is still the previous"
            say "  binary; restart it yourself:  systemctl --user restart $LEGACY_SYSTEMD_DAEMON_UNIT"
          fi
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
# The PRODUCT's in-app LaunchAgent identity: the SDK writes
# ~/Library/LaunchAgents/<serviceName>.plist with serviceName 'goodvibes' —
# a different path AND label from the installer's sh.goodvibes.daemon. Both
# are platform-owned upgrade targets.
launchd_product_plist_path() { printf '%s' "$HOME/Library/LaunchAgents/goodvibes.plist"; }

migrate_legacy_launchd_plist() {
  migrate_one_launchd_plist "$(launchd_daemon_plist_path)" "$LAUNCHD_DAEMON_LABEL"
  migrate_one_launchd_plist "$(launchd_product_plist_path)" goodvibes
}

migrate_one_launchd_plist() {
  plist_path="$1"
  plist_label="$2"
  [ -f "$plist_path" ] || return 0
  # Already the current launch form — nothing to migrate. Current means
  # --daemon-home present AND no pinned endpoint flags: the middle generation
  # carried --daemon-home PLUS --hostname/--port, and keying the gate on
  # --daemon-home alone declared those pinned plists current forever.
  if grep -q -- '--daemon-home' "$plist_path" 2>/dev/null &&
     ! unit_is_endpoint_pinned "$plist_path"; then
    return 0
  fi

  # Provenance: the installer marker is proof of platform ownership. Without
  # it, ProgramArguments[0] naming the goodvibes-managed binary inside
  # $INSTALL_DIR is strong structural evidence of a product-installed plist —
  # the SDK's plist writer emits no marker and structurally CANNOT carry the
  # product Description fingerprint (renderLaunchdPlist drops the definition
  # description; an SDK-owned gap, reported upstream). Anything else is
  # indeterminable: an honest notice when pinned, never silence.
  plist_managed=0
  if grep -q "$INSTALLER_MARKER" "$plist_path" 2>/dev/null; then
    plist_managed=1
  elif grep -q "<string>$INSTALL_DIR/goodvibes-daemon</string>" "$plist_path" 2>/dev/null; then
    plist_managed=1
  fi

  if [ "$plist_managed" != "1" ]; then
    if unit_is_endpoint_pinned "$plist_path"; then
      say ""
      say "NOTE: the LaunchAgent at $plist_path pins endpoint flags (--hostname/--port), which override the"
      say "  controlPlane settings — and it is not recognizably platform-managed, so it was left untouched."
      say "  Remove those flags yourself so the daemon follows your settings."
    fi
    return 0
  fi

  # Record the agent's CURRENT load state BEFORE touching anything.
  agent_loaded=0
  if command -v launchctl >/dev/null 2>&1 &&
     launchctl print "gui/$(id -u)/$plist_label" >/dev/null 2>&1; then
    agent_loaded=1
  fi

  say ""
  say "Upgrading the platform-managed LaunchAgent ($plist_label) to the current launch form ..."
  backup_unit_file "$plist_path"
  write_launchd_plist "$plist_path" "$plist_label"
  say "  rewrote    $plist_path"

  if [ "$agent_loaded" != "1" ]; then
    say "  NOTE: the agent is not currently loaded — leaving it stopped (matching its current state)."
    say "  Load it yourself when ready:"
    say "    launchctl bootstrap gui/$(id -u) $plist_path"
    return 0
  fi
  if [ "$RESTART_DAEMON" != "1" ]; then
    say "  NOTE: GOODVIBES_RESTART_DAEMON=0 — the running agent keeps its old arguments until you reload it:"
    say "    launchctl bootout gui/$(id -u)/$plist_label ; launchctl bootstrap gui/$(id -u) $plist_path"
    return 0
  fi
  uid=$(id -u)
  launchctl bootout "gui/$uid/$plist_label" 2>/dev/null ||
    launchctl unload "$plist_path" 2>/dev/null || true
  if launchctl bootstrap "gui/$uid" "$plist_path" 2>/dev/null ||
     launchctl load "$plist_path" 2>/dev/null; then
    say "  reloaded   $plist_label with the new launch arguments"
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

# --- wake-word model: makes "hey goodvibes" work on a fresh machine ---
#
# Everything needed to detect the phrase already shipped inside the binary, and
# the model itself was reachable only by typing `/voice wake setup` — so the
# ordinary outcome of installing goodvibes was a wake word that could not start,
# waiting on a download nobody had been told about.
#
# This runs the daemon binary that was just installed and verified, rather than
# fetching the artifacts here, for one reason: the pinned URLs, byte counts and
# checksums live in the SDK's wake-word manifest, and a second copy of a pin in
# shell would drift silently the first time the model is retrained. The binary
# reaches the one manifest. (This is also why there is no SHA256SUMS entry to
# look up: these artifacts are hosted on the SDK's own append-only release tag,
# not this repository's release.)
#
# NEVER FATAL. A wake-word model is not a reason to fail installing a coding
# tool, and an installer that aborts half-way is worse than one that finishes
# without a wake word. The subcommand exits 0 whatever happens and prints one
# plain line; if it is missing entirely (an older binary than this installer) the
# `|| true` covers that too. A running daemon retries at every boot, and
# `/voice wake setup` fetches it on demand.
#
# GOODVIBES_WAKE_MODEL=0 skips it, for an air-gapped host or a user who does not
# want the feature.
install_wake_word_model() {
  [ "$WITH_WAKE_MODEL" = "1" ] || {
    say ""
    say "  note: skipping the wake-word model (GOODVIBES_WAKE_MODEL=0). Wake-word"
    say "  detection will report not-provisioned until you run: goodvibes /voice wake setup"
    return 0
  }

  say ""
  say "Installing the wake-word model ..."
  wake_output=$("$INSTALL_DIR/goodvibes-daemon" provision-wake-model 2>&1) || true
  if [ -n "$wake_output" ]; then
    printf '%s\n' "$wake_output" | while IFS= read -r wake_line; do
      say "  $wake_line"
    done
  else
    say "  note: this build has no provision-wake-model command — wake-word detection"
    say "  will fetch its model at the next daemon start, or run: goodvibes /voice wake setup"
  fi
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

  install_browser_driver "$agent_base_url" "$AGENT_VERSION"
}

# --- browser driver: makes goodvibes-agent able to drive a browser at all ---
# The agent is a compiled binary and carries no node_modules, so
# require('playwright-core') resolves nothing inside it and the driver cannot be
# bundled either (it reads browsers.json and its own files by path at runtime).
# It therefore ships as its own release asset and is extracted beside the binary,
# at $INSTALL_DIR/playwright-core — the first location the agent's driver search
# looks. Release 1.18.1 shipped no such asset and every installed binary reported
# browser control as unavailable, which is what this exists to prevent.
#
# One archive serves every platform (the driver is plain JavaScript; the browser
# binaries it drives are downloaded separately into the agent's managed cache).
# Verified against the SAME agent SHA256SUMS.txt as the binary, on the same terms
# as the sqlite-vec addon: a missing manifest entry means the release predates
# the asset and is a note, not a failure; a present entry makes the download and
# its checksum mandatory. Extraction goes to a scratch directory and is moved
# into place only once complete, so an interrupted install never leaves a
# half-extracted directory that resolves as a driver and fails on first use.
install_browser_driver() {
  _base_url="$1"
  _version="$2"
  driver_asset="browser-driver.tar.gz"

  expected=$(awk -v name="$driver_asset" '$2 == name || $2 == "*"name {print $1}' "$WORKDIR/agent-SHA256SUMS.txt" | head -1)
  if [ -z "$expected" ]; then
    say ""
    say "  note: agent release $_version does not ship $driver_asset — the agent will"
    say "  install a browser driver for itself the first time it is asked to use a browser."
    return 0
  fi

  say ""
  say "  downloading $driver_asset ..."
  fetch "$_base_url/$driver_asset" "$WORKDIR/$driver_asset"

  actual=$(sha256_of "$WORKDIR/$driver_asset")
  [ "$expected" = "$actual" ] || fail "checksum mismatch for $driver_asset (expected $expected, got $actual)"
  say "  verified   $driver_asset"

  driver_staging="$WORKDIR/browser-driver-staging"
  rm -rf "$driver_staging"
  mkdir -p "$driver_staging"
  tar -xzf "$WORKDIR/$driver_asset" -C "$driver_staging" ||
    fail "could not extract $driver_asset"

  # cli.js is what the agent executes to install a browser; an archive without
  # it is not a usable driver no matter what else extracted.
  for required in package.json index.js cli.js; do
    [ -f "$driver_staging/playwright-core/$required" ] ||
      fail "$driver_asset is missing playwright-core/$required — refusing to install an unusable driver"
  done

  driver_target="$INSTALL_DIR/playwright-core"
  rm -rf "$driver_target.incoming"
  mv -f "$driver_staging/playwright-core" "$driver_target.incoming"
  rm -rf "$driver_target"
  mv -f "$driver_target.incoming" "$driver_target"
  say "  installed  $driver_target"
}

# --- PATH shadowing: is the install we just wrote the one the shell runs? ---
#
# Installing a file is not the same as making it reachable. If any directory
# EARLIER on PATH than $INSTALL_DIR also provides `goodvibes`,
# `goodvibes-daemon`, or `goodvibes-agent`, then typing the bare command runs
# that other copy, and this installer — and the auto-updater after it — keeps
# maintaining a file the user never reaches. That is exactly how a leftover
# `~/.bun/bin/goodvibes-agent` (a `bun add -g` link, 1.18.1) at PATH position 2
# beat `~/.local/bin/goodvibes-agent` (1.21.0) at position 21: two successful
# installs in a row, an old build answering, and a version number that
# reported itself current the whole time.
#
# So after installing, enumerate every copy on PATH, name the one that wins and
# what version each is, and offer to remove the shadowing one when it is
# recognisably ours. An install that cannot be reached is a failed install, so
# an unresolved shadow exits non-zero.
#
# The same rules live in the SDK as platform/runtime/path-shadow for the
# clients' startup check; this is their POSIX sh statement, because an
# installer cannot import TypeScript.
#
#   GOODVIBES_SHADOW_REMOVE=ask   prompt on a terminal (default)
#   GOODVIBES_SHADOW_REMOVE=1     remove recognised copies without asking
#   GOODVIBES_SHADOW_REMOVE=0     never remove; report only
SHADOW_REMOVE="${GOODVIBES_SHADOW_REMOVE:-ask}"

# Set to 1 by shadow_confirm() when it could not ask (no controlling
# terminal) rather than being genuinely declined — see shadow_confirm and
# check_command_shadowing's use of it below.
SHADOW_HEADLESS_UNCONFIRMED=0

# Set to 1 when a shadow was found and is still in place at the end of main().
PATH_SHADOW_UNRESOLVED=0

# The PATH the check reasons about. Defaults to this process's PATH and is
# recomputed by shadow_effective_path() before the scan; the tests set it
# directly to drive a scenario without touching the real environment.
SHADOW_PATH="${PATH:-}"

# The PATH the user will actually have, which is not always this process's.
#
# When $INSTALL_DIR is missing from PATH, the installer writes a PATH line into
# the user's shell rc that PREPENDS it (ensure_path_on_shell_rc). That line is
# appended to the end of the rc file, so it runs after anything else in there
# and $INSTALL_DIR ends up first — nothing can shadow it once a new shell
# starts. Checking this process's PATH instead would report "not on your PATH"
# for the very install that just fixed that, which is a false alarm on a fresh
# machine. So model the shell the user is about to open: prepend $INSTALL_DIR
# whenever the rc file carries our line, whether this run wrote it or an
# earlier one did.
shadow_effective_path() {
  shadow_effective_dir=$(shadow_trim_dir "$INSTALL_DIR")
  case ":${PATH:-}:" in
    *":$shadow_effective_dir:"*)
      printf '%s' "${PATH:-}"
      return 0
      ;;
  esac
  if [ "$PATH_LINE_ADDED" = "1" ]; then
    printf '%s:%s' "$shadow_effective_dir" "${PATH:-}"
    return 0
  fi
  shadow_effective_rc=$(resolve_shell_rc)
  if [ -f "$shadow_effective_rc" ] && grep -qF "$INSTALLER_MARKER" "$shadow_effective_rc" 2>/dev/null; then
    printf '%s:%s' "$shadow_effective_dir" "${PATH:-}"
    return 0
  fi
  printf '%s' "${PATH:-}"
}

# Every PATH directory in search order: NORMALIZED (see shadow_normalize_dir
# below — trailing slashes trimmed, '.'/'..' segments collapsed, symlinks
# resolved where the directory exists), empty entries dropped (an empty PATH
# element means the current directory, which is not a stable install anyone
# can reason about), duplicates collapsed to their first occurrence — the
# only position that can ever win.
#
# Normalizing here (not just trimming trailing slashes) matters: without it,
# "$HOME/.local/share/../bin" and "$HOME/.local/bin" — the SAME directory,
# reached two different ways — compared as two DIFFERENT PATH entries. If the
# '..' spelling happened to sit earlier on PATH than the plain one, the real
# install looked shadowed by itself, and the recognizably-ours removal advice
# would have deleted the very binary it just installed.
shadow_path_entries() {
  _spe_seen=''
  _spe_old_ifs=$IFS
  IFS=:
  set -f
  # shellcheck disable=SC2086  # intentional IFS=: word-splitting
  set -- ${SHADOW_PATH:-}
  set +f
  IFS=$_spe_old_ifs
  for _spe_raw in "$@"; do
    [ -n "$_spe_raw" ] || continue
    _spe_norm=$(shadow_normalize_dir "$_spe_raw")
    [ -n "$_spe_norm" ] || continue
    case "$_spe_seen" in
      *"
$_spe_norm
"*)
        continue
        ;;
    esac
    _spe_seen="$_spe_seen
$_spe_norm
"
    printf '%s\n' "$_spe_norm"
  done
}

# Trailing slashes trimmed the same way, so "$HOME/.local/bin/" and
# "$HOME/.local/bin" are one directory on both sides of every comparison.
shadow_trim_dir() {
  printf '%s' "$1" | awk '{
    d = $0
    while (length(d) > 1 && substr(d, length(d), 1) == "/") d = substr(d, 1, length(d) - 1)
    print d
  }'
}

# Follows a symlink chain to the file it really names. Uses readlink -f where
# it exists (GNU and modern BSD), and otherwise chases up to 16 links by hand
# so macOS without coreutils gets the same answer. Prints the input unchanged
# when it is not a link or cannot be resolved.
shadow_real_path() {
  if readlink -f "$1" 2>/dev/null; then
    return 0
  fi
  current=$1
  hops=0
  while [ -L "$current" ] && [ "$hops" -lt 16 ]; do
    target=$(readlink "$current" 2>/dev/null) || break
    case "$target" in
      /*) current=$target ;;
      *) current="$(dirname "$current")/$target" ;;
    esac
    hops=$((hops + 1))
  done
  printf '%s\n' "$current"
}

# Lexically collapses '.' and '..' path segments in an ABSOLUTE path —
# realpath -m style: pure string manipulation, no filesystem access, so it
# works whether or not the directory exists yet. A leading '..' cannot climb
# above '/'. Only ever applied to absolute paths (every PATH entry and
# $INSTALL_DIR are); a relative input is printed back unchanged.
shadow_collapse_dots() {
  case "$1" in
    /*) : ;;
    *) printf '%s' "$1"; return 0 ;;
  esac
  printf '%s\n' "$1" | awk -F/ '
    {
      n = 0
      for (i = 1; i <= NF; i++) {
        part = $i
        if (part == "" && i == 1) { out[++n] = ""; continue }
        if (part == "" || part == ".") continue
        if (part == "..") {
          if (n > 1) n--
          continue
        }
        out[++n] = part
      }
      result = out[1]
      for (i = 2; i <= n; i++) result = result "/" out[i]
      if (result == "") result = "/"
      print result
    }'
}

# Canonicalizes a directory to the same string every equivalent spelling
# resolves to, so "$HOME/.local/share/../bin" and "$HOME/.local/bin" compare
# equal: trims trailing slashes, lexically collapses '.'/'..' segments (works
# even when the directory does not exist), and — when the directory DOES
# exist — additionally resolves any symlinks in it via shadow_real_path. Falls
# back to the trimmed-and-collapsed literal when it cannot be resolved further
# (does not exist, permission denied) rather than erroring: a PATH may
# legitimately name a directory that isn't there yet.
shadow_normalize_dir() {
  _nd=$(shadow_trim_dir "$1")
  [ -n "$_nd" ] || { printf '%s' ''; return 0; }
  case "$_nd" in
    /*) _nd=$(shadow_collapse_dots "$_nd") ;;
  esac
  if [ -d "$_nd" ]; then
    _nd_real=$(shadow_real_path "$_nd")
    [ -n "$_nd_real" ] && _nd=$(shadow_trim_dir "$_nd_real")
  fi
  printf '%s' "$_nd"
}

# The owning @pellux/goodvibes-* package for a resolved path, or nothing.
# The LAST node_modules segment is the one that owns the file: a nested
# node_modules/a/node_modules/b/bin/x belongs to b, not a. Another publisher's
# scope, or another package inside ours, is deliberately not ours.
shadow_owning_package() {
  printf '%s\n' "$1" | awk -F/ '{
    pkg = ""
    for (i = 1; i <= NF; i++) {
      if ($i != "node_modules") continue
      if ($(i + 1) == "@pellux" && index($(i + 2), "goodvibes-") == 1) pkg = $(i + 1) "/" $(i + 2)
      else pkg = ""
    }
    print pkg
  }'
}

# What `<path> --version` reports, but ONLY when the output is the exact shape
# every goodvibes command prints: "<command> <dotted numbers>". An unrelated
# program that happens to share the name, a wrapper script, or a --version that
# errors all yield nothing, which keeps that copy unidentified and therefore
# never a removal candidate.
shadow_version_of() {
  shadow_version_line=$(shadow_run_version "$1")
  printf '%s\n' "$shadow_version_line" | awk -v cmd="$2" '
    NF == 2 && $1 == cmd {
      v = $2
      sub(/^v/, "", v)
      if (v ~ /^[0-9]+(\.[0-9]+)*([-+][0-9A-Za-z.-]+)?$/) print v
    }'
}

# Runs the candidate with --version, bounded by `timeout` when the host has it
# so a hung or interactive binary cannot stall the install. This runs the same
# file the user's very next bare command would run, with the most harmless
# argument there is.
shadow_run_version() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 10 "$1" --version 2>/dev/null | head -1
  else
    "$1" --version 2>/dev/null | head -1
  fi
}

# True when $1 is inside $2 (or is $2 itself). Nothing outside the user's own
# home is ever a removal candidate, however confidently we recognise it.
shadow_is_within() {
  shadow_within_root=$(shadow_trim_dir "$2")
  [ -n "$shadow_within_root" ] || return 1
  shadow_within_path=$(shadow_trim_dir "$1")
  [ "$shadow_within_path" = "$shadow_within_root" ] && return 0
  case "$shadow_within_path" in
    "$shadow_within_root"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# The removal plan for a shadowing copy, as "<kind>\t<detail>", or nothing when
# the copy is not recognisably one of our programs. Two recognised kinds:
#   package <pkg>   an entry resolving into an installed @pellux/goodvibes-*
#                   package (a bun/npm global link or a dependency link)
#   file <path>     a standalone file that answers --version as this command,
#                   i.e. an earlier standalone install of the same program
shadow_removal_plan() {
  shadow_plan_path=$1
  shadow_plan_command=$2
  shadow_plan_resolved=$(shadow_real_path "$shadow_plan_path")

  shadow_is_within "$shadow_plan_path" "$HOME" || return 0
  shadow_is_within "$shadow_plan_resolved" "$HOME" || return 0

  shadow_plan_package=$(shadow_owning_package "$shadow_plan_resolved")
  if [ -n "$shadow_plan_package" ]; then
    printf 'package\t%s\n' "$shadow_plan_package"
    return 0
  fi

  if [ -n "$(shadow_version_of "$shadow_plan_path" "$shadow_plan_command")" ]; then
    printf 'file\t%s\n' "$shadow_plan_path"
  fi
}

# The exact command that removes a recognised copy. A package link is removed
# by uninstalling the package that provides it — with the manager that owns it,
# read from where the package actually lives — never by deleting the link,
# which the next command of that package manager would put straight back.
shadow_removal_command() {
  case "$1" in
    package)
      shadow_cmd_resolved=$(shadow_real_path "$3")
      case "$shadow_cmd_resolved" in
        */.bun/install/global/*|"$HOME"/.bun/*) printf 'bun remove -g %s\n' "$2" ;;
        *) printf 'npm rm -g %s\n' "$2" ;;
      esac
      ;;
    file) printf 'rm %s\n' "$2" ;;
  esac
}

# Asks on the terminal, when there is one. `curl … | sh` leaves stdin pointing
# at the script itself, so the question and the answer both go through
# /dev/tty; with no terminal at all (a headless/service-managed run, CI, a
# detached `curl | sh`) the safe default is to remove nothing and report.
shadow_confirm() {
  case "$SHADOW_REMOVE" in
    1) return 0 ;;
    0) return 1 ;;
  esac
  # A stat-based readable/writable check on /dev/tty is NOT sufficient proof
  # that a controlling terminal exists: the device node's own permission bits
  # (crw-rw-rw-, world read/write) pass that check even on a completely
  # headless run — only actually OPENING it fails there, with ENXIO ("No such
  # device or address"). Live incident: exactly that ENXIO surfaced on a
  # headless run, and the failed write was not caught as the CONDITION of an
  # `if` — it fell straight through to the read/prompt below and eventually
  # to the installer's non-zero exit, well after the binaries were already
  # correctly installed. Both directions are attempted as the condition of an
  # `if` here, so a headless run takes the safe non-interactive default (leave
  # the copy in place, say so) instead of failing the whole install over a
  # step nobody could have answered.
  #
  # `true`, not `:` — `:` is a POSIX SPECIAL builtin, and a redirection
  # failure on a special builtin is fatal to a non-interactive shell
  # UNCONDITIONALLY, bypassing the usual set -e exemptions for an if-condition
  # or a `!` negation entirely: `if ! { : > /dev/tty; }; then ...` still
  # killed the whole script on the open failure. `true` is an ORDINARY
  # builtin, so its redirection failure is just a normal command failure,
  # properly exempted here.
  if ! { true > /dev/tty; } 2>/dev/null || ! { true < /dev/tty; } 2>/dev/null; then
    SHADOW_HEADLESS_UNCONFIRMED=1
    say "  (no terminal available to ask — leaving this copy in place for now;"
    say "   re-run this installer interactively, or set GOODVIBES_SHADOW_REMOVE=1, to remove it.)"
    return 1
  fi
  printf '%s [y/N] ' "$1" > /dev/tty 2>/dev/null || return 1
  read -r shadow_answer < /dev/tty 2>/dev/null || return 1
  case "$shadow_answer" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

# Zero-based PATH position of a directory, or nothing when it is not on PATH.
shadow_path_index() {
  shadow_path_entries | awk -v want="$1" '{ if ($0 == want) { print NR - 1; exit } }'
}

# Every copy of $1 on PATH, as "<index>\t<path>", in search order.
shadow_copies_of() {
  shadow_copies_command=$1
  shadow_path_entries | awk -v cmd="$shadow_copies_command" '{ print (NR - 1) "\t" $0 "/" cmd }' \
    | while IFS='	' read -r shadow_copy_index shadow_copy_path; do
        if [ -f "$shadow_copy_path" ] && [ -x "$shadow_copy_path" ]; then
          printf '%s\t%s\n' "$shadow_copy_index" "$shadow_copy_path"
        fi
      done
}

# Reports and, where recognised and allowed, resolves shadowing copies of one
# command. Returns 0 when the maintained copy is reachable afterwards, 1 when a
# shadow remains.
check_command_shadowing() {
  shadow_command=$1
  shadow_install_dir=$(shadow_trim_dir "$INSTALL_DIR")
  shadow_target="$shadow_install_dir/$shadow_command"

  # Nothing installed under this name here: not ours to have an opinion about.
  [ -f "$shadow_target" ] && [ -x "$shadow_target" ] || return 0

  # shadow_path_entries now prints NORMALIZED directories (see
  # shadow_normalize_dir), so the index lookup must query with the same
  # normalized form — otherwise "$INSTALL_DIR" (unnormalized) could fail to
  # match its own normalized entry and look absent from PATH entirely.
  shadow_install_index=$(shadow_path_index "$(shadow_normalize_dir "$INSTALL_DIR")")
  if [ -z "$shadow_install_index" ]; then
    say ""
    say "PROBLEM: $shadow_target is installed, but $shadow_install_dir is not on your PATH,"
    say "         so typing \"$shadow_command\" does not reach it."
    say "         Add it to your PATH, or run it by full path: $shadow_target"
    return 1
  fi

  shadow_found=0
  shadow_remaining=0
  shadow_copies=$(shadow_copies_of "$shadow_command")

  # Nothing to say while the maintained copy is the first one on PATH.
  shadow_earlier=$(printf '%s\n' "$shadow_copies" | awk -F'\t' -v limit="$shadow_install_index" '
    NF == 2 && $1 + 0 < limit + 0 { print $2 }')
  [ -n "$shadow_earlier" ] || return 0

  shadow_installed_version=$(shadow_version_of "$shadow_target" "$shadow_command")
  [ -n "$shadow_installed_version" ] || shadow_installed_version="unknown"

  shadow_winner=$(printf '%s\n' "$shadow_earlier" | head -1)
  shadow_winner_version=$(shadow_version_of "$shadow_winner" "$shadow_command")
  [ -n "$shadow_winner_version" ] || shadow_winner_version="unknown"

  say ""
  say "PROBLEM: typing \"$shadow_command\" does not run the copy this installer maintains."
  say "         wins on PATH: $shadow_winner (version $shadow_winner_version)"
  say "         installed here: $shadow_target (version $shadow_installed_version)"

  # One newline-separated list, one pass, no subshell — so the counters below
  # survive the loop in a POSIX shell.
  shadow_ifs_backup=$IFS
  IFS='
'
  for shadow_copy in $shadow_earlier; do
    IFS=$shadow_ifs_backup

    # Belt and braces on top of shadow_path_entries' own normalization: even
    # if some PATH shape slipped past directory-level normalization (a
    # symlinked ancestor the no-readlink-f fallback cannot fully chase, etc.),
    # a copy that resolves to the EXACT SAME real file as the one this
    # installer maintains is not a shadow — it is the same binary reached
    # through a different spelling — and must never be offered for deletion.
    shadow_copy_real=$(shadow_real_path "$shadow_copy")
    shadow_target_real=$(shadow_real_path "$shadow_target")
    if [ -n "$shadow_copy_real" ] && [ "$shadow_copy_real" = "$shadow_target_real" ]; then
      IFS='
'
      continue
    fi

    shadow_found=1
    shadow_copy_version=$(shadow_version_of "$shadow_copy" "$shadow_command")
    [ -n "$shadow_copy_version" ] || shadow_copy_version="unknown"
    shadow_plan=$(shadow_removal_plan "$shadow_copy" "$shadow_command")
    if [ -z "$shadow_plan" ]; then
      say ""
      say "  $shadow_copy (version $shadow_copy_version) is not something we can identify as"
      say "  one of our programs, so it will not be touched. Remove it yourself, or put"
      say "  $shadow_install_dir earlier on your PATH."
      shadow_remaining=1
      IFS='
'
      continue
    fi

    shadow_kind=$(printf '%s' "$shadow_plan" | cut -f1)
    shadow_detail=$(printf '%s' "$shadow_plan" | cut -f2)
    shadow_fix=$(shadow_removal_command "$shadow_kind" "$shadow_detail" "$shadow_copy")
    say ""
    say "  $shadow_copy (version $shadow_copy_version) is a copy of our own program."
    say "  Remove it with: $shadow_fix"

    SHADOW_HEADLESS_UNCONFIRMED=0
    if shadow_confirm "  Remove it now?"; then
      # shadow_confirm only ever returns true via SHADOW_REMOVE=1 or a real
      # 'yes' typed at a real terminal, so SHADOW_HEADLESS_UNCONFIRMED is
      # always 0 here — a failed removal in this branch is a genuine failure.
      if run_shadow_removal "$shadow_kind" "$shadow_detail" "$shadow_fix"; then
        say "  removed     $shadow_copy"
      else
        say "  could not run: $shadow_fix"
        shadow_remaining=1
      fi
    elif [ "$SHADOW_HEADLESS_UNCONFIRMED" = "1" ]; then
      : # already explained by shadow_confirm; left in place, but not a
        # failure to blame on this (unattended) run — see the final gate below
    else
      shadow_remaining=1
    fi
    IFS='
'
  done
  IFS=$shadow_ifs_backup

  [ "$shadow_found" = "1" ] || return 0

  # Re-check rather than trusting the removal: the only thing that settles this
  # is whether an earlier copy is still there.
  shadow_still=$(shadow_copies_of "$shadow_command" | awk -F'\t' -v limit="$shadow_install_index" '
    NF == 2 && $1 + 0 < limit + 0 { print $2 }')
  if [ "$shadow_remaining" = "1" ]; then
    return 1
  fi
  if [ -n "$shadow_still" ]; then
    # Something is still there, but every reason it wasn't removed was "no
    # terminal to ask" (never a decline, an unidentified copy, or a failed
    # removal — those all set shadow_remaining above). A headless/unattended
    # run cannot be blamed for skipping a step nobody could have answered:
    # report it honestly (already done above) and let the install succeed.
    say "  \"$shadow_command\" could not be fully resolved without a terminal to confirm removal —"
    say "  re-run this installer interactively, or set GOODVIBES_SHADOW_REMOVE=1, to finish this."
    return 0
  fi
  say "  \"$shadow_command\" now runs $shadow_target"
  return 0
}

# Runs one removal. A package link is removed through its package manager; a
# standalone file is deleted, and only after re-checking that it is still
# inside the user's home directory.
run_shadow_removal() {
  case "$1" in
    package)
      shadow_manager=$(printf '%s' "$3" | awk '{ print $1 }')
      command -v "$shadow_manager" >/dev/null 2>&1 || return 1
      # shellcheck disable=SC2086
      $3 >/dev/null 2>&1 || return 1
      return 0
      ;;
    file)
      shadow_is_within "$2" "$HOME" || return 1
      rm -f "$2" || return 1
      return 0
      ;;
  esac
  return 1
}

# The whole-install verdict, run after everything is placed.
resolve_path_shadows() {
  SHADOW_PATH=$(shadow_effective_path)
  for shadow_each in goodvibes goodvibes-daemon goodvibes-agent; do
    if ! check_command_shadowing "$shadow_each"; then
      PATH_SHADOW_UNRESOLVED=1
    fi
  done
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
  # The comment above promised foreign processes were "left alone and
  # reported"; they were left alone but never reported, so an uninstall that
  # deliberately skipped another install's daemon looked identical to one that
  # found nothing at all.
  report_foreign_processes "$pattern" "$label"
  pids=$(pids_owned_by_install "$pattern")
  [ -n "$pids" ] || return 0
  for pid in $pids; do
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
      # The product's in-app plist becomes installer-marker-managed once a
      # migration regenerates it — cover it too (marker-gated, like the rest).
      uninstall_launchd_agent goodvibes "$(launchd_product_plist_path)"
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

  # The browser driver the installer extracts beside goodvibes-agent, plus the
  # copy /update parks when it refreshes it. The agent's own self-installed
  # driver lives under ~/.goodvibes and is user data, so it is preserved along
  # with everything else there.
  for driver_dir in "$INSTALL_DIR/playwright-core" "$INSTALL_DIR/playwright-core.previous"; do
    [ -d "$driver_dir" ] || continue
    rm -rf "$driver_dir"
    say "  removed    $driver_dir"
    record_removed "$driver_dir"
  done

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

  # Same ordering reason: put the wake-word model on disk before the daemon is
  # (re)started, so the started process finds it verified and the feature is
  # usable the moment voice.wake.enabled is turned on. A daemon that starts
  # first would fetch it itself at boot; doing it here means the install's own
  # output says whether it worked.
  install_wake_word_model

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

  # Everything is placed; now find out whether any of it is reachable. This
  # runs last on purpose — it inspects the files that were just installed,
  # including the agent — and it is the last word on whether the install
  # succeeded, because a copy the shell never runs is not an install.
  resolve_path_shadows
  if [ "$PATH_SHADOW_UNRESOLVED" = "1" ]; then
    say ""
    say "Install FAILED to become reachable: another copy earlier on your PATH still"
    say "answers one or more of these commands. Until that is resolved, upgrading here"
    say "changes nothing you can run. Fix the copies named above, then re-run this"
    say "installer. To run this install directly in the meantime: $INSTALL_DIR/goodvibes"
    exit 3
  fi

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
