import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/**
 * Shell-level coverage for install_browser_driver.
 *
 * goodvibes-agent is a compiled binary and carries no node_modules, so the
 * Playwright driver can neither be required from inside it nor bundled into it.
 * It ships as its own release asset and must be extracted beside the binary to
 * exist at all — agent 1.18.1 shipped no such asset, and every installed agent
 * reported browser control as unavailable as a result. These tests pin the
 * behaviour that prevents that from shipping again, and the failure modes that
 * must never install a broken driver silently.
 *
 * install.sh is sourced as a library (GOODVIBES_INSTALL_SH_LIB=1) and `fetch` is
 * replaced with a local copy, so nothing here touches the network, a real
 * install directory, or a running process.
 */

const INSTALL_SH = join(import.meta.dir, '../../../scripts/install.sh');
const created: string[] = [];

function scratch(prefix: string): string {
  const dir = makeProjectTempDir(prefix);
  created.push(dir);
  return dir;
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

/**
 * Sources install.sh as a library with `fetch` redefined to copy from a local
 * release fixture directory, then runs `body`.
 */
function runLib(body: string, env: Record<string, string>): { stdout: string; stderr: string; code: number } {
  const script = [
    `. "${INSTALL_SH}"`,
    'resolve_platform',
    // Stand in for the network: the "release" is a directory of files.
    'fetch() { cp "${1#file://}" "$2"; }',
    body,
  ].join('\n');
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

interface ReleaseFixture {
  readonly root: string;
  readonly releaseDir: string;
  readonly workDir: string;
  readonly installDir: string;
  readonly archivePath: string;
}

/**
 * Builds a fake release: a real gzipped tar whose interior layout is the one
 * the runtime resolves (`playwright-core/...`), plus the agent SHA256SUMS.txt
 * the installer verifies against.
 */
function buildRelease(options: { readonly omitCli?: boolean; readonly corruptChecksum?: boolean; readonly omitManifestEntry?: boolean } = {}): ReleaseFixture {
  const root = scratch('gv-driver');
  const releaseDir = join(root, 'release');
  const workDir = join(root, 'work');
  const installDir = join(root, 'bin');
  const stage = join(root, 'stage', 'playwright-core');
  mkdirSync(releaseDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  mkdirSync(join(stage, 'lib'), { recursive: true });

  writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '1.62.0' }));
  writeFileSync(join(stage, 'index.js'), 'module.exports = {};\n');
  if (options.omitCli !== true) writeFileSync(join(stage, 'cli.js'), '#!/usr/bin/env node\n');
  writeFileSync(join(stage, 'lib', 'marker.txt'), 'driver payload\n');

  const archivePath = join(releaseDir, 'browser-driver.tar.gz');
  const tar = Bun.spawnSync(['tar', '-czf', archivePath, '-C', join(root, 'stage'), 'playwright-core']);
  if (tar.exitCode !== 0) throw new Error(`fixture tar failed: ${tar.stderr.toString()}`);

  const digest = Bun.spawnSync(['sha256sum', archivePath]).stdout.toString().split(/\s+/)[0] ?? '';
  const recorded = options.corruptChecksum === true ? 'f'.repeat(64) : digest;
  const manifest = options.omitManifestEntry === true
    ? 'deadbeef  goodvibes-agent-linux-x64\n'
    : `deadbeef  goodvibes-agent-linux-x64\n${recorded}  browser-driver.tar.gz\n`;
  writeFileSync(join(workDir, 'agent-SHA256SUMS.txt'), manifest);

  return { root, releaseDir, workDir, installDir, archivePath };
}

function envFor(fixture: ReleaseFixture): Record<string, string> {
  return {
    HOME: fixture.root,
    GOODVIBES_INSTALL_DIR: fixture.installDir,
  };
}

/** WORKDIR and INSTALL_DIR are script-level variables, so the body sets them. */
function callInstallDriver(fixture: ReleaseFixture): string {
  return [
    `WORKDIR="${fixture.workDir}"`,
    `INSTALL_DIR="${fixture.installDir}"`,
    `install_browser_driver "file://${fixture.releaseDir}" v1.18.2`,
  ].join('\n');
}

