import { afterAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { buildManagedDaemonServiceManager } from '../../runtime/legacy-daemon-migration.ts';
import { resolveRuntimeEndpointBinding } from '../../cli/endpoints.ts';

// Shell-level coverage for the two installer features added in this file:
//   1. first-run daemon service setup (systemd unit / launchd plist generation,
//      opt-out, never-overwrite), and
//   2. uninstall mode (installer-managed removal vs hand-written preservation,
//      ~/.goodvibes preservation, summary output).
//
// The script is sourced as a library (GOODVIBES_INSTALL_SH_LIB=1) so individual
// functions run WITHOUT a network install. Every test uses a scratch HOME +
// GOODVIBES_INSTALL_DIR, and any test whose code path could shell out to a
// service manager runs with a stub `systemctl`/`launchctl` prepended to PATH,
// so a real host's services are never touched.

const INSTALL_SH = join(import.meta.dir, '../../../scripts/install.sh');
const created: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  created.push(dir);
  return dir;
}

/** The loginctl stub shared by both stub bin dirs. Linger state lives in
 * $STUB_LINGER_STATE_FILE so tests can exercise all three real outcomes:
 * `show-user` answers Linger=yes only when the state file says so;
 * `enable-linger` records it unless $STUB_LINGER_DENY=1 simulates a polkit
 * denial (exits 1 without recording). With neither env var set the stub
 * behaves as "cannot enable" — show-user always says Linger=no — so a test
 * that ignores lingering deterministically gets the honest fallback path
 * instead of reaching the real host's loginctl. */
const LOGINCTL_STUB = [
  '#!/bin/sh',
  'case "$*" in',
  '  *show-user*)',
  '    if [ -n "$STUB_LINGER_STATE_FILE" ] && grep -q yes "$STUB_LINGER_STATE_FILE" 2>/dev/null; then',
  "    printf 'Linger=yes\\n'",
  '    else',
  "    printf 'Linger=no\\n'",
  '    fi',
  '    exit 0',
  '    ;;',
  '  *enable-linger*)',
  '    [ "$STUB_LINGER_DENY" = "1" ] && exit 1',
  '    [ -n "$STUB_LINGER_STATE_FILE" ] && printf \'yes\\n\' > "$STUB_LINGER_STATE_FILE"',
  '    exit 0',
  '    ;;',
  '  *)',
  '    exit 0',
  '    ;;',
  'esac',
  '',
].join('\n');

/** Write a stub bin dir whose systemctl/launchctl are inert no-ops, so a
 * service-touching code path can be exercised without reaching the real host.
 * `is-active` reports inactive (exit 3); `cat` reports "no such unit" (exit 1),
 * so unit detection falls back to the scratch file on disk; everything else
 * exits 0. loginctl is stubbed too (see LOGINCTL_STUB) so the linger path
 * never touches the host. */
function stubServiceBin(root: string): string {
  const bin = join(root, 'stubbin');
  mkdirSync(bin, { recursive: true });
  const stub = [
    '#!/bin/sh',
    'for a in "$@"; do',
    '  case "$a" in',
    // is-active prints a recognized final state: the installer's tri-state
    // unit_active_state treats exit 3 WITHOUT parseable output as UNKNOWN
    // (bus unreachable) and refuses all action — this stub means "definitely
    // inactive", so it must say so.
    "    is-active) printf 'inactive\\n'; exit 3 ;;",
    '    cat) exit 1 ;;',
    '  esac',
    'done',
    'exit 0',
    '',
  ].join('\n');
  for (const name of ['systemctl', 'launchctl']) {
    const path = join(bin, name);
    writeFileSync(path, stub);
    chmodSync(path, 0o755);
  }
  const loginctlPath = join(bin, 'loginctl');
  writeFileSync(loginctlPath, LOGINCTL_STUB);
  chmodSync(loginctlPath, 0o755);
  return bin;
}

/** Write a stateful stub bin dir whose systemctl/launchctl track an
 * active/inactive state in $STUB_STATE_FILE and answer ExecStart lookups
 * with $STUB_EXEC_BIN, so the broken-unit detection/replacement path in
 * restart_systemd_unit can be exercised deterministically: is-active
 * reflects the state file; disable/stop flip it to inactive; enable/restart
 * flip it back to active; show -p ExecStart --value prints the systemd
 * `{ path=... ; argv[]=... ; }` structure with $STUB_EXEC_BIN as the path;
 * cat reports "no such unit" so detection falls back to the file on disk. */
function stubStatefulServiceBin(root: string): string {
  const bin = join(root, 'stubbin-stateful');
  mkdirSync(bin, { recursive: true });
  const stub = [
    '#!/bin/sh',
    'args="$*"',
    'case "$args" in',
    '  *"is-active"*)',
    '    if [ -f "$STUB_STATE_FILE" ] && grep -q inactive "$STUB_STATE_FILE" 2>/dev/null; then',
    "      printf 'inactive\\n'",
    '      exit 3',
    '    fi',
    "    printf 'active\\n'",
    '    exit 0',
    '    ;;',
    '  *"show"*"ExecStart"*)',
    "    printf '{ path=%s ; argv[]=%s ; }\\n' \"$STUB_EXEC_BIN\" \"$STUB_EXEC_BIN\"",
    '    exit 0',
    '    ;;',
    '  *"cat"*)',
    '    exit 1',
    '    ;;',
    '  *"disable"*|*"stop"*)',
    '    [ -n "$STUB_STATE_FILE" ] && printf \'inactive\\n\' > "$STUB_STATE_FILE"',
    '    exit 0',
    '    ;;',
    '  *"enable"*|*"restart"*)',
    '    [ -n "$STUB_STATE_FILE" ] && printf \'active\\n\' > "$STUB_STATE_FILE"',
    '    exit 0',
    '    ;;',
    '  *)',
    '    exit 0',
    '    ;;',
    'esac',
    '',
  ].join('\n');
  for (const name of ['systemctl', 'launchctl']) {
    const path = join(bin, name);
    writeFileSync(path, stub);
    chmodSync(path, 0o755);
  }
  const loginctlPath = join(bin, 'loginctl');
  writeFileSync(loginctlPath, LOGINCTL_STUB);
  chmodSync(loginctlPath, 0o755);
  return bin;
}

/** Write a stub bin dir whose systemctl tracks INDEPENDENT per-unit state for
 * the canonical goodvibes.service ($STUB_CANON_STATE_FILE) and the legacy
 * goodvibes-daemon.service ($STUB_LEGACY_STATE_FILE), so the supervised
 * transfer in migrate_legacy_systemd_unit can be exercised end to end:
 * is-active answers per unit from its state file; enable/start flip the unit
 * active (or fail when $STUB_CANON_START_FAILS=1 targets the canonical unit);
 * disable/stop flip it inactive (or fail when $STUB_DISABLE_FAILS=1);
 * show -p MainPID --value answers $STUB_CANON_MAINPID/$STUB_LEGACY_MAINPID
 * (default 0). launchctl records every invocation to $STUB_LAUNCHCTL_LOG. */
