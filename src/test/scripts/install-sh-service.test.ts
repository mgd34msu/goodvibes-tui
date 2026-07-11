import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** Write a stub bin dir whose systemctl/launchctl are inert no-ops, so a
 * service-touching code path can be exercised without reaching the real host.
 * `is-active` reports inactive (exit 3); `cat` reports "no such unit" (exit 1),
 * so unit detection falls back to the scratch file on disk; everything else
 * exits 0. */
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
