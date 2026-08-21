# Windows support

## Supported today: WSL2

The supported way to run GoodVibes on Windows **right now** is
[WSL2](https://learn.microsoft.com/windows/wsl/install) (Windows Subsystem for
Linux). Inside a WSL2 distribution GoodVibes is an ordinary Linux install, so
the Linux release binaries and every code path apply unchanged:

```sh
# in a WSL2 shell (Ubuntu, Debian, etc.)
curl -fsSL https://goodvibes.sh/install.sh | sh
# or, with Bun already installed:
bun add -g @pellux/goodvibes-tui
bun pm trust -g @pellux/goodvibes-tui goodvibes-daemon
```

The `linux-x64` (or `linux-arm64`) binaries run natively in WSL2. This is the
recommended path for all Windows users and requires no beta artifacts.

## Native Windows: beta, not yet promoted

A native `windows-x64` binary **compiles** today: `bun build --compile
--target=bun-windows-x64` produces a working `goodvibes-windows-x64.exe`
(PE32+). It is built and smoke-tested by a **separate, non-gating** workflow
(`.github/workflows/windows-beta.yml`, `workflow_dispatch`), deliberately kept
out of the release gate until the smoke job is reliably green and the blockers
below are resolved. That workflow's Windows-runner smoke job is a real
pass/fail check (never `continue-on-error`); a green run there is the signal to
promote `windows-x64` into the release matrix.

Until then, native Windows artifacts are **not** attached to stable GitHub
Releases, and there is no PowerShell installer (see "Deferred" below).

## POSIX assumptions blocking promotion

These are the concrete reasons native Windows is beta rather than supported.
Each must be addressed (or explicitly gated off on Windows) before promotion:

1. **Exec layer `/bin/sh` dependency.** Several command paths spawn a POSIX
   shell directly, e.g. `Bun.spawn(['/bin/sh', '-c', command], …)` in the
   scriptable statusline (`src/core/scriptable-statusline.ts`), the diff
   commands (`src/input/commands/diff-runtime.ts`,
   `src/panels/diff-panel.ts`), and the SDK's WRFC gates
   (`platform/agents/wrfc-gates.js`). `/bin/sh` does not exist on native
   Windows; these need a `cmd.exe`/PowerShell branch or a shell abstraction.

2. **Daemon service lifecycle.** The daemon's service manager
   (`platform/daemon/service-manager.js`) selects `systemd` on Linux and
   `launchd` on macOS. It has a `windows` branch, but the install/start/stop
   flow is exercised and verified only against systemd; the Windows Service
   path (SCM registration, service account, log routing) is unverified.

3. **Terminal restore / raw-mode paths.** The TUI puts stdin into raw mode
   (`stdin.setRawMode(true)` in `src/main.ts`) and restores terminal state on
   exit. The raw-mode entry/exit and signal-driven restore are validated on
   POSIX TTYs; Windows console (conhost / Windows Terminal) mode handling and
   cleanup-on-crash are unverified.

4. **Launcher rejects win32.** `bin/goodvibes` in this repository
   short-circuits with an error on `process.platform === 'win32'` and points at
   WSL; the daemon's own launcher, in the separate `goodvibes-daemon`
   repository, does the same. This is intentional today; promoting native
   Windows means teaching both launchers to resolve and run the `.exe` (and
   adding a `windows-x64` platform binary package for each).

## Promotion criteria

- `windows-beta.yml`'s Windows-runner smoke job is green across runs
  (`--version` on the built `.exe`).
- Blockers 1–4 above are resolved or explicitly disabled on Windows with a
  clear degraded-capability message.
- A `windows-x64` entry is added to the release matrix and to the platform
  binary package set (`@pellux/goodvibes-tui-win32-x64`), and the launchers
  learn the Windows path.

## Deferred: PowerShell installer

`scripts/install.ps1` (a PowerShell twin of the suite installer,
`goodvibes-daemon` `scripts/install.sh`) is
**deferred**. Although the `windows-x64` exe compiles, it is not published as a
stable release asset and its Windows runtime is unverified, so an installer
that downloads and runs it would be installing an unverified beta from assets
that stable releases do not carry. The twin will land together with the
release-matrix promotion, once `windows-beta.yml`'s smoke job is green and the
`.exe` is a first-class release asset.