function stubDualUnitServiceBin(root: string): string {
  const bin = join(root, 'stubbin-dual');
  mkdirSync(bin, { recursive: true });
  const systemctlStub = [
    '#!/bin/sh',
    '[ -n "$STUB_SYSTEMCTL_LOG" ] && printf \'%s\\n\' "$*" >> "$STUB_SYSTEMCTL_LOG"',
    'unit=""',
    'verb=""',
    'for a in "$@"; do',
    '  case "$a" in',
    '    goodvibes.service) unit="canon" ;;',
    '    goodvibes-daemon.service) unit="legacy" ;;',
    '    goodvibes-agent.service) unit="agent" ;;',
    '    is-active|is-enabled|enable|disable|start|stop|daemon-reload|cat|show|status) [ -z "$verb" ] && verb="$a" ;;',
    '  esac',
    'done',
    'state_file() {',
    '  case "$unit" in',
    '    canon) printf %s "$STUB_CANON_STATE_FILE" ;;',
    '    legacy) printf %s "$STUB_LEGACY_STATE_FILE" ;;',
    '    *) printf %s "" ;;',
    '  esac',
    '}',
    'case "$verb" in',
    '  is-active)',
    '    f=$(state_file)',
    '    if [ -n "$f" ] && grep -qx active "$f" 2>/dev/null; then',
    "      printf 'active\\n'",
    '      exit 0',
    '    fi',
    '    if [ -n "$f" ] && grep -qx activating "$f" 2>/dev/null; then',
    "      printf 'activating\\n'",
    '    exit 3',
    '    fi',
    '    if [ -n "$f" ] && grep -qx inactive "$f" 2>/dev/null; then',
    "      printf 'inactive\\n'",
    '      exit 3',
    '    fi',
    // Unit does not exist (no state staged): modern systemd answers
    // 'inactive' rc 4 (LSB "no such unit"); old systemd answered rc 3.
    // STUB_MISSING_UNIT_RC pins which vocabulary a test exercises.
    "    printf 'inactive\\n'",
    '    exit "${STUB_MISSING_UNIT_RC:-4}" ;;',
    '  is-enabled)',
    '    if [ "$unit" = "canon" ] && [ "$STUB_CANON_PRE_ENABLED" = "1" ]; then',
    "      printf 'enabled\\n'",
    '      exit 0',
    '    fi',
    "    printf 'disabled\\n'",
    '    exit 1 ;;',
    '  status)',
    // Unit-for-pid lookup: `systemctl [--user] status <pid>` — answer with a
    // .service headline for the staged pid (ANY unit name, per the general
    // supervision check), exit 4 (no unit for pid) otherwise.
    '    for a in "$@"; do',
    '      if [ -n "$STUB_PID_UNIT_PID" ] && [ "$a" = "$STUB_PID_UNIT_PID" ]; then',
    '        printf \'* %s - stub unit\\n\' "${STUB_PID_UNIT_NAME:-goodvibes-daemon.service}"',
    '        exit 0',
    '      fi',
    '    done',
    '    exit 4 ;;',
    '  show)',
    '    case "$*" in',
    '      *MainPID*)',
    '        case "$unit" in',
    '          canon) printf \'%s\\n\' "${STUB_CANON_MAINPID:-0}" ;;',
    '          legacy) printf \'%s\\n\' "${STUB_LEGACY_MAINPID:-0}" ;;',
    '          *) printf \'%s\\n\' "${STUB_AGENT_MAINPID:-0}" ;;',
    '        esac',
    '        exit 0 ;;',
    '      *ExecStart*)',
    "        printf '{ path=%s ; argv[]=%s ; }\\n' \"$STUB_EXEC_BIN\" \"$STUB_EXEC_BIN\"",
    '        exit 0 ;;',
    '    esac',
    '    exit 0 ;;',
    '  cat) exit 1 ;;',
    '  enable|start)',
    '    [ "$STUB_CANON_START_FAILS" = "1" ] && [ "$unit" = "canon" ] && exit 1',
    '    f=$(state_file); [ -n "$f" ] && printf \'active\\n\' > "$f"',
    '    exit 0 ;;',
    '  disable|stop)',
    '    [ "$STUB_DISABLE_FAILS" = "1" ] && exit 1',
    '    f=$(state_file); [ -n "$f" ] && printf \'inactive\\n\' > "$f"',
    '    exit 0 ;;',
    '  *) exit 0 ;;',
    'esac',
    '',
  ].join('\n');
  writeFileSync(join(bin, 'systemctl'), systemctlStub);
  chmodSync(join(bin, 'systemctl'), 0o755);
  const launchctlStub = [
    '#!/bin/sh',
    '[ -n "$STUB_LAUNCHCTL_LOG" ] && printf \'%s\\n\' "$*" >> "$STUB_LAUNCHCTL_LOG"',
    'case "$1" in',
    '  print)',
    // 113 = launchd's could-not-find-service (affirmatively not loaded);
    // 64 = 'Bad request' (gui domain unreachable, e.g. over ssh) — cannot-ask.
    '    [ "$STUB_LAUNCHCTL_PRINT_FAILS" = "1" ] && exit 113',
    '    [ "$STUB_LAUNCHCTL_PRINT_BADREQ" = "1" ] && exit 64',
    '    [ -n "$STUB_LAUNCHD_DAEMON_PID" ] && printf \'    pid = %s\\n\' "$STUB_LAUNCHD_DAEMON_PID"',
    '    exit 0 ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(join(bin, 'launchctl'), launchctlStub);
  chmodSync(join(bin, 'launchctl'), 0o755);
  const loginctlPath = join(bin, 'loginctl');
  writeFileSync(loginctlPath, LOGINCTL_STUB);
  chmodSync(loginctlPath, 0o755);
  return bin;
}

/** A stub bin dir whose systemctl ALWAYS fails — the no-user-bus shape (plain
 * env-stripped session): every disable/stop/is-active exits 1. */
function stubBuslessServiceBin(root: string): string {
  const bin = join(root, 'stubbin-busless');
  mkdirSync(bin, { recursive: true });
  const stub = '#!/bin/sh\nexit 1\n';
  for (const name of ['systemctl', 'launchctl']) {
    const path = join(bin, name);
    writeFileSync(path, stub);
    chmodSync(path, 0o755);
  }
  const loginctlPath = join(bin, 'loginctl');
  writeFileSync(loginctlPath, LOGINCTL_STUB);
  chmodSync(loginctlPath, 0o755);
  return bin;
}

/** Source install.sh as a library and run `body`, returning combined output. */
function runLib(body: string, env: Record<string, string>): { stdout: string; stderr: string; code: number } {
  const script = `. "${INSTALL_SH}"\nresolve_platform\n${body}\n`;
  const result = Bun.spawnSync(['sh', '-c', script], {
    env: { ...process.env, GOODVIBES_INSTALL_SH_LIB: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    code: result.exitCode ?? -1,
  };
}

afterAll(() => {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('install.sh — systemd unit generation', () => {
  test('write_systemd_unit emits an installer-managed unit with the expected structure', () => {
    const root = scratch('gv-unit');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(installDir, { recursive: true });

    const unitPath = join(home, '.config/systemd/user/goodvibes.service');
    const out = runLib(`write_systemd_unit "${unitPath}"`, { HOME: home, GOODVIBES_INSTALL_DIR: installDir });
    expect(out.code).toBe(0);
    expect(existsSync(unitPath)).toBe(true);

    const unit = readFileSync(unitPath, 'utf-8');
    // Installer-managed marker (the uninstall path keys on this exact string).
    expect(unit).toContain('# managed by goodvibes install.sh');
    // ExecStart mirrors what the product's own service setup writes: the daemon
    // binary plus --daemon-home ONLY. No endpoint flags are baked — the daemon
    // resolves controlPlane.hostMode/host/port from settings at boot, so a
    // configured endpoint is never silently re-pinned by an upgrade. The
    // path-valued words are systemd-quoted so a HOME/INSTALL_DIR containing a
    // space cannot silently split into stray arguments.
    expect(unit).toContain(`ExecStart="${installDir}/goodvibes-daemon" --daemon-home "${home}"`);
    expect(unit).not.toContain('--hostname');
    expect(unit).not.toContain('--port');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toMatch(/\[Unit\][\s\S]*\[Service\][\s\S]*\[Install\]/);
    // The start-rate limiter is disabled regardless of systemd version, so a
    // crash-looping daemon keeps retrying instead of tombstoning permanently.
    expect(unit).toContain('StartLimitIntervalSec=0');
  });

  test('systemd >= 254 gets escalating restart delays (RestartSteps/RestartMaxDelaySec)', () => {
    const root = scratch('gv-unit-254');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(installDir, { recursive: true });

    const unitPath = join(home, '.config/systemd/user/goodvibes-daemon.service');
    // Version pinned explicitly — the unit shape under test must not depend on
    // whatever systemd the host running the suite happens to have.
    const out = runLib(`write_systemd_unit "${unitPath}" 254`, { HOME: home, GOODVIBES_INSTALL_DIR: installDir });
    expect(out.code).toBe(0);

    const unit = readFileSync(unitPath, 'utf-8');
    expect(unit).toContain('StartLimitIntervalSec=0');
    expect(unit).toContain('RestartSec=2');
    expect(unit).toContain('RestartSteps=8');
    expect(unit).toContain('RestartMaxDelaySec=300');
  });

  test('systemd < 254 degrades to the flat RestartSec retry (no unsupported directives)', () => {
    const root = scratch('gv-unit-253');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(installDir, { recursive: true });

    const unitPath = join(home, '.config/systemd/user/goodvibes-daemon.service');
    const out = runLib(`write_systemd_unit "${unitPath}" 253`, { HOME: home, GOODVIBES_INSTALL_DIR: installDir });
    expect(out.code).toBe(0);

    const unit = readFileSync(unitPath, 'utf-8');
    // StartLimitIntervalSec=0 predates 254 by years and stays; the 254-only
    // escalation directives are omitted rather than emitted-and-ignored.
    expect(unit).toContain('StartLimitIntervalSec=0');
    expect(unit).toContain('RestartSec=2');
    expect(unit).not.toContain('RestartSteps=');
    expect(unit).not.toContain('RestartMaxDelaySec=');
  });

  test('a HOME or INSTALL_DIR containing a space is systemd-quoted — ExecStart never word-splits into stray args', () => {
    // Verifier probe: an unquoted spaced HOME made systemd hand the daemon a
    // truncated --daemon-home plus stray positional args (wrong data root),
    // and a spaced INSTALL_DIR made the unit unstartable.
    const root = scratch('gv-unit-spaces');
    const home = join(root, 'home with space');
    const installDir = join(root, 'bin dir');
    mkdirSync(installDir, { recursive: true });

    const unitPath = join(home, '.config/systemd/user/goodvibes.service');
    const out = runLib(`write_systemd_unit "${unitPath}"`, { HOME: home, GOODVIBES_INSTALL_DIR: installDir });
    expect(out.code).toBe(0);

    const unit = readFileSync(unitPath, 'utf-8');
    expect(unit).toContain(`ExecStart="${installDir}/goodvibes-daemon" --daemon-home "${home}"`);

    // When systemd-analyze is present, prove systemd parses the quoted words
    // as single tokens (the unquoted form failed verify with a truncated path).
    const analyze = Bun.spawnSync(['sh', '-c', 'command -v systemd-analyze']);
    if ((analyze.exitCode ?? 1) === 0) {
      const daemonBin = join(installDir, 'goodvibes-daemon');
      writeFileSync(daemonBin, '#!/bin/sh\nexit 0\n');
      chmodSync(daemonBin, 0o755);
      const verify = Bun.spawnSync(['systemd-analyze', 'verify', '--user', unitPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(verify.exitCode ?? -1).toBe(0);
    }
  });

  test('systemd-analyze verify accepts the generated unit (when available)', () => {
    const analyze = Bun.spawnSync(['sh', '-c', 'command -v systemd-analyze']);
    if ((analyze.exitCode ?? 1) !== 0) {
      // Structural assertions in the test above stand in where the tool is absent.
      return;
    }
    const root = scratch('gv-unit-verify');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(installDir, { recursive: true });
    // A real executable at ExecStart so verify has nothing to warn about.
    const daemonBin = join(installDir, 'goodvibes-daemon');
    writeFileSync(daemonBin, '#!/bin/sh\nexit 0\n');
    chmodSync(daemonBin, 0o755);

    const unitPath = join(home, '.config/systemd/user/goodvibes-daemon.service');
    runLib(`write_systemd_unit "${unitPath}"`, { HOME: home, GOODVIBES_INSTALL_DIR: installDir });

    const verify = Bun.spawnSync(['systemd-analyze', 'verify', '--user', unitPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // verify exits 0 on a structurally valid unit; any non-zero is a real defect.
    expect(verify.exitCode ?? -1).toBe(0);
  });
});

describe('install.sh — launchd plist generation', () => {
  test('write_launchd_plist emits an installer-managed LaunchAgent with the expected keys', () => {
    const root = scratch('gv-plist');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(installDir, { recursive: true });

    const plistPath = join(home, 'Library/LaunchAgents/sh.goodvibes.daemon.plist');
    const out = runLib(`write_launchd_plist "${plistPath}"`, { HOME: home, GOODVIBES_INSTALL_DIR: installDir });
    expect(out.code).toBe(0);

    const plist = readFileSync(plistPath, 'utf-8');
    expect(plist).toContain('managed by goodvibes install.sh');
    expect(plist).toContain('<key>GoodVibesManagedBy</key>');
    expect(plist).toContain('<string>sh.goodvibes.daemon</string>');
    expect(plist).toContain(`<string>${installDir}/goodvibes-daemon</string>`);
    // KeepAlive/SuccessfulExit=false is launchd's Restart=on-failure equivalent.
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>SuccessfulExit</key>');
  });
});

describe('install.sh — daemon survives without a login (lingering)', () => {
  function lingerSetup(prefix: string, env: Record<string, string>): { stdout: string; code: number } {
    const root = scratch(prefix);
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(installDir, { recursive: true });
    const out = runLib('setup_daemon_service_systemd', {
      HOME: home,
      GOODVIBES_INSTALL_DIR: installDir,
      PATH: `${stubStatefulServiceBin(root)}:${process.env.PATH ?? ''}`,
      STUB_STATE_FILE: join(root, 'stub-state'),
      STUB_EXEC_BIN: join(installDir, 'goodvibes-daemon'),
      ...env,
    });
    return { stdout: out.stdout, code: out.code };
  }

  test('lingering is enabled, VERIFIED via loginctl show-user, and the closing copy says "at boot"', () => {
    const root = scratch('gv-linger-state');
    const out = lingerSetup('gv-linger-on', { STUB_LINGER_STATE_FILE: join(root, 'linger-state') });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('lingering  enabled for');
    expect(out.stdout).toContain('The daemon starts at boot and restarts on failure.');
    expect(out.stdout).not.toContain('starts on login');
  });

  test('already-lingering users are recognized without re-enabling', () => {
    const root = scratch('gv-linger-pre-state');
    const stateFile = join(root, 'linger-state');
    writeFileSync(stateFile, 'yes\n');
    const out = lingerSetup('gv-linger-pre', { STUB_LINGER_STATE_FILE: stateFile });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('lingering  already enabled for');
    expect(out.stdout).toContain('The daemon starts at boot and restarts on failure.');
  });

  test('a polkit-style denial prints exactly one honest enable-linger instruction and says "on login"', () => {
    const out = lingerSetup('gv-linger-denied', { STUB_LINGER_DENY: '1' });
    expect(out.code).toBe(0);
    // The fallback names the exact command to run once — and only once.
    const mentions = out.stdout.split('loginctl enable-linger').length - 1;
    expect(mentions).toBe(1);
    expect(out.stdout).toContain('could not enable lingering');
    expect(out.stdout).toContain('The daemon starts on login and restarts on failure.');
    expect(out.stdout).not.toContain('starts at boot');
  });
});

describe('install.sh — first-run service setup guards', () => {
  test('GOODVIBES_DAEMON_SERVICE=0 skips setup, prints the manual command, and writes no unit', () => {
    const root = scratch('gv-optout');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(installDir, { recursive: true });

    const out = runLib('setup_daemon_service', {
      HOME: home,
      GOODVIBES_INSTALL_DIR: installDir,
      GOODVIBES_DAEMON_SERVICE: '0',
      // Stub on PATH so an unexpected systemctl call could not reach the host.
      PATH: `${stubServiceBin(root)}:${process.env.PATH ?? ''}`,
    });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('GOODVIBES_DAEMON_SERVICE=0');
    expect(out.stdout).toContain(`${installDir}/goodvibes-daemon`);
    expect(existsSync(join(home, '.config/systemd/user/goodvibes.service'))).toBe(false);
  });

  test('an existing unit is never overwritten (installer-managed or hand-written)', () => {
    const root = scratch('gv-existing');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    const unitDir = join(home, '.config/systemd/user');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });
    const unitPath = join(unitDir, 'goodvibes.service');
    const original = '[Service]\nExecStart=/somewhere/else/goodvibes-daemon\n';
    writeFileSync(unitPath, original);

    const out = runLib('setup_daemon_service_systemd', {
      HOME: home,
      GOODVIBES_INSTALL_DIR: installDir,
      PATH: `${stubServiceBin(root)}:${process.env.PATH ?? ''}`,
    });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('already exists');
    // Untouched: the pre-existing contents survive verbatim.
    expect(readFileSync(unitPath, 'utf-8')).toBe(original);
  });
});

describe('install.sh — canonical unit name + legacy-unit unification', () => {
  const MARKER = '# managed by goodvibes install.sh';

  test('fresh install writes only the canonical goodvibes.service (no legacy name), and migrate is a no-op', () => {
    const root = scratch('gv-fresh-canonical');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(installDir, { recursive: true });

    const out = runLib('setup_daemon_service_systemd; migrate_legacy_installer_unit', {
      HOME: home,
      GOODVIBES_INSTALL_DIR: installDir,
      PATH: `${stubServiceBin(root)}:${process.env.PATH ?? ''}`,
    });
    expect(out.code).toBe(0);

    const unitDir = join(home, '.config/systemd/user');
    // Exactly the canonical unit is on disk; the retired name never appears.
    expect(existsSync(join(unitDir, 'goodvibes.service'))).toBe(true);
    expect(existsSync(join(unitDir, 'goodvibes-daemon.service'))).toBe(false);

    const unit = readFileSync(join(unitDir, 'goodvibes.service'), 'utf-8');
    expect(unit).toContain(MARKER);
    expect(unit).toContain(`ExecStart="${installDir}/goodvibes-daemon" --daemon-home "${home}"`);
    expect(unit).not.toContain('--hostname');
    expect(unit).not.toContain('--port');
    // Nothing to migrate: no legacy retirement/transfer lines printed.
    expect(out.stdout).not.toContain('Retiring');
    expect(out.stdout).not.toContain('Transferring');
  });

  test('upgrade with an installer-managed legacy unit (both inactive): legacy is disabled + removed, canonical stays, and its INACTIVE state is stated honestly', () => {
    const root = scratch('gv-upgrade-legacy');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    const unitDir = join(home, '.config/systemd/user');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });

    // The canonical unit file is already in place (this is an upgrade) ...
    const canonical = join(unitDir, 'goodvibes.service');
    writeFileSync(canonical, `${MARKER}\n[Service]\nExecStart="${installDir}/goodvibes-daemon" --daemon-home "${home}" --hostname 127.0.0.1 --port 3421\n`);
    // ... alongside a leftover installer-managed legacy unit.
    const legacy = join(unitDir, 'goodvibes-daemon.service');
    writeFileSync(legacy, `${MARKER}\n[Service]\nExecStart=${installDir}/goodvibes-daemon\n`);

    // stubServiceBin reports every unit inactive, so this exercises the
    // neither-active branch: the inactive legacy unit is retired, and the
    // closing copy states the canonical unit's REAL (inactive) state instead
    // of the old false "keeps running" claim.
    const out = runLib('migrate_legacy_installer_unit', {
      HOME: home,
      GOODVIBES_INSTALL_DIR: installDir,
      PATH: `${stubServiceBin(root)}:${process.env.PATH ?? ''}`,
    });
    expect(out.code).toBe(0);

    // Legacy retired; canonical untouched.
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(canonical)).toBe(true);
    expect(out.stdout).toContain('Retiring the inactive installer-managed goodvibes-daemon.service');
    expect(out.stdout).toContain('disabled + removed');
    // Never claims the canonical unit is running when it is not.
    expect(out.stdout).not.toContain('keeps running');
    expect(out.stdout).toContain('present but not active');
    expect(out.stdout).toContain('systemctl --user start goodvibes.service');
  });

  test('a hand-written legacy unit (no marker) is left in place with an actionable notice', () => {
    const root = scratch('gv-upgrade-handwritten-legacy');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    const unitDir = join(home, '.config/systemd/user');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });

    const canonical = join(unitDir, 'goodvibes.service');
    writeFileSync(canonical, `${MARKER}\n[Service]\nExecStart="${installDir}/goodvibes-daemon" --daemon-home "${home}" --hostname 127.0.0.1 --port 3421\n`);
    // A hand-written legacy unit — no installer marker — must never be removed.
    const legacy = join(unitDir, 'goodvibes-daemon.service');
    const handWritten = '[Service]\nExecStart=/opt/custom/goodvibes-daemon\n';
    writeFileSync(legacy, handWritten);

    const out = runLib('migrate_legacy_installer_unit', {
      HOME: home,
      GOODVIBES_INSTALL_DIR: installDir,
      PATH: `${stubServiceBin(root)}:${process.env.PATH ?? ''}`,
    });
    expect(out.code).toBe(0);

    // Untouched, verbatim, and only reported.
    expect(existsSync(legacy)).toBe(true);
    expect(readFileSync(legacy, 'utf-8')).toBe(handWritten);
    expect(out.stdout).toContain('A hand-written goodvibes-daemon.service (no installer marker)');
    expect(out.stdout).toContain('is left in place');
    expect(out.stdout).not.toContain('Retiring');
  });
});

describe('install.sh — supervised transfer from an ACTIVE legacy unit (the dominant upgrade state)', () => {
  const MARKER = '# managed by goodvibes install.sh';

  interface TransferEnv {
    root: string;
    home: string;
    installDir: string;
    unitDir: string;
    legacyPath: string;
    canonicalPath: string;
    canonState: string;
    legacyState: string;
    env: Record<string, string>;
  }

  /** Stage: installer-managed legacy unit is the ONLY unit, ACTIVE; no canonical anywhere. */
  function stageLegacyOnlyActive(prefix: string): TransferEnv {
    const root = scratch(prefix);
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    const unitDir = join(home, '.config/systemd/user');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });

    const legacyPath = join(unitDir, 'goodvibes-daemon.service');
    writeFileSync(legacyPath, `${MARKER}\n[Service]\nExecStart=${installDir}/goodvibes-daemon\n`);

    const canonState = join(root, 'canon-state');
    const legacyState = join(root, 'legacy-state');
    writeFileSync(canonState, 'inactive\n');
    writeFileSync(legacyState, 'active\n');

    return {
      root, home, installDir, unitDir, legacyPath,
      canonicalPath: join(unitDir, 'goodvibes.service'),
      canonState, legacyState,
      env: {
        HOME: home,
        GOODVIBES_INSTALL_DIR: installDir,
        PATH: `${stubDualUnitServiceBin(root)}:${process.env.PATH ?? ''}`,
        STUB_CANON_STATE_FILE: canonState,
        STUB_LEGACY_STATE_FILE: legacyState,
        // The transfer's settled verify requires the canonical unit's MainPID
        // to be a LIVE, STABLE process across two probes — the test harness's
        // own pid is exactly that. Settle sleeps collapse to 0 for test speed.
        STUB_CANON_MAINPID: String(process.pid),
        GOODVIBES_INSTALL_VERIFY_SETTLE_SECS: '0',
      },
    };
  }

  test(
    'legacy unit is the ONLY unit and actively serving: the full upgrade flow transfers supervision atomically and converges',
    async () => {
      // The exact non-convergent incident chain the verifier reproduced: the
      // old flow SIGTERMed the supervised daemon, relaunched it via nohup
      // outside systemd, skipped writing the canonical unit, skipped the
      // migration, and left the enabled legacy unit behind for the next login.
      const t = stageLegacyOnlyActive('gv-transfer-active-legacy');

      // A real process supervised (per the stub) by the legacy unit: its
      // executable lives under $INSTALL_DIR, so the old bare-process fallback
      // would have SIGTERM'd + nohup'd it.
      copyFileSync('/bin/sleep', join(t.installDir, 'goodvibes-daemon'));
      chmodSync(join(t.installDir, 'goodvibes-daemon'), 0o755);
      const proc = Bun.spawn([join(t.installDir, 'goodvibes-daemon'), '300'], { stdio: ['ignore', 'ignore', 'ignore'] });
      const pid = proc.pid;
      const isAlive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };

      try {
        await new Promise((r) => setTimeout(r, 300)); // let pgrep see it
        const out = runLib('restart_running_daemon; setup_daemon_service; migrate_legacy_installer_unit', {
          ...t.env,
          STUB_LEGACY_MAINPID: String(pid),
        });
        expect(out.code).toBe(0);

        // The supervised daemon was NEVER killed or nohup-relaunched.
        expect(isAlive()).toBe(true);
        expect(out.stdout).not.toContain('not relaunching');
        expect(out.stdout).not.toContain('Restarting running');
        expect(out.stdout).toContain('running under the installer-managed goodvibes-daemon.service unit');

        // Supervised transfer: canonical written, started, VERIFIED, then legacy retired.
        expect(out.stdout).toContain('Transferring daemon supervision from goodvibes-daemon.service to goodvibes.service');
        expect(out.stdout).toContain('started    goodvibes.service (verified: active with a stable live main process)');
        expect(out.stdout).toContain('retired    goodvibes-daemon.service (disabled, unit file removed)');

        expect(existsSync(t.canonicalPath)).toBe(true);
        const unit = readFileSync(t.canonicalPath, 'utf-8');
        expect(unit).toContain(MARKER);
        expect(unit).toContain(`ExecStart="${t.installDir}/goodvibes-daemon" --daemon-home "${t.home}"`);
        expect(existsSync(t.legacyPath)).toBe(false);
        // End state per the stub: canonical active, legacy inactive.
        expect(readFileSync(t.canonState, 'utf-8')).toContain('active');
        expect(readFileSync(t.legacyState, 'utf-8')).toContain('inactive');

        // Convergence: a second run finds nothing left to migrate.
        const second = runLib('migrate_legacy_installer_unit', { ...t.env, STUB_LEGACY_MAINPID: String(pid) });
        expect(second.code).toBe(0);
        expect(second.stdout).not.toContain('Transferring');
        expect(second.stdout).not.toContain('Retiring');
      } finally {
        if (isAlive()) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }
    },
    20000,
  );

  test(
    'the bare-process fallback never SIGTERMs a service-supervised pid — supervision looked up by pid, ANY unit name',
    async () => {
      // Pins the kill mechanism itself: even when restart_bare_processes IS
      // reached (legacy unit inactive here, so restart_running_daemon falls
      // through to it), a pid that `systemctl status <pid>` resolves to ANY
      // .service unit is skipped — killing it + nohup-relaunching would
      // demote a supervised daemon to an unsupervised process with its
      // enabled unit left behind. The unit name here is deliberately a
      // NON-goodvibes one: the check is by pid lookup, not a hardcoded list.
      const t = stageLegacyOnlyActive('gv-no-kill-supervised');
      writeFileSync(t.legacyState, 'inactive\n'); // fall through to the bare-process path
      copyFileSync('/bin/sleep', join(t.installDir, 'goodvibes-daemon'));
      chmodSync(join(t.installDir, 'goodvibes-daemon'), 0o755);
      const proc = Bun.spawn([join(t.installDir, 'goodvibes-daemon'), '300'], { stdio: ['ignore', 'ignore', 'ignore'] });
      const pid = proc.pid;
      const isAlive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };

      try {
        await new Promise((r) => setTimeout(r, 300));
        const out = runLib('restart_running_daemon', {
          ...t.env,
          STUB_PID_UNIT_PID: String(pid),
          STUB_PID_UNIT_NAME: 'gv-custom.service',
        });
        expect(out.code).toBe(0);
        expect(out.stdout).toContain(`Skipping pid ${pid}`);
        expect(out.stdout).toContain('supervised by a service manager');
        expect(isAlive()).toBe(true); // never killed
      } finally {
        if (isAlive()) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }
    },
    20000,
  );

  test(
    'FAIL-SAFE ON UNKNOWN: a busless session never demotes the supervised daemon — no kill, no nohup, honest notes, converges later',
    async () => {
      // Byte-for-byte the verifier's busless-F1 probe: the dominant upgrade
      // state (installer-marker legacy unit enabled+active supervising the
      // daemon, no canonical unit) run from a session where EVERY systemctl
      // call fails at the bus. The old guards read 'cannot ask systemd' as
      // 'not supervised' and SIGTERM+nohup'd the supervised MainPID, leaving
      // canonical absent and the enabled legacy unit behind — the original
      // incident. Now every unknown answer refuses.
      const root = scratch('gv-busless-f1');
      const home = join(root, 'home');
      const installDir = join(root, 'bin');
      const unitDir = join(home, '.config/systemd/user');
      mkdirSync(installDir, { recursive: true });
      mkdirSync(unitDir, { recursive: true });
      const legacy = join(unitDir, 'goodvibes-daemon.service');
      writeFileSync(legacy, `${MARKER}\n[Service]\nExecStart=${installDir}/goodvibes-daemon\n`);

      copyFileSync('/bin/sleep', join(installDir, 'goodvibes-daemon'));
      chmodSync(join(installDir, 'goodvibes-daemon'), 0o755);
      const proc = Bun.spawn([join(installDir, 'goodvibes-daemon'), '300'], { stdio: ['ignore', 'ignore', 'ignore'] });
      const pid = proc.pid;
      const isAlive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };

      try {
        await new Promise((r) => setTimeout(r, 300));
        const out = runLib('restart_running_daemon; setup_daemon_service; migrate_legacy_installer_unit', {
          HOME: home,
          GOODVIBES_INSTALL_DIR: installDir,
          PATH: `${stubBuslessServiceBin(root)}:${process.env.PATH ?? ''}`,
        });
        expect(out.code).toBe(0);

        // The supervised daemon is untouched: alive, never nohup-relaunched.
        expect(isAlive()).toBe(true);
        expect(out.stdout).not.toContain('not relaunching');
        expect(out.stdout).not.toContain('Restarting running');
        // Honest refusals name the reason and the manual path.
        expect(out.stdout).toContain('cannot determine the daemon service state');
        expect(out.stdout).toContain("cannot determine the daemon units' state");
        // Nothing half-done: no canonical written by migration, legacy intact.
        expect(existsSync(join(unitDir, 'goodvibes.service'))).toBe(false);
        expect(existsSync(legacy)).toBe(true);
      } finally {
        if (isAlive()) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }
    },
    20000,
  );

  test('hand-written ACTIVE legacy unit in the CORPSE state (ExecStart binary deleted): never disabled, never renamed, never rewritten — honest note only', () => {
    // Pins the verifier's corpse-route probe: the hand-written unit points at
    // a deleted binary while the daemon still runs the deleted inode. The old
    // restart-in-place routed through restart_systemd_unit's replacement
    // branch, which disabled the user's running daemon, renamed their unit to
    // .bak, and then setup wrote a fresh installer unit over the top — a
    // triple never-touch violation with a false 'restart it yourself' note
    // pointing at the renamed-away unit.
    const t = stageLegacyOnlyActive('gv-handwritten-corpse');
    const deletedBin = join(t.root, 'old-install', 'goodvibes-daemon'); // never created
    const handWritten = `[Service]\nExecStart=${deletedBin}\n`;
    writeFileSync(t.legacyPath, handWritten);
    const log = join(t.root, 'systemctl-log');

    const out = runLib('restart_running_daemon; migrate_legacy_installer_unit', {
      ...t.env,
      STUB_EXEC_BIN: deletedBin, // show -p ExecStart reports the missing path
      STUB_SYSTEMCTL_LOG: log,
    });
    expect(out.code).toBe(0);

    // The unit file survives verbatim under its own name — no .bak rename.
    expect(readFileSync(t.legacyPath, 'utf-8')).toBe(handWritten);
    expect(readdirSync(join(t.home, '.config/systemd/user')).some((f) => f.includes('.bak.'))).toBe(false);
    // The running daemon was never disabled or stopped.
    const calls = readFileSync(log, 'utf-8');
    expect(calls).not.toContain('disable');
    expect(calls).not.toContain('stop goodvibes-daemon.service');
    expect(readFileSync(t.legacyState, 'utf-8')).toContain('active');
    // Honest note: names the corpse state and the manual fix.
    expect(out.stdout).toContain('the unit is hand-written');
    expect(out.stdout).toContain("Fix the unit's ExecStart yourself");
    expect(out.stdout).not.toContain('replacing it');
  });

  test("macOS supervision probe: a launchctl print FAILURE (gui domain unreachable) is UNKNOWN — never 'free', never kill/nohup", async () => {
    // Pins the verifier's variant-B probe: launchctl exists but print fails
    // with 'Bad request' (exit 64, e.g. from an ssh session while the console
    // user's agent runs). The old branch mapped any print failure to 'free'
    // and SIGTERM+nohup'd the supervised daemon.
    const root = scratch('gv-macos-unknown');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(installDir, { recursive: true });
    copyFileSync('/bin/sleep', join(installDir, 'goodvibes-daemon'));
    chmodSync(join(installDir, 'goodvibes-daemon'), 0o755);
    const proc = Bun.spawn([join(installDir, 'goodvibes-daemon'), '300'], { stdio: ['ignore', 'ignore', 'ignore'] });
    const pid = proc.pid;
    const isAlive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    try {
      await new Promise((r) => setTimeout(r, 300));
      const out = runLib('os_tag=macos; restart_running_daemon', {
        HOME: home,
        GOODVIBES_INSTALL_DIR: installDir,
        PATH: `${stubDualUnitServiceBin(root)}:${process.env.PATH ?? ''}`,
        STUB_LAUNCHCTL_PRINT_BADREQ: '1',
      });
      expect(out.code).toBe(0);

      // restart_launchd_agent refused with the honest cannot-ask note and
      // reported handled — the bare kill/nohup path never ran.
      expect(out.stdout).toContain('cannot determine the sh.goodvibes.daemon agent state');
      expect(out.stdout).not.toContain('Restarting running');
      expect(out.stdout).not.toContain('restarted  sh.goodvibes.daemon');
      expect(isAlive()).toBe(true); // never killed
    } finally {
      if (isAlive()) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    }
  });

  test('hand-written legacy unit ACTIVE: the installer restarts it in place — no false transfer promise, no silent no-upgrade', () => {
    // Verifier scenario: the daemon runs under a hand-written (marker-less)
    // goodvibes-daemon.service. The old flow printed 'the migration step
    // below transfers it' — a promise no code path fulfilled — and the
    // swapped binary never started serving. Now the restart path checks
    // provenance BEFORE promising: hand-written units get a non-destructive
    // in-place restart so the upgrade takes effect, and migration reports
    // (never touches) the unit.
    const t = stageLegacyOnlyActive('gv-handwritten-active');
    // Overwrite the legacy unit with a marker-less, hand-written one whose
    // ExecStart binary EXISTS (so the broken-exec replacement path stays out).
    const customBin = join(t.root, 'custom', 'goodvibes-daemon');
    mkdirSync(join(t.root, 'custom'), { recursive: true });
    writeFileSync(customBin, '#!/bin/sh\nexit 0\n');
    chmodSync(customBin, 0o755);
    writeFileSync(t.legacyPath, `[Service]\nExecStart=${customBin}\n`);

    const out = runLib('restart_running_daemon; migrate_legacy_installer_unit', {
      ...t.env,
      STUB_EXEC_BIN: customBin,
    });
    expect(out.code).toBe(0);

    // Restarted in place, honestly.
    expect(out.stdout).toContain('Restarting the running goodvibes-daemon (systemd user service)');
    expect(out.stdout).toContain('restarted  goodvibes-daemon.service');
    // Never the transfer promise — migration does not transfer hand-written units.
    expect(out.stdout).not.toContain('the migration step below transfers it');
    // Migration reports the hand-written unit, touches nothing.
    expect(out.stdout).toContain('A hand-written goodvibes-daemon.service (no installer marker)');
    expect(existsSync(t.legacyPath)).toBe(true);
  });

  test('BOTH units running: nothing is stopped automatically — refusal points at the consented migrate-service', () => {
    // Verifier scenario: canonical 'active' AND legacy actively serving (the
    // wrong-port or port-fight state). The old canonical-active branch
    // disable--now'd the serving legacy daemon on a bare is-active sample.
    const t = stageLegacyOnlyActive('gv-both-running');
    writeFileSync(t.canonState, 'active\n');
    writeFileSync(t.canonicalPath, `${MARKER}\n[Service]\nExecStart="${t.installDir}/goodvibes-daemon" --daemon-home "${t.home}"\n`);

    const out = runLib('migrate_legacy_installer_unit', t.env);
    expect(out.code).toBe(0);

    expect(out.stdout).toContain('both goodvibes.service and goodvibes-daemon.service are currently running');
    expect(out.stdout).toContain('migrate-service');
    // Nothing changed: both unit files remain, both states untouched.
    expect(existsSync(t.legacyPath)).toBe(true);
    expect(existsSync(t.canonicalPath)).toBe(true);
    expect(readFileSync(t.legacyState, 'utf-8')).toContain('active');
    expect(readFileSync(t.canonState, 'utf-8')).toContain('active');
    expect(out.stdout).not.toContain('disabled + removed');
    expect(out.stdout).not.toContain('Retiring');
  });

  test('canonical SERVING + legacy present but idle: the redundant legacy unit is retired with an honest verified receipt', () => {
    const t = stageLegacyOnlyActive('gv-retire-idle-legacy');
    writeFileSync(t.canonState, 'active\n');
    writeFileSync(t.legacyState, 'inactive\n');
    writeFileSync(t.canonicalPath, `${MARKER}\n[Service]\nExecStart="${t.installDir}/goodvibes-daemon" --daemon-home "${t.home}"\n`);

    const out = runLib('migrate_legacy_installer_unit', t.env);
    expect(out.code).toBe(0);

    expect(out.stdout).toContain('Retiring the redundant installer-managed goodvibes-daemon.service (goodvibes.service is serving)');
    expect(out.stdout).toContain('disabled + removed');
    expect(out.stdout).toContain('verified: active with a live main process');
    expect(existsSync(t.legacyPath)).toBe(false);
    expect(existsSync(t.canonicalPath)).toBe(true);
  });

  test("fork-proof verify: canonical reports 'active' but has no live main process — the transfer rolls back instead of retiring the legacy unit", () => {
    // Verifier scenario: Type=simple reports active from fork onward, so a
    // canonical daemon doomed to bind-fail passes a single instant is-active.
    // The settled verify also requires a LIVE, STABLE MainPID — a dead pid
    // fails it and the rollback (built for exactly this) actually fires.
    const t = stageLegacyOnlyActive('gv-fork-proof-verify');

    const out = runLib('migrate_legacy_installer_unit', {
      ...t.env,
      STUB_CANON_MAINPID: '99999999', // resolves, but no such live process
    });
    expect(out.code).toBe(0);

    expect(out.stdout).toContain('did not come up healthy — rolling back');
    expect(out.stdout).toContain('restarted  goodvibes-daemon.service');
    expect(existsSync(t.canonicalPath)).toBe(false); // written by this run → rolled back
    expect(existsSync(t.legacyPath)).toBe(true);
    expect(out.stdout).not.toContain('retired');
  });

  test('rollback restores the PRE-RUN enablement: a pre-existing, pre-ENABLED canonical unit is stopped but never disabled', () => {
    // Verifier scenario: canonical unit file on disk and ENABLED before this
    // run (in-app install-service wrote+enabled it), legacy actively serving,
    // canonical cannot come up. The old rollback ran a blanket
    // `disable --now`, silently destroying the user's pre-existing enablement.
    const t = stageLegacyOnlyActive('gv-rollback-pre-enabled');
    const existing = `[Service]\nExecStart=${t.installDir}/goodvibes-daemon --daemon-home ${t.home}\n`;
    writeFileSync(t.canonicalPath, existing);
    const log = join(t.root, 'systemctl-log');

    const out = runLib('migrate_legacy_installer_unit', {
      ...t.env,
      STUB_CANON_PRE_ENABLED: '1',
      STUB_CANON_START_FAILS: '1',
      STUB_SYSTEMCTL_LOG: log,
    });
    expect(out.code).toBe(0);

    expect(out.stdout).toContain('did not come up healthy — rolling back');
    // The pre-existing unit file survives (not written by this run).
    expect(readFileSync(t.canonicalPath, 'utf-8')).toBe(existing);
    // The rollback STOPPED the canonical unit but never issued a disable for
    // it — the user's pre-run enablement is preserved.
    const calls = readFileSync(log, 'utf-8').split('\n');
    expect(calls.some((c) => c.includes('stop') && c.includes('goodvibes.service'))).toBe(true);
    expect(calls.some((c) => c.includes('disable') && c.includes('goodvibes.service') && !c.includes('goodvibes-daemon.service'))).toBe(false);
    // Legacy supervision restored.
    expect(out.stdout).toContain('restarted  goodvibes-daemon.service');
  });

  test("unit_active_state recognizes every real systemctl vocabulary: rc-4 'no such unit' is ABSENT (modern systemd), rc-3 inactive is inactive (old), transitional is active, bus failure is unknown", () => {
    // Pins the verifier's live-host probe: on systemd 260 (this repo's own
    // deployment host) `systemctl --user is-active <no-unit-file>` prints
    // 'inactive' with rc 4. Mapping that to unknown made every fail-safe
    // branch refuse the primary upgrade path on modern systemd.
    const t = stageLegacyOnlyActive('gv-vocab');
    const run = (body: string, extra: Record<string, string> = {}) => runLib(body, { ...t.env, ...extra });

    // Modern vocabulary: missing unit → rc 4 → affirmatively ABSENT.
    writeFileSync(t.canonState, 'absent\n');
    expect(run('unit_active_state goodvibes.service').stdout).toBe('absent');
    // Old vocabulary: the same missing unit answered rc 3 'inactive'.
    expect(run('unit_active_state goodvibes.service', { STUB_MISSING_UNIT_RC: '3' }).stdout).toBe('inactive');
    // Exists-but-inactive stays inactive.
    writeFileSync(t.canonState, 'inactive\n');
    expect(run('unit_active_state goodvibes.service').stdout).toBe('inactive');
    // Transitional (crash-loop RestartSec window) is the unit EXISTING with
    // processes in flux — active, never a false "unreachable".
    writeFileSync(t.canonState, 'activating\n');
    expect(run('unit_active_state goodvibes.service').stdout).toBe('active');
    // A bus that cannot be asked stays unknown.
    const busless = runLib('unit_active_state goodvibes.service', {
      HOME: t.home,
      GOODVIBES_INSTALL_DIR: t.installDir,
      PATH: `${stubBuslessServiceBin(t.root)}:${process.env.PATH ?? ''}`,
    });
    expect(busless.stdout).toBe('unknown');
  });

  test('modern systemd (rc-4 for the missing canonical unit): the dominant-state supervised transfer RUNS — no false "unreachable" refusal', () => {
    // The HIGH regression pin: legacy marker unit ACTIVE, canonical unit file
    // absent — on systemd >= ~257 the canonical probe answers rc 4, which the
    // old tri-state read as unknown, refusing the whole migration with a false
    // 'user service manager unreachable' note on a healthy bus, on every
    // re-run. With rc 4 = absent, the transfer proceeds.
    const t = stageLegacyOnlyActive('gv-rc4-transfer');
    writeFileSync(t.canonState, 'absent\n'); // canonical unit does not exist → rc 4

    const out = runLib('migrate_legacy_installer_unit', t.env);
    expect(out.code).toBe(0);

    expect(out.stdout).not.toContain("cannot determine the daemon units' state");
    expect(out.stdout).toContain('Transferring daemon supervision from goodvibes-daemon.service to goodvibes.service');
    expect(out.stdout).toContain('retired    goodvibes-daemon.service');
    expect(existsSync(t.canonicalPath)).toBe(true);
    expect(existsSync(t.legacyPath)).toBe(false);
  });

  test(
    'modern systemd, no legacy unit anywhere: the guarded bare-process restart still runs — not dead-coded by a false unknown',
    async () => {
      // Consequence (b) of the rc-4 regression: with no legacy unit file the
      // legacy probe answers rc 4 on modern systemd; reading it as unknown
      // made restart_running_daemon refuse before the bare-process path on
      // EVERY post-unification host, so a bare daemon never restarted after a
      // binary swap.
      const root = scratch('gv-rc4-bare');
      const home = join(root, 'home');
      const installDir = join(root, 'bin');
      mkdirSync(installDir, { recursive: true });
      copyFileSync('/bin/sleep', join(installDir, 'goodvibes-daemon'));
      chmodSync(join(installDir, 'goodvibes-daemon'), 0o755);
      const proc = Bun.spawn([join(installDir, 'goodvibes-daemon'), '300'], { stdio: ['ignore', 'ignore', 'ignore'] });
      const pid = proc.pid;
      const isAlive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };

      try {
        await new Promise((r) => setTimeout(r, 300));
        // Dual stub with NO state files staged: every unit answers the modern
        // rc-4 'no such unit'; status <pid> answers rc 4 too → pid is free.
        const out = runLib('restart_running_daemon', {
          HOME: home,
          GOODVIBES_INSTALL_DIR: installDir,
          PATH: `${stubDualUnitServiceBin(root)}:${process.env.PATH ?? ''}`,
        });
        expect(out.code).toBe(0);
        // The bare-process path RAN (restart attempted), and no false
        // unreachable diagnosis was printed.
        expect(out.stdout).not.toContain('cannot determine the daemon service state');
        expect(out.stdout).toContain(`Restarting running goodvibes-daemon (pid ${pid})`);
      } finally {
        if (isAlive()) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* gone */
          }
        }
        // The restart path may have relaunched a replacement sleep — sweep it.
        Bun.spawnSync(['pkill', '-f', `${installDir}/goodvibes-daemon`]);
      }
    },
    20000,
  );

  test('GOODVIBES_RESTART_DAEMON=0 leaves an ACTIVE legacy unit completely untouched (the documented contract)', () => {
    // Verifier scenario: legacy actively serving, canonical unit FILE present
    // but inactive, RESTART_DAEMON=0 ("leave running daemon/agent untouched").
    // The old gate accepted the mere file and ran `disable --now` on the only
    // running daemon.
    const t = stageLegacyOnlyActive('gv-restart0-gate');
    writeFileSync(t.canonicalPath, `${MARKER}\n[Service]\nExecStart="${t.installDir}/goodvibes-daemon" --daemon-home "${t.home}" --hostname 127.0.0.1 --port 3421\n`);

    const out = runLib('restart_running_daemon; migrate_legacy_installer_unit', {
      ...t.env,
      GOODVIBES_RESTART_DAEMON: '0',
    });
    expect(out.code).toBe(0);

    // Nothing stopped, nothing removed, no false claims.
    expect(readFileSync(t.legacyState, 'utf-8')).toContain('active'); // still running
    expect(existsSync(t.legacyPath)).toBe(true);
    expect(out.stdout).toContain('GOODVIBES_RESTART_DAEMON=0 — leaving it untouched');
    expect(out.stdout).not.toContain('disabled + removed');
    expect(out.stdout).not.toContain('keeps running');
  });

  test('a pre-existing UNPINNED canonical unit file is USED for the transfer, never overwritten', () => {
    const t = stageLegacyOnlyActive('gv-transfer-existing-canonical');
    // A canonical unit file already on disk (currently inactive) with
    // distinctive content and NO pinned endpoint flags — current launch shape.
    const existing = `[Service]\nExecStart=${t.installDir}/goodvibes-daemon --daemon-home ${t.home}\nNice=5\n`;
    writeFileSync(t.canonicalPath, existing);

    const out = runLib('migrate_legacy_installer_unit', t.env);
    expect(out.code).toBe(0);

    // Transfer happened using the existing unit — content byte-identical.
    expect(out.stdout).toContain('Transferring daemon supervision');
    expect(out.stdout).toContain('started    goodvibes.service (verified: active with a stable live main process)');
    expect(out.stdout).toContain('retired    goodvibes-daemon.service');
    expect(readFileSync(t.canonicalPath, 'utf-8')).toBe(existing);
    expect(out.stdout).not.toContain(`wrote      ${t.canonicalPath}`);
    expect(existsSync(t.legacyPath)).toBe(false);
  });

  test('transfer onto a PINNED platform-managed canonical unit re-derives it first — never starts the stale endpoint behind a verified receipt', () => {
    // Pins the verifier's re-transfer probe: the pre-existing canonical unit
    // carries the released v1.18.0 in-app shape (product Description
    // fingerprint + pinned --hostname 127.0.0.1 --port 3421). The old flow
    // started it verbatim — binding the pinned endpoint regardless of
    // settings — passed the liveness verify, and retired the legacy unit
    // that was serving the configured endpoint.
    const t = stageLegacyOnlyActive('gv-transfer-pinned-managed');
    const pinned = [
      '[Unit]',
      'Description=GoodVibes daemon (shared session broker + companion host)',
      '',
      '[Service]',
      `ExecStart=${t.installDir}/goodvibes-daemon --daemon-home ${t.home} --hostname 127.0.0.1 --port 3421`,
      '',
    ].join('\n');
    writeFileSync(t.canonicalPath, pinned);

    const out = runLib('migrate_legacy_installer_unit', t.env);
    expect(out.code).toBe(0);

    expect(out.stdout).toContain(`rewrote    ${t.canonicalPath}`);
    expect(out.stdout).toContain('retired    goodvibes-daemon.service');
    const unit = readFileSync(t.canonicalPath, 'utf-8');
    expect(unit).not.toContain('--hostname');
    expect(unit).not.toContain('--port');
    expect(unit).toContain(`ExecStart="${t.installDir}/goodvibes-daemon" --daemon-home "${t.home}"`);
    expect(existsSync(t.legacyPath)).toBe(false);
  });

  test('transfer onto a PINNED hand-written canonical unit REFUSES — never binds an unvetted endpoint and never retires the serving legacy', () => {
    const t = stageLegacyOnlyActive('gv-transfer-pinned-handwritten');
    const pinned = `[Service]\nExecStart=${t.installDir}/goodvibes-daemon --daemon-home ${t.home} --hostname 10.0.0.9 --port 4000\n`;
    writeFileSync(t.canonicalPath, pinned);

    const out = runLib('migrate_legacy_installer_unit', t.env);
    expect(out.code).toBe(0);

    expect(out.stdout).toContain('pins endpoint flags');
    expect(out.stdout).toContain('Nothing was changed');
    // Untouched on both sides: legacy still active and serving, canonical verbatim.
    expect(readFileSync(t.canonicalPath, 'utf-8')).toBe(pinned);
    expect(existsSync(t.legacyPath)).toBe(true);
    expect(readFileSync(t.legacyState, 'utf-8')).toContain('active');
    expect(out.stdout).not.toContain('retired');
  });

  test('rollback: when the canonical unit fails to come up, legacy supervision is restored and NOTHING is removed', () => {
    const t = stageLegacyOnlyActive('gv-transfer-rollback');

    const out = runLib('migrate_legacy_installer_unit', {
      ...t.env,
      STUB_CANON_START_FAILS: '1',
    });
    expect(out.code).toBe(0);

    expect(out.stdout).toContain('did not come up healthy — rolling back');
    expect(out.stdout).toContain('restarted  goodvibes-daemon.service');
    // The canonical unit this run wrote was rolled back; the legacy unit
    // survives, enabled and active again.
    expect(existsSync(t.canonicalPath)).toBe(false);
    expect(existsSync(t.legacyPath)).toBe(true);
    expect(readFileSync(t.legacyState, 'utf-8')).toContain('active');
    expect(out.stdout).not.toContain('retired');
  });

  test('a failed stop of the legacy unit aborts the transfer with nothing changed', () => {
    const t = stageLegacyOnlyActive('gv-transfer-stop-fails');

    const out = runLib('migrate_legacy_installer_unit', {
      ...t.env,
      STUB_DISABLE_FAILS: '1', // stop/disable share the failure switch
    });
    expect(out.code).toBe(0);

    expect(out.stdout).toContain('could not stop goodvibes-daemon.service — nothing was changed');
    expect(existsSync(t.legacyPath)).toBe(true);
    expect(readFileSync(t.legacyState, 'utf-8')).toContain('active');
    // The canonical unit written for the aborted transfer was cleaned up.
    expect(existsSync(t.canonicalPath)).toBe(false);
  });

  test('busless migration (every systemctl fails): UNKNOWN state refuses everything — nothing removed, no false receipt', () => {
    // Verifier scenario: no user D-Bus (env-stripped session). Unit states
    // cannot be read, so the migration must refuse up front — 'cannot ask
    // systemd' is never read as 'inactive'. The pre-fix code fell into the
    // neither-active branch and rm -f'd the unit file behind a false
    // "disabled + removed" receipt, leaving a dangling enablement symlink.
    const root = scratch('gv-busless');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    const unitDir = join(home, '.config/systemd/user');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });

    const legacy = join(unitDir, 'goodvibes-daemon.service');
    writeFileSync(legacy, `${MARKER}\n[Service]\nExecStart=${installDir}/goodvibes-daemon\n`);
    const canonical = join(unitDir, 'goodvibes.service');
    writeFileSync(canonical, `${MARKER}\n[Service]\nExecStart="${installDir}/goodvibes-daemon" --daemon-home "${home}"\n`);

    const out = runLib('migrate_legacy_installer_unit', {
      HOME: home,
      GOODVIBES_INSTALL_DIR: installDir,
      PATH: `${stubBuslessServiceBin(root)}:${process.env.PATH ?? ''}`,
    });
    expect(out.code).toBe(0);

    // Refused at the unknown-state gate: both unit files stay, honest note.
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(canonical)).toBe(true);
    expect(out.stdout).toContain("cannot determine the daemon units' state");
    expect(out.stdout).toContain('nothing was changed');
    expect(out.stdout).not.toContain('disabled + removed');
    expect(out.stdout).not.toContain('Retiring');
  });

  test('an UNREADABLE legacy unit file is reported as unreadable — never misdiagnosed as hand-written, never touched', () => {
    const t = stageLegacyOnlyActive('gv-unreadable-legacy');
    chmodSync(t.legacyPath, 0o000);
    try {
      const out = runLib('migrate_legacy_installer_unit', t.env);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('could not be read');
      expect(out.stdout).not.toContain('hand-written');
      expect(existsSync(t.legacyPath)).toBe(true);
    } finally {
      chmodSync(t.legacyPath, 0o644);
    }
  });
});