describe('install.sh — browser driver companion asset', () => {
  test('a verified archive is extracted beside the binary at $INSTALL_DIR/playwright-core', () => {
    const fixture = buildRelease();
    const result = runLib(callInstallDriver(fixture), envFor(fixture));

    expect(result.code).toBe(0);
    const driverDir = join(fixture.installDir, 'playwright-core');
    expect(existsSync(join(driverDir, 'package.json'))).toBe(true);
    expect(existsSync(join(driverDir, 'index.js'))).toBe(true);
    expect(existsSync(join(driverDir, 'cli.js'))).toBe(true);
    // The whole package travels, not just the entry files that get asserted.
    expect(readFileSync(join(driverDir, 'lib', 'marker.txt'), 'utf-8')).toContain('driver payload');
    expect(result.stdout).toContain('verified   browser-driver.tar.gz');
    expect(result.stdout).toContain(`installed  ${driverDir}`);
  });

  test('the driver is verified against the agent SHA256SUMS before anything is written', () => {
    const fixture = buildRelease();
    const result = runLib(callInstallDriver(fixture), envFor(fixture));
    // The manifest entry, not the download, is what authorises the install.
    expect(readFileSync(join(fixture.workDir, 'agent-SHA256SUMS.txt'), 'utf-8')).toContain('browser-driver.tar.gz');
    expect(result.stdout).toContain('verified');
  });

  test('a checksum mismatch is fatal and installs nothing', () => {
    const fixture = buildRelease({ corruptChecksum: true });
    const result = runLib(callInstallDriver(fixture), envFor(fixture));

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('checksum mismatch for browser-driver.tar.gz');
    expect(existsSync(join(fixture.installDir, 'playwright-core'))).toBe(false);
  });

  test('an archive without cli.js is refused — a driver that cannot install a browser is not a driver', () => {
    const fixture = buildRelease({ omitCli: true });
    const result = runLib(callInstallDriver(fixture), envFor(fixture));

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('playwright-core/cli.js');
    expect(existsSync(join(fixture.installDir, 'playwright-core'))).toBe(false);
  });

  test('a release that predates the asset is a note, not a failure (same convention as the sqlite-vec addon)', () => {
    const fixture = buildRelease({ omitManifestEntry: true });
    const result = runLib(callInstallDriver(fixture), envFor(fixture));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('does not ship browser-driver.tar.gz');
    // The honest consequence is named: the agent provisions one for itself.
    expect(result.stdout).toContain('install a browser driver for itself');
    expect(existsSync(join(fixture.installDir, 'playwright-core'))).toBe(false);
  });

  test('an existing driver is replaced rather than merged into', () => {
    const fixture = buildRelease();
    const driverDir = join(fixture.installDir, 'playwright-core');
    mkdirSync(driverDir, { recursive: true });
    writeFileSync(join(driverDir, 'stale-file.txt'), 'left over from an older release\n');

    const result = runLib(callInstallDriver(fixture), envFor(fixture));

    expect(result.code).toBe(0);
    expect(existsSync(join(driverDir, 'cli.js'))).toBe(true);
    // A stale file surviving the swap would mean two driver versions mixed into one
    // directory, which is exactly what the .incoming/rename dance prevents.
    expect(existsSync(join(driverDir, 'stale-file.txt'))).toBe(false);
  });

  test('install_agent installs the driver as part of installing the agent', () => {
    // The wiring itself is the guarantee: a driver installed by a separate
    // manual step is a driver most installs will not have.
    const source = readFileSync(INSTALL_SH, 'utf-8');
    const installAgent = source.slice(source.indexOf('install_agent() {'));
    const body = installAgent.slice(0, installAgent.indexOf('\n}\n'));
    expect(body).toContain('install_browser_driver');
  });

  test('uninstall removes the driver directory and the copy /update parks', () => {
    const source = readFileSync(INSTALL_SH, 'utf-8');
    const uninstall = source.slice(source.indexOf('run_uninstall() {'));
    expect(uninstall).toContain('$INSTALL_DIR/playwright-core');
    expect(uninstall).toContain('$INSTALL_DIR/playwright-core.previous');
  });
});

