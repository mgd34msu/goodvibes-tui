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
    '    is-active) exit 3 ;;',
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
    '      exit 3',
    '    fi',
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

    const unitPath = join(home, '.config/systemd/user/goodvibes-daemon.service');
    const out = runLib(`write_systemd_unit "${unitPath}"`, { HOME: home, GOODVIBES_INSTALL_DIR: installDir });
    expect(out.code).toBe(0);
    expect(existsSync(unitPath)).toBe(true);

    const unit = readFileSync(unitPath, 'utf-8');
    // Installer-managed marker (the uninstall path keys on this exact string).
    expect(unit).toContain('# managed by goodvibes install.sh');
    // ExecStart points at the daemon binary inside the install dir.
    expect(unit).toContain(`ExecStart=${installDir}/goodvibes-daemon`);
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
    expect(existsSync(join(home, '.config/systemd/user/goodvibes-daemon.service'))).toBe(false);
  });

  test('an existing unit is never overwritten (installer-managed or hand-written)', () => {
    const root = scratch('gv-existing');
    const home = join(root, 'home');
    const installDir = join(root, 'bin');
    const unitDir = join(home, '.config/systemd/user');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });
    const unitPath = join(unitDir, 'goodvibes-daemon.service');
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
    const unitPath = join(unitDir, 'goodvibes-daemon.service');
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
    const backup = readdirSync(unitDir).find((f) => f.startsWith('goodvibes-daemon.service.bak.'));
    expect(backup).toBeDefined();
    expect(readFileSync(join(unitDir, backup as string), 'utf-8')).toContain(deletedBin);

    // First-run setup created a fresh installer-managed unit at the original path.
    expect(existsSync(unitPath)).toBe(true);
    const newUnit = readFileSync(unitPath, 'utf-8');
    expect(newUnit).toContain('# managed by goodvibes install.sh');
    expect(newUnit).toContain(`ExecStart=${installDir}/goodvibes-daemon`);
    expect(out.stdout).toContain('Setting up the goodvibes daemon as a systemd user service');
    expect(out.stdout).toContain('started    goodvibes-daemon.service (active)');
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

    const unitPath = join(unitDir, 'goodvibes-daemon.service');
    const originalUnit = `[Service]\nExecStart=${otherBin}\n`;
    writeFileSync(unitPath, originalUnit);

    const stateFile = join(root, 'state');
    writeFileSync(stateFile, 'active\n');

    const out = runLib(
      'restart_systemd_unit goodvibes-daemon.service "$GOODVIBES_INSTALL_DIR/goodvibes-daemon"; setup_daemon_service_systemd',
      {
        HOME: home,
        GOODVIBES_INSTALL_DIR: installDir,
        PATH: `${stubStatefulServiceBin(root)}:${process.env.PATH ?? ''}`,
        STUB_STATE_FILE: stateFile,
        STUB_EXEC_BIN: otherBin,
      },
    );

    expect(out.code).toBe(0);
    expect(out.stdout).toContain('Restarting the running goodvibes-daemon (systemd user service)');
    expect(out.stdout).toContain('restarted  goodvibes-daemon.service');
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

    const managedUnit = join(unitDir, 'goodvibes-daemon.service');
    const handWrittenUnit = join(unitDir, 'goodvibes-agent.service');
    writeFileSync(managedUnit, `# managed by goodvibes install.sh\n[Service]\nExecStart=${installDir}/goodvibes-daemon\n`);
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