/**
 * Fielded-fleet content currency: units written by released v1.14.0-v1.18.0
 * (the in-app install-service baked --hostname/--port, snapshotting
 * config-at-install-time) must be re-derived on upgrade — otherwise the pinned
 * flags override the controlPlane settings on every boot, forever, while every
 * display surface shows the configured values the daemon ignores.
 */
describe('install.sh — pinned-endpoint canonical units are re-derived on upgrade', () => {
  const MARKER = '# managed by goodvibes install.sh';
  const FINGERPRINT = 'Description=GoodVibes daemon (shared session broker + companion host)';

  function stageCanonical(prefix: string, unitContent: string) {
    const root = scratch(prefix);
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    const unitDir = join(home, '.config/systemd/user');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });
    const canonicalPath = join(unitDir, 'goodvibes.service');
    writeFileSync(canonicalPath, unitContent);
    return {
      root, home, installDir, canonicalPath,
      env: {
        HOME: home,
        GOODVIBES_INSTALL_DIR: installDir,
        PATH: `${stubDualUnitServiceBin(root)}:${process.env.PATH ?? ''}`,
      },
    };
  }

  test('an installer-marker unit pinning --hostname/--port is regenerated to the config-derived launch', () => {
    const t = stageCanonical('gv-refresh-marker', [
      MARKER,
      '[Service]',
      'ExecStart=/x/goodvibes-daemon --daemon-home /h --hostname 127.0.0.1 --port 3421',
      '',
    ].join('\n'));

    const out = runLib('refresh_pinned_canonical_unit', t.env);
    expect(out.code).toBe(0);

    expect(out.stdout).toContain('Regenerating goodvibes.service');
    expect(out.stdout).toContain(`rewrote    ${t.canonicalPath}`);
    const unit = readFileSync(t.canonicalPath, 'utf-8');
    expect(unit).not.toContain('--hostname');
    expect(unit).not.toContain('--port');
    expect(unit).toContain(`ExecStart="${t.installDir}/goodvibes-daemon" --daemon-home "${t.home}"`);
  });

  test('a product-written unit (v1.18.0 in-app install-service shape: fingerprint, no marker) pinning the endpoint is regenerated too', () => {
    // The verifier's population correction: the fielded pinned units were
    // written by the in-app install-service — they carry the product's
    // Description fingerprint, not the installer marker. Both are
    // platform-owned and safe to re-derive.
    const t = stageCanonical('gv-refresh-product', [
      '[Unit]',
      FINGERPRINT,
      'After=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      'ExecStart=/usr/local/bin/goodvibes-daemon --daemon-home /home/mike --hostname 127.0.0.1 --port 3421',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'));

    const out = runLib('refresh_pinned_canonical_unit', t.env);
    expect(out.code).toBe(0);

    expect(out.stdout).toContain(`rewrote    ${t.canonicalPath}`);
    const unit = readFileSync(t.canonicalPath, 'utf-8');
    expect(unit).not.toContain('--hostname');
    expect(unit).not.toContain('--port');
  });

  test('a hand-written pinned unit is NEVER rewritten — honest notice only', () => {
    const content = '[Service]\nExecStart=/opt/custom/goodvibes-daemon --hostname 10.0.0.9 --port 4000\n';
    const t = stageCanonical('gv-refresh-handwritten', content);

    const out = runLib('refresh_pinned_canonical_unit', t.env);
    expect(out.code).toBe(0);

    expect(readFileSync(t.canonicalPath, 'utf-8')).toBe(content);
    expect(out.stdout).toContain('not recognizably platform-managed');
    expect(out.stdout).toContain('Remove those flags yourself');
    expect(out.stdout).not.toContain('rewrote');
  });

  test('an already config-derived unit is left byte-identical (refresh is a no-op)', () => {
    const content = `${MARKER}\n[Service]\nExecStart="/x/goodvibes-daemon" --daemon-home "/h"\n`;
    const t = stageCanonical('gv-refresh-current', content);

    const out = runLib('refresh_pinned_canonical_unit', t.env);
    expect(out.code).toBe(0);
    expect(readFileSync(t.canonicalPath, 'utf-8')).toBe(content);
    expect(out.stdout).not.toContain('Regenerating');
  });

  test('GOODVIBES_RESTART_DAEMON=0: the pinned managed unit is still rewritten, with an honest note that the running daemon keeps the old endpoint', () => {
    const t = stageCanonical('gv-refresh-restart0', [
      MARKER,
      '[Service]',
      'ExecStart=/x/goodvibes-daemon --daemon-home /h --hostname 127.0.0.1 --port 3421',
      '',
    ].join('\n'));

    const out = runLib('refresh_pinned_canonical_unit', { ...t.env, GOODVIBES_RESTART_DAEMON: '0' });
    expect(out.code).toBe(0);

    expect(readFileSync(t.canonicalPath, 'utf-8')).not.toContain('--hostname');
    expect(out.stdout).toContain('keeps the old pinned endpoint until restarted');
  });
});