/**
 * Shell-level coverage for install_wake_word_model.
 *
 * The model ships with the installation now, and the rule that makes that
 * acceptable is that the installer cannot be failed by it. A stub
 * `goodvibes-daemon` stands in for the real binary.
 *
 * $INSTALL_DIR is assigned INSIDE the sourced script rather than through the
 * environment, and that is not a style choice: install.sh assigns
 * `INSTALL_DIR="${GOODVIBES_INSTALL_DIR:-$HOME/.local/bin}"` when it is sourced,
 * so an `INSTALL_DIR` handed in through env is overwritten and the function would
 * run the developer's REAL installed daemon binary.
 */
describe('install_wake_word_model', () => {
  /** An $INSTALL_DIR holding a stub goodvibes-daemon with the given behaviour. */
  function stubDaemon(prefix: string, body: string): string {
    const installDir = join(scratch(prefix), 'bin');
    mkdirSync(installDir, { recursive: true });
    const binary = join(installDir, 'goodvibes-daemon');
    writeFileSync(binary, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return installDir;
  }

  /** Run install_wake_word_model against a stub binary, never the real one. */
  function runWakeStep(installDir: string, wakeModel: string) {
    return runLib(`INSTALL_DIR="${installDir}"\nWITH_WAKE_MODEL="${wakeModel}"\ninstall_wake_word_model`, {});
  }

  test('it runs the installed binary and reports what the binary said', () => {
    const installDir = stubDaemon(
      'wake-sh-ok',
      'echo "wake-word model: Wake-word model installed and verified: hey goodvibes 1.0.0 (6.1 MB)."',
    );
    const result = runWakeStep(installDir, '1');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Installing the wake-word model');
    expect(result.stdout).toContain('installed and verified');
  });

  test('a FAILED download does not fail the install, and the reason still reaches the user', () => {
    // The whole point: an installer must not abort over an optional model.
    const installDir = stubDaemon(
      'wake-sh-degraded',
      'echo "wake-word model: The wake-word model could not be downloaded (DNS lookup failed); installation continues. Run /voice wake setup to retry."',
    );
    const result = runWakeStep(installDir, '1');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('installation continues');
    expect(result.stdout).toContain('/voice wake setup');
  });

  test('a binary that exits NON-ZERO still does not fail the install', () => {
    const installDir = stubDaemon('wake-sh-nonzero', 'echo "wake-word model: exploded"; exit 3');
    const result = runWakeStep(installDir, '1');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('exploded');
  });

  test('an older binary WITHOUT the subcommand is a note naming both recovery paths', () => {
    // Silence from the binary is how "this build predates the subcommand" looks.
    const installDir = stubDaemon('wake-sh-old', 'exit 2');
    const result = runWakeStep(installDir, '1');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('no provision-wake-model command');
    expect(result.stdout).toContain('next daemon start');
    expect(result.stdout).toContain('/voice wake setup');
  });

  test('GOODVIBES_WAKE_MODEL=0 skips it and says how to get the model later', () => {
    const installDir = stubDaemon('wake-sh-optout', 'echo "SHOULD NOT RUN"');
    const result = runWakeStep(installDir, '0');
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('SHOULD NOT RUN');
    expect(result.stdout).toContain('GOODVIBES_WAKE_MODEL=0');
    expect(result.stdout).toContain('/voice wake setup');
  });

  test('install.sh carries no wake-artifact pin of its own', () => {
    // A second copy of a URL or checksum in shell would drift the first time the
    // model is retrained, which is why this runs the binary instead of fetching.
    const source = readFileSync(INSTALL_SH, 'utf8');
    expect(source).not.toContain('voice-runtimes-v1');
    expect(source).toContain('provision-wake-model');
  });

  test('the model is placed BEFORE the daemon is restarted, so the restarted process sees it', () => {
    const source = readFileSync(INSTALL_SH, 'utf8');
    const main = source.slice(source.lastIndexOf('\nmain() {'));
    expect(main.indexOf('install_wake_word_model')).toBeGreaterThan(-1);
    expect(main.indexOf('install_wake_word_model')).toBeLessThan(main.indexOf('restart_running_daemon'));
  });

  test('the opt-in flag reads GOODVIBES_WAKE_MODEL and defaults to on', () => {
    const source = readFileSync(INSTALL_SH, 'utf8');
    expect(source).toContain('WITH_WAKE_MODEL="${GOODVIBES_WAKE_MODEL:-1}"');
  });
});