describe('install.sh — launchd migration analog (macOS upgrades get the args-driven plist too)', () => {
  const MARKER = 'managed by goodvibes install.sh';

  /** The OLD installer's plist shape: marker present, bare ProgramArguments (binary only, no args). */
  function oldStylePlist(installDir: string): string {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<!-- ${MARKER} -->`,
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>',
      '  <string>sh.goodvibes.daemon</string>',
      '  <key>GoodVibesManagedBy</key>',
      `  <string>${MARKER}</string>`,
      '  <key>ProgramArguments</key>',
      '  <array>',
      `    <string>${installDir}/goodvibes-daemon</string>`,
      '  </array>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
  }

  test('an installer-marker-managed bare-args plist is regenerated to the args-driven form and reloaded', () => {
    const root = scratch('gv-launchd-migrate');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(installDir, { recursive: true });
    const plistPath = join(home, 'Library/LaunchAgents/sh.goodvibes.daemon.plist');
    mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true });
    writeFileSync(plistPath, oldStylePlist(installDir));
    const launchctlLog = join(root, 'launchctl-log');

    const out = runLib('migrate_legacy_launchd_plist', {
      HOME: home,
      GOODVIBES_INSTALL_DIR: installDir,
      PATH: `${stubDualUnitServiceBin(root)}:${process.env.PATH ?? ''}`,
      STUB_LAUNCHCTL_LOG: launchctlLog,
    });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('Upgrading the installer-managed LaunchAgent');
    expect(out.stdout).toContain('reloaded');

    const plist = readFileSync(plistPath, 'utf-8');
    expect(plist).toContain(MARKER); // still installer-managed
    expect(plist).toContain('<string>--daemon-home</string>');
    expect(plist).toContain(`<string>${home}</string>`);
    // No endpoint flags: the daemon resolves controlPlane settings at boot,
    // so a configured endpoint survives the plist regeneration.
    expect(plist).not.toContain('--hostname');
    expect(plist).not.toContain('--port');
    // The agent was actually reloaded (bootout then bootstrap/load).
    const log = readFileSync(launchctlLog, 'utf-8');
    expect(log).toContain('bootout');
    expect(log).toContain('bootstrap');
  });

  test('an agent the user booted out (plist not loaded) is NEVER started by the migration — file updated, load command printed', () => {
    // Verifier scenario: marker plist on disk, agent deliberately stopped via
    // `launchctl bootout` (plist kept). The old code swallowed the failed
    // bootout and bootstrapped anyway — RunAtLoad=true STARTED the daemon the
    // user had stopped, behind a false 'reloaded' receipt.
    const root = scratch('gv-launchd-not-loaded');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(installDir, { recursive: true });
    const plistPath = join(home, 'Library/LaunchAgents/sh.goodvibes.daemon.plist');
    mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true });
    writeFileSync(plistPath, oldStylePlist(installDir));
    const launchctlLog = join(root, 'launchctl-log');

    const out = runLib('migrate_legacy_launchd_plist', {
      HOME: home,
      GOODVIBES_INSTALL_DIR: installDir,
      PATH: `${stubDualUnitServiceBin(root)}:${process.env.PATH ?? ''}`,
      STUB_LAUNCHCTL_LOG: launchctlLog,
      STUB_LAUNCHCTL_PRINT_FAILS: '1', // the label is NOT loaded
    });
    expect(out.code).toBe(0);

    // File updated; agent left stopped, honestly, with the load command.
    expect(readFileSync(plistPath, 'utf-8')).toContain('<string>--daemon-home</string>');
    expect(out.stdout).toContain('not currently loaded — leaving it stopped');
    expect(out.stdout).toContain('launchctl bootstrap');
    expect(out.stdout).not.toContain('reloaded');
    // Only the read-only load-state probe hit launchctl — no bootout, no bootstrap.
    const log = readFileSync(launchctlLog, 'utf-8');
    expect(log).not.toContain('bootout');
    expect(log).not.toContain('bootstrap gui');
  });

  test('a marker-managed plist carrying --daemon-home PLUS pinned --hostname/--port is regenerated — the gate no longer declares it current', () => {
    // Pins the verifier's gate-hole probe: the middle-generation plist has
    // --daemon-home AND the endpoint flags this generation removed. Keying
    // the already-migrated gate on --daemon-home alone returned 'nothing to
    // migrate' and preserved the pinned endpoint forever.
    const root = scratch('gv-launchd-pinned');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(installDir, { recursive: true });
    const plistPath = join(home, 'Library/LaunchAgents/sh.goodvibes.daemon.plist');
    mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true });
    writeFileSync(plistPath, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<!-- ${MARKER} -->`,
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>',
      '  <string>sh.goodvibes.daemon</string>',
      '  <key>GoodVibesManagedBy</key>',
      `  <string>${MARKER}</string>`,
      '  <key>ProgramArguments</key>',
      '  <array>',
      `    <string>${installDir}/goodvibes-daemon</string>`,
      '    <string>--daemon-home</string>',
      `    <string>${home}</string>`,
      '    <string>--hostname</string>',
      '    <string>127.0.0.1</string>',
      '    <string>--port</string>',
      '    <string>3421</string>',
      '  </array>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n'));
    const launchctlLog = join(root, 'launchctl-log');

    const out = runLib('migrate_legacy_launchd_plist', {
      HOME: home,
      GOODVIBES_INSTALL_DIR: installDir,
      PATH: `${stubDualUnitServiceBin(root)}:${process.env.PATH ?? ''}`,
      STUB_LAUNCHCTL_LOG: launchctlLog,
    });
    expect(out.code).toBe(0);

    expect(out.stdout).toContain('Upgrading the installer-managed LaunchAgent');
    const plist = readFileSync(plistPath, 'utf-8');
    expect(plist).toContain('<string>--daemon-home</string>');
    expect(plist).not.toContain('--hostname');
    expect(plist).not.toContain('--port');
  });

  test('a hand-written plist (no marker) is left byte-identical', () => {
    const root = scratch('gv-launchd-handwritten');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(installDir, { recursive: true });
    const plistPath = join(home, 'Library/LaunchAgents/sh.goodvibes.daemon.plist');
    mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true });
    const handWritten = '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>sh.goodvibes.daemon</string></dict></plist>\n';
    writeFileSync(plistPath, handWritten);

    const out = runLib('migrate_legacy_launchd_plist', {
      HOME: home,
      GOODVIBES_INSTALL_DIR: installDir,
      PATH: `${stubDualUnitServiceBin(root)}:${process.env.PATH ?? ''}`,
    });
    expect(out.code).toBe(0);
    expect(readFileSync(plistPath, 'utf-8')).toBe(handWritten);
    expect(out.stdout).not.toContain('Upgrading');
  });

  test('GOODVIBES_RESTART_DAEMON=0: the plist is updated on disk but the running agent is not reloaded, stated honestly', () => {
    const root = scratch('gv-launchd-restart0');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(installDir, { recursive: true });
    const plistPath = join(home, 'Library/LaunchAgents/sh.goodvibes.daemon.plist');
    mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true });
    writeFileSync(plistPath, oldStylePlist(installDir));
    const launchctlLog = join(root, 'launchctl-log');

    const out = runLib('migrate_legacy_launchd_plist', {
      HOME: home,
      GOODVIBES_INSTALL_DIR: installDir,
      GOODVIBES_RESTART_DAEMON: '0',
      PATH: `${stubDualUnitServiceBin(root)}:${process.env.PATH ?? ''}`,
      STUB_LAUNCHCTL_LOG: launchctlLog,
    });
    expect(out.code).toBe(0);

    expect(readFileSync(plistPath, 'utf-8')).toContain('<string>--daemon-home</string>');
    expect(out.stdout).toContain('keeps its old arguments until you reload it');
    // Only the read-only load-state probe hit launchctl — never a reload.
    const log = readFileSync(launchctlLog, 'utf-8');
    expect(log).not.toContain('bootout');
    expect(log).not.toContain('bootstrap gui');
  });

  test('macOS restart path: a LOADED launchd agent is restarted via kickstart — never SIGTERM + nohup', () => {
    // Verifier scenario (platform parity): on macOS the systemd guards never
    // fire, so the old restart path SIGTERMed the launchd-supervised daemon
    // and nohup-relaunched it outside launchd, racing the KeepAlive respawn
    // for the port. The restart path now restarts a loaded agent in place.
    const root = scratch('gv-launchd-kickstart');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(installDir, { recursive: true });
    const launchctlLog = join(root, 'launchctl-log');

    // Override os_tag after resolve_platform: this suite runs on Linux, and
    // the macOS branch dispatches purely on the variable.
    const out = runLib('os_tag=macos; restart_running_daemon', {
      HOME: home,
      GOODVIBES_INSTALL_DIR: installDir,
      PATH: `${stubDualUnitServiceBin(root)}:${process.env.PATH ?? ''}`,
      STUB_LAUNCHCTL_LOG: launchctlLog,
    });
    expect(out.code).toBe(0);

    expect(out.stdout).toContain('Restarting the running sh.goodvibes.daemon (launchd user agent)');
    expect(out.stdout).toContain('restarted  sh.goodvibes.daemon');
    const log = readFileSync(launchctlLog, 'utf-8');
    expect(log).toContain('kickstart -k');
    // Never the bare-process demotion path.
    expect(out.stdout).not.toContain('not relaunching');
    expect(out.stdout).not.toContain('Restarting running goodvibes-daemon (pid');
  });

  test('macOS restart path: an agent that is NOT loaded falls through to the guarded bare-process path, not a phantom kickstart', () => {
    const root = scratch('gv-launchd-not-loaded-restart');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(installDir, { recursive: true });
    const launchctlLog = join(root, 'launchctl-log');

    const out = runLib('os_tag=macos; restart_running_daemon', {
      HOME: home,
      GOODVIBES_INSTALL_DIR: installDir,
      PATH: `${stubDualUnitServiceBin(root)}:${process.env.PATH ?? ''}`,
      STUB_LAUNCHCTL_LOG: launchctlLog,
      STUB_LAUNCHCTL_PRINT_FAILS: '1',
    });
    expect(out.code).toBe(0);
    // No kickstart, no false restart claim; with no matching bare processes
    // the run is silent.
    expect(out.stdout).not.toContain('kickstart');
    expect(out.stdout).not.toContain('restarted  sh.goodvibes.daemon');
  });
});

/**
 * ONE canonical unit content, derived from config: the installer-written and
 * product-written units must agree — same launch shape, no baked endpoint —
 * verified on a NON-DEFAULT config fixture (hostMode=network, port 3500). The
 * endpoint lives in config and is resolved by the daemon at boot; pinning it
 * into either writer's ExecStart is what silently re-pinned custom-configured
 * hosts back to installer constants behind a success receipt.
 */
describe('install.sh ↔ product — canonical unit content parity on a non-default config', () => {
  test('both writers emit binary + --daemon-home only; neither bakes the configured endpoint; boot-time resolution yields it', () => {
    const root = scratch('gv-unit-parity');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(installDir, { recursive: true });

    // Non-default endpoint fixture: hostMode=network + port 3500.
    const configManager = new ConfigManager({ workingDir: home, homeDir: home, surfaceRoot: 'tui' });
    configManager.setDynamic('controlPlane.hostMode', 'network');
    configManager.setDynamic('controlPlane.port', 3500);

    // Product-written unit (the in-app install-service path).
    const manager = buildManagedDaemonServiceManager({
      binaryPath: join(installDir, 'goodvibes-daemon'),
      homeDir: home,
      host: '0.0.0.0',
      port: 3500,
      configManager,
      actionRunner: () => ({ status: 0 }),
    });
    const installed = manager.install();
    expect(installed.actionError).toBeUndefined();
    const productUnit = readFileSync(join(home, '.config', 'systemd', 'user', 'goodvibes.service'), 'utf-8');
    const productExec = productUnit.split('\n').find((l) => l.startsWith('ExecStart=')) ?? '';

    // Installer-written unit (write_systemd_unit) into a sibling path.
    const installerUnitPath = join(root, 'installer-home', '.config/systemd/user/goodvibes.service');
    const out = runLib(`write_systemd_unit "${installerUnitPath}"`, {
      HOME: home,
      GOODVIBES_INSTALL_DIR: installDir,
    });
    expect(out.code).toBe(0);
    const installerUnit = readFileSync(installerUnitPath, 'utf-8');
    const installerExec = installerUnit.split('\n').find((l) => l.startsWith('ExecStart=')) ?? '';

    // Normalize both ExecStart lines to token lists (strip systemd quoting).
    const tokens = (line: string): string[] =>
      line.replace('ExecStart=', '').split(/\s+/).filter(Boolean).map((t) => t.replace(/^"|"$/g, ''));
    const productTokens = tokens(productExec);
    const installerTokens = tokens(installerExec);

    // PARITY: identical launch shape — the daemon binary, then --daemon-home
    // with the home dir. Nothing else.
    expect(productTokens).toEqual([join(installDir, 'goodvibes-daemon'), '--daemon-home', home]);
    expect(installerTokens).toEqual([join(installDir, 'goodvibes-daemon'), '--daemon-home', home]);

    // Neither writer baked the configured endpoint (flags OR values).
    for (const unit of [productUnit, installerUnit]) {
      expect(unit).not.toContain('--hostname');
      expect(unit).not.toContain('--port');
      expect(unit).not.toContain('3500');
      expect(unit).not.toContain('0.0.0.0');
    }

    // The endpoint comes from config at boot: this is what a daemon launched
    // by EITHER unit resolves on this fixture.
    const bootBinding = resolveRuntimeEndpointBinding(configManager, 'controlPlane');
    expect(bootBinding.host).toBe('0.0.0.0');
    expect(bootBinding.port).toBe(3500);
  });
});

describe('install.sh — restart path validates the target before restarting/relaunching', () => {
  // Reproduces the owner-hit migration defect: a bun-installed global package
  // is removed with `bun remove -g` (deletes the binaries, leaves the
  // bun-era systemd unit and/or its still-running process behind), then the
  // curl installer runs. Without the fix, restart_systemd_unit restarts a
  // corpse and setup_daemon_service_systemd then refuses to replace the unit
  // because "one already exists" — no running daemon, no usable unit, and
  // nothing said so.

  test('an existing unit pointing at a deleted binary is replaced (backed up) and first-run setup runs', () => {
    const root = scratch('gv-broken-unit');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    const unitDir = join(home, '.config/systemd/user');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });

    // Never created — simulates `bun remove -g` having deleted the binary
    // out from under the bun-era unit.
    const deletedBin = join(root, 'bun-vendor', 'goodvibes-daemon');
    const unitPath = join(unitDir, 'goodvibes.service');
    writeFileSync(unitPath, `[Service]\nExecStart=${deletedBin}\nRestart=on-failure\n`);

    const stateFile = join(root, 'state');
    writeFileSync(stateFile, 'active\n');

    const out = runLib('restart_running_daemon; setup_daemon_service', {
      HOME: home,
      GOODVIBES_INSTALL_DIR: installDir,
      PATH: `${stubStatefulServiceBin(root)}:${process.env.PATH ?? ''}`,
      STUB_STATE_FILE: stateFile,
      STUB_EXEC_BIN: deletedBin,
    });

    expect(out.code).toBe(0);
    expect(out.stdout).toContain(`points at ${deletedBin}`);
    expect(out.stdout).toContain('no longer exists');
    expect(out.stdout).toContain('replacing it');

    // Old unit file backed up, never silently destroyed.
    const backup = readdirSync(unitDir).find((f) => f.startsWith('goodvibes.service.bak.'));
    expect(backup).toBeDefined();
    expect(readFileSync(join(unitDir, backup as string), 'utf-8')).toContain(deletedBin);

    // First-run setup created a fresh installer-managed unit at the original path.
    expect(existsSync(unitPath)).toBe(true);
    const newUnit = readFileSync(unitPath, 'utf-8');
    expect(newUnit).toContain('# managed by goodvibes install.sh');
    expect(newUnit).toContain(`ExecStart="${installDir}/goodvibes-daemon" --daemon-home "${home}"`);
    expect(out.stdout).toContain('Setting up the goodvibes daemon as a systemd user service');
    expect(out.stdout).toContain('started    goodvibes.service (active)');
  });

  test('an existing unit whose ExecStart is a different, still-valid binary is restarted and left in place', () => {
    const root = scratch('gv-valid-foreign-unit');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    const unitDir = join(home, '.config/systemd/user');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });

    // A genuinely hand-written unit pointing at a DIFFERENT, still-existing binary.
    const otherBinDir = join(root, 'other-bin');
    mkdirSync(otherBinDir, { recursive: true });
    const otherBin = join(otherBinDir, 'custom-goodvibes-daemon');
    writeFileSync(otherBin, '#!/bin/sh\nexit 0\n');
    chmodSync(otherBin, 0o755);

    const unitPath = join(unitDir, 'goodvibes.service');
    const originalUnit = `[Service]\nExecStart=${otherBin}\n`;
    writeFileSync(unitPath, originalUnit);

    const stateFile = join(root, 'state');
    writeFileSync(stateFile, 'active\n');

    const out = runLib(
      'restart_systemd_unit goodvibes.service "$GOODVIBES_INSTALL_DIR/goodvibes-daemon"; setup_daemon_service_systemd',
      {
        HOME: home,
        GOODVIBES_INSTALL_DIR: installDir,
        PATH: `${stubStatefulServiceBin(root)}:${process.env.PATH ?? ''}`,
        STUB_STATE_FILE: stateFile,
        STUB_EXEC_BIN: otherBin,
      },
    );

    expect(out.code).toBe(0);
    expect(out.stdout).toContain('Restarting the running goodvibes (systemd user service)');
    expect(out.stdout).toContain('restarted  goodvibes.service');
    // Mismatch noted (expected_bin is $installDir/goodvibes-daemon, not otherBin) but never overwritten.
    expect(out.stdout).toContain('does not exec');
    expect(readdirSync(unitDir).some((f) => f.includes('.bak.'))).toBe(false);
    expect(readFileSync(unitPath, 'utf-8')).toBe(originalUnit);
    // Never-overwrite still holds at the setup layer.
    expect(out.stdout).toContain('already exists');
  });

  test(
    'a bare process whose executable is outside $INSTALL_DIR is stopped, not relaunched, and setup proceeds',
    async () => {
      const root = scratch('gv-bare-foreign');
      const home = join(root, 'home');
      const installDir = join(root, 'bin');
      const foreignDir = join(root, 'bun-vendor');
      mkdirSync(installDir, { recursive: true });
      mkdirSync(foreignDir, { recursive: true });

      // The newly installed binary at the real install path, so first-run
      // setup below has something valid to point the fresh unit at.
      const newDaemonBin = join(installDir, 'goodvibes-daemon');
      writeFileSync(newDaemonBin, '#!/bin/sh\nexit 0\n');
      chmodSync(newDaemonBin, 0o755);

      // The stale bun-launched process: still running, its real executable a
      // copy of a real binary living OUTSIDE $INSTALL_DIR, named so it
      // matches the pgrep pattern restart_bare_processes uses.
      const foreignBin = join(foreignDir, 'goodvibes-daemon');
      copyFileSync('/bin/sleep', foreignBin);
      chmodSync(foreignBin, 0o755);
      const proc = Bun.spawn([foreignBin, '300'], { stdio: ['ignore', 'ignore', 'ignore'] });
      const pid = proc.pid;

      const isAlive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };

      try {
        // Give pgrep a moment to see the process.
        await new Promise((r) => setTimeout(r, 300));

        // Step 1: the restart path must recognize this pid as foreign (its
        // real executable is not under $INSTALL_DIR) and refuse to recover
        // its argv and relaunch it. This assertion holds independent of how
        // long the process actually takes to honor the TERM the installer
        // sends it — that grace period (up to 10s, real installer
        // behavior) is not what this test is checking.
        const out = runLib('restart_running_daemon', {
          HOME: home,
          GOODVIBES_INSTALL_DIR: installDir,
          PATH: `${stubServiceBin(root)}:${process.env.PATH ?? ''}`,
        });
        expect(out.code).toBe(0);
        expect(out.stdout).toContain(`pid ${pid}`);
        expect(out.stdout).toContain('not relaunching');

        // Make sure it is actually gone before checking first-run setup —
        // force it down rather than trusting the installer's own TERM to
        // have landed within this test's window.
        if (isAlive()) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
        for (let i = 0; i < 30 && isAlive(); i++) {
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(isAlive()).toBe(false);

        // Step 2: with nothing running, first-run setup proceeds.
        const setupOut = runLib('setup_daemon_service', {
          HOME: home,
          GOODVIBES_INSTALL_DIR: installDir,
          PATH: `${stubServiceBin(root)}:${process.env.PATH ?? ''}`,
        });
        expect(setupOut.code).toBe(0);
        expect(setupOut.stdout).toContain('Setting up the goodvibes daemon as a systemd user service');
      } finally {
        if (isAlive()) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* ignore */
          }
        }
      }
    },
    20000,
  );
});

describe('install.sh — uninstall mode', () => {
  test('removes installer-managed files, preserves hand-written units and ~/.goodvibes, prints a summary', () => {
    const root = scratch('gv-uninstall');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    const unitDir = join(home, '.config/systemd/user');
    const dataDir = join(home, '.goodvibes');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(join(installDir, 'lib/sqlite-vec-linux-x64'), { recursive: true });
    mkdirSync(unitDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    for (const name of ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent']) {
      const p = join(installDir, name);
      writeFileSync(p, '#!/bin/sh\nexit 0\n');
      chmodSync(p, 0o755);
    }
    writeFileSync(join(installDir, 'lib/sqlite-vec-linux-x64/vec0.so'), 'x');
    writeFileSync(join(dataDir, 'settings.json'), '{}');

    // Both the canonical (goodvibes.service) and the retired legacy name
    // (goodvibes-daemon.service) are installer-marker-managed here — uninstall
    // must remove BOTH.
    const managedUnit = join(unitDir, 'goodvibes.service');
    const legacyManagedUnit = join(unitDir, 'goodvibes-daemon.service');
    const handWrittenUnit = join(unitDir, 'goodvibes-agent.service');
    writeFileSync(managedUnit, `# managed by goodvibes install.sh\n[Service]\nExecStart=${installDir}/goodvibes-daemon --daemon-home ${home} --hostname 127.0.0.1 --port 3421\n`);
    writeFileSync(legacyManagedUnit, `# managed by goodvibes install.sh\n[Service]\nExecStart=${installDir}/goodvibes-daemon\n`);
    writeFileSync(handWrittenUnit, '[Service]\nExecStart=/usr/bin/custom-agent\n');

    const result = Bun.spawnSync(['sh', INSTALL_SH], {
      env: {
        ...process.env,
        HOME: home,
        GOODVIBES_INSTALL_DIR: installDir,
        GOODVIBES_UNINSTALL: '1',
        PATH: `${stubServiceBin(root)}:${process.env.PATH ?? ''}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = result.stdout.toString();
    expect(result.exitCode ?? -1).toBe(0);

    // Installer-managed things are gone.
    expect(existsSync(join(installDir, 'goodvibes'))).toBe(false);
    expect(existsSync(join(installDir, 'goodvibes-daemon'))).toBe(false);
    expect(existsSync(join(installDir, 'goodvibes-agent'))).toBe(false);
    expect(existsSync(join(installDir, 'lib/sqlite-vec-linux-x64'))).toBe(false);
    expect(existsSync(managedUnit)).toBe(false);
    // The retired legacy unit name is installer-marker-managed too — also gone.
    expect(existsSync(legacyManagedUnit)).toBe(false);

    // Hand-written unit and user data are preserved.
    expect(existsSync(handWrittenUnit)).toBe(true);
    expect(readFileSync(handWrittenUnit, 'utf-8')).toContain('/usr/bin/custom-agent');
    expect(existsSync(join(dataDir, 'settings.json'))).toBe(true);

    // Honest summary: removed / preserved / kept-hand-written all stated.
    expect(stdout).toContain('Uninstall summary');
    expect(stdout).toContain('Removed:');
    expect(stdout).toContain('Preserved:');
    expect(stdout).toContain('.goodvibes');
    expect(stdout).toMatch(/KEPT[\s\S]*goodvibes-agent\.service/);
    expect(stdout).toContain('rm -rf');
  });

  test('uninstall makes no network calls and reports cleanly when nothing is installed', () => {
    const root = scratch('gv-uninstall-empty');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(installDir, { recursive: true });

    const result = Bun.spawnSync(['sh', INSTALL_SH], {
      env: {
        ...process.env,
        HOME: home,
        GOODVIBES_INSTALL_DIR: installDir,
        GOODVIBES_UNINSTALL: '1',
        PATH: `${stubServiceBin(root)}:${process.env.PATH ?? ''}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(result.exitCode ?? -1).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).toContain('Removed: nothing');
    expect(stdout).toContain('Preserved:');
  });
});

// "Start with: goodvibes" must not be a false promise when
// $INSTALL_DIR is not on PATH. Covers ensure_path_on_shell_rc() (idempotent,
// per-shell rc + syntax) and its uninstall-side counterpart
// uninstall_shell_rc_path_line() (installer-managed marker discipline).
describe('install.sh — PATH line management', () => {
  test('bash: adds a marker-tagged export line to .bashrc when $INSTALL_DIR is not on PATH', () => {
    const root = scratch('gv-path-bash');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(home, { recursive: true });
    mkdirSync(installDir, { recursive: true });

    const out = runLib('ensure_path_on_shell_rc', {
      HOME: home,
      GOODVIBES_INSTALL_DIR: installDir,
      SHELL: '/bin/bash',
      PATH: '/usr/bin:/bin',
    });
    expect(out.code).toBe(0);

    const rcFile = join(home, '.bashrc');
    expect(existsSync(rcFile)).toBe(true);
    const rc = readFileSync(rcFile, 'utf-8');
    expect(rc).toContain('# managed by goodvibes install.sh');
    expect(rc).toContain(`export PATH="${installDir}:$PATH"`);
    expect(out.stdout).toContain(`Added ${installDir} to PATH in ${rcFile}`);
  });

  test('is idempotent: a second run does not duplicate the PATH line', () => {
    const root = scratch('gv-path-idempotent');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(home, { recursive: true });
    mkdirSync(installDir, { recursive: true });
    const env = { HOME: home, GOODVIBES_INSTALL_DIR: installDir, SHELL: '/bin/bash', PATH: '/usr/bin:/bin' };

    runLib('ensure_path_on_shell_rc', env);
    const second = runLib('ensure_path_on_shell_rc', env);
    expect(second.code).toBe(0);

    const rc = readFileSync(join(home, '.bashrc'), 'utf-8');
    const markerCount = rc.split('managed by goodvibes install.sh').length - 1;
    expect(markerCount).toBe(1);
    // The second run recognized the line was already there — it did not
    // print another "Added ... to PATH" line.
    expect(second.stdout).not.toContain('Added');
  });

  test('is a no-op when $INSTALL_DIR is already on PATH — no rc file is touched', () => {
    const root = scratch('gv-path-already-set');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(home, { recursive: true });
    mkdirSync(installDir, { recursive: true });

    const out = runLib('ensure_path_on_shell_rc', {
      HOME: home,
      GOODVIBES_INSTALL_DIR: installDir,
      SHELL: '/bin/bash',
      PATH: `${installDir}:/usr/bin:/bin`,
    });
    expect(out.code).toBe(0);
    expect(existsSync(join(home, '.bashrc'))).toBe(false);
  });

  test('zsh: writes the export line into .zshrc', () => {
    const root = scratch('gv-path-zsh');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(home, { recursive: true });
    mkdirSync(installDir, { recursive: true });

    runLib('ensure_path_on_shell_rc', {
      HOME: home,
      GOODVIBES_INSTALL_DIR: installDir,
      SHELL: '/usr/bin/zsh',
      PATH: '/usr/bin:/bin',
    });
    expect(existsSync(join(home, '.zshrc'))).toBe(true);
    expect(readFileSync(join(home, '.zshrc'), 'utf-8')).toContain(`export PATH="${installDir}:$PATH"`);
  });

  test('fish: writes fish-syntax PATH line into config.fish', () => {
    const root = scratch('gv-path-fish');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(home, { recursive: true });
    mkdirSync(installDir, { recursive: true });

    runLib('ensure_path_on_shell_rc', {
      HOME: home,
      GOODVIBES_INSTALL_DIR: installDir,
      SHELL: '/usr/bin/fish',
      PATH: '/usr/bin:/bin',
    });
    const rcFile = join(home, '.config/fish/config.fish');
    expect(existsSync(rcFile)).toBe(true);
    expect(readFileSync(rcFile, 'utf-8')).toContain(`set -gx PATH ${installDir} $PATH`);
  });

  test('uninstall_shell_rc_path_line removes exactly the marker line and the line after it, nothing else', () => {
    const root = scratch('gv-path-uninstall');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(home, { recursive: true });
    mkdirSync(installDir, { recursive: true });
    const rcFile = join(home, '.bashrc');
    writeFileSync(rcFile, '# a pre-existing user line\nalias ll="ls -la"\n');

    runLib('ensure_path_on_shell_rc', { HOME: home, GOODVIBES_INSTALL_DIR: installDir, SHELL: '/bin/bash', PATH: '/usr/bin:/bin' });
    expect(readFileSync(rcFile, 'utf-8')).toContain('managed by goodvibes install.sh');

    runLib('uninstall_shell_rc_path_line', { HOME: home, GOODVIBES_INSTALL_DIR: installDir, SHELL: '/bin/bash', PATH: '/usr/bin:/bin' });
    const rc = readFileSync(rcFile, 'utf-8');
    expect(rc).not.toContain('managed by goodvibes install.sh');
    expect(rc).not.toContain(`export PATH="${installDir}:$PATH"`);
    // The user's own pre-existing lines survive untouched.
    expect(rc).toContain('# a pre-existing user line');
    expect(rc).toContain('alias ll="ls -la"');
  });

  test('uninstall_shell_rc_path_line is a safe no-op when no PATH line was ever added', () => {
    const root = scratch('gv-path-uninstall-noop');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    mkdirSync(home, { recursive: true });
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(home, '.bashrc'), '# nothing installer-managed here\n');

    const out = runLib('uninstall_shell_rc_path_line', { HOME: home, GOODVIBES_INSTALL_DIR: installDir, SHELL: '/bin/bash', PATH: '/usr/bin:/bin' });
    expect(out.code).toBe(0);
    expect(readFileSync(join(home, '.bashrc'), 'utf-8')).toBe('# nothing installer-managed here\n');
  });
});
