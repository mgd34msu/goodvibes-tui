import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/**
 * Shell-level coverage for the installer's PATH-shadowing check.
 *
 * Installing a file is not the same as making it reachable. A leftover
 * `~/.bun/bin/goodvibes-agent` (a `bun add -g` link, 1.18.1) at PATH position 2
 * beat `~/.local/bin/goodvibes-agent` (1.21.0) at position 21: two successful
 * installs in a row, the auto-updater faithfully maintaining a file the shell
 * never ran, an old build answering, and a version number reporting itself
 * current the whole time. These tests pin the behaviour that prevents that:
 * the shadow is found, named with both versions, resolved only when the
 * shadowing copy is recognisably one of our own programs, and the install
 * fails when it stays unreachable.
 *
 * install.sh is sourced as a library (GOODVIBES_INSTALL_SH_LIB=1), so nothing
 * here downloads anything, writes to a real install directory, or touches a
 * running process. Every "binary" is a small shell script that prints the
 * `<command> <version>` line our commands print.
 */

const INSTALL_SH = join(import.meta.dir, '../../../scripts/install.sh');

/**
 * Scratch trees live under the repo's own `.test-tmp`, not the system temp
 * directory. A signal-killed test process (a `timeout` wrapper, the runner
 * killing a hung file) skips every cleanup hook, and thousands of leaked
 * `mkdtemp` trees under /tmp is what exhausts a tmpfs's inodes; `.test-tmp` is
 * age-swept by scripts/stale-tmp-sweep.ts, so a leak there is bounded.
 */
function scratch(prefix: string): string {
  return makeProjectTempDir(prefix);
}

/** Writes an executable that answers `--version` with `line`. */
function writeFakeCommand(path: string, line: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${line}"; fi\n`);
  chmodSync(path, 0o755);
}

interface Host {
  readonly home: string;
  readonly installDir: string;
  /** A directory holding stub package managers; prepended to the real PATH. */
  readonly toolsDir: string;
}

function makeHost(prefix = 'gv-shadow'): Host {
  const home = scratch(prefix);
  const installDir = join(home, '.local', 'bin');
  const toolsDir = join(home, '.tools');
  mkdirSync(installDir, { recursive: true });
  mkdirSync(toolsDir, { recursive: true });
  return { home, installDir, toolsDir };
}

/**
 * Sources install.sh as a library and runs `body` with HOME and INSTALL_DIR
 * pointed at the scratch host. `shadowPath` IS the process PATH the check
 * reasons about — no test-only hook into the script — with the stub-tool
 * directory in front (it holds no goodvibes command, so it cannot change a
 * verdict) and /usr/bin:/bin behind it so `awk` and `rm` resolve.
 */
function runLib(options: {
  readonly host: Host;
  readonly body: string;
  readonly shadowPath: readonly string[];
  readonly env?: Record<string, string>;
}): { stdout: string; stderr: string; code: number } {
  const script = [
    `. "${INSTALL_SH}"`,
    `INSTALL_DIR="${options.host.installDir}"`,
    options.body,
  ].join('\n');
  const result = Bun.spawnSync(['sh', '-c', script], {
    env: {
      ...process.env,
      HOME: options.host.home,
      PATH: [options.host.toolsDir, ...options.shadowPath, '/usr/bin', '/bin'].join(':'),
      GOODVIBES_INSTALL_SH_LIB: '1',
      GOODVIBES_SHADOW_REMOVE: '0',
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    code: result.exitCode ?? -1,
  };
}

/** The scenario that happened: a bun global link earlier on PATH than the install. */
function bunGlobalShadow(host: Host): { readonly bunBin: string; readonly linkPath: string } {
  const bunBin = join(host.home, '.bun', 'bin');
  const packageBin = join(
    host.home,
    '.bun',
    'install',
    'global',
    'node_modules',
    '@pellux',
    'goodvibes-agent',
    'bin',
  );
  mkdirSync(bunBin, { recursive: true });
  writeFakeCommand(join(packageBin, 'goodvibes-agent'), 'goodvibes-agent 1.18.1');
  const linkPath = join(bunBin, 'goodvibes-agent');
  symlinkSync(join(packageBin, 'goodvibes-agent'), linkPath);
  writeFakeCommand(join(host.installDir, 'goodvibes-agent'), 'goodvibes-agent 1.21.0');
  return { bunBin, linkPath };
}

describe('a shadowing install is detected and reported', () => {
  test('the earlier-PATH copy is named as the winner, with both versions and the fix', () => {
    const host = makeHost();
    const { bunBin, linkPath } = bunGlobalShadow(host);

    const result = runLib({
      host,
      shadowPath: [join(host.home, 'bin'), bunBin, '/usr/bin', host.installDir],
      body: 'verdict=0; check_command_shadowing goodvibes-agent || verdict=$?; echo "verdict=$verdict"',
    });

    expect(result.stdout).toContain('does not run the copy this installer maintains');
    expect(result.stdout).toContain(`wins on PATH: ${linkPath} (version 1.18.1)`);
    expect(result.stdout).toContain(
      `installed here: ${join(host.installDir, 'goodvibes-agent')} (version 1.21.0)`,
    );
    expect(result.stdout).toContain('bun remove -g @pellux/goodvibes-agent');
    expect(result.stdout).toMatch(/^verdict=1$/m);
  });

  test('the whole-install verdict exits non-zero while the shadow remains', () => {
    const host = makeHost();
    const { bunBin } = bunGlobalShadow(host);
    writeFakeCommand(join(host.installDir, 'goodvibes'), 'goodvibes 1.25.0');

    const result = runLib({
      host,
      shadowPath: [bunBin, host.installDir],
      body: 'resolve_path_shadows; echo "unresolved=$PATH_SHADOW_UNRESOLVED"',
    });

    expect(result.stdout).toMatch(/^unresolved=1$/m);
  });

  test('an install directory missing from PATH is reported as unreachable too', () => {
    const host = makeHost();
    writeFakeCommand(join(host.installDir, 'goodvibes'), 'goodvibes 1.25.0');

    const result = runLib({
      host,
      shadowPath: ['/usr/bin'],
      body: 'verdict=0; check_command_shadowing goodvibes || verdict=$?; echo "verdict=$verdict"',
    });

    expect(result.stdout).toContain('is not on your PATH');
    expect(result.stdout).toMatch(/^verdict=1$/m);
  });
});

describe('a non-shadowing install is not falsely flagged', () => {
  test('the install directory first on PATH reports nothing', () => {
    const host = makeHost();
    for (const command of ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent']) {
      writeFakeCommand(join(host.installDir, command), `${command} 1.25.0`);
    }

    const result = runLib({
      host,
      shadowPath: [host.installDir, '/usr/bin'],
      body: 'resolve_path_shadows; echo "unresolved=$PATH_SHADOW_UNRESOLVED"',
    });

    expect(result.stdout).toMatch(/^unresolved=0$/m);
    expect(result.stdout).not.toContain('PROBLEM');
  });

  test('a second copy LATER on PATH loses, so it is not a shadow', () => {
    const host = makeHost();
    const { bunBin } = bunGlobalShadow(host);

    const result = runLib({
      host,
      shadowPath: [host.installDir, bunBin],
      body: 'verdict=0; check_command_shadowing goodvibes-agent || verdict=$?; echo "verdict=$verdict"',
    });

    expect(result.stdout).toMatch(/^verdict=0$/m);
    expect(result.stdout).not.toContain('PROBLEM');
  });

  test('the install directory listed twice on PATH is not a self-shadow', () => {
    const host = makeHost();
    writeFakeCommand(join(host.installDir, 'goodvibes'), 'goodvibes 1.25.0');

    const result = runLib({
      host,
      shadowPath: [`${host.installDir}/`, '/usr/bin', host.installDir],
      body: 'verdict=0; check_command_shadowing goodvibes || verdict=$?; echo "verdict=$verdict"',
    });

    expect(result.stdout).toMatch(/^verdict=0$/m);
  });

  test('a command this install does not provide is left alone entirely', () => {
    const host = makeHost();
    const otherBin = join(host.home, 'bin');
    writeFakeCommand(join(otherBin, 'goodvibes-agent'), 'goodvibes-agent 1.18.1');

    const result = runLib({
      host,
      shadowPath: [otherBin, host.installDir],
      body: 'verdict=0; check_command_shadowing goodvibes-agent || verdict=$?; echo "verdict=$verdict"',
    });

    expect(result.stdout).toMatch(/^verdict=0$/m);
    expect(existsSync(join(otherBin, 'goodvibes-agent'))).toBe(true);
  });
});

describe('resolution removes only recognised copies of our own program', () => {
  test('a package link is removed through its package manager, not by deleting the link', () => {
    const host = makeHost();
    const { bunBin, linkPath } = bunGlobalShadow(host);
    // A stub `bun` that records its arguments and performs the uninstall the
    // real one would. It is on the process PATH, not the scanned PATH.
    const receipt = join(host.home, 'bun-args.txt');
    writeFileSync(
      join(host.toolsDir, 'bun'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${receipt}"\nrm -f "${linkPath}"\n`,
    );
    chmodSync(join(host.toolsDir, 'bun'), 0o755);

    const result = runLib({
      host,
      shadowPath: [bunBin, host.installDir],
      env: { GOODVIBES_SHADOW_REMOVE: '1' },
      body: 'verdict=0; check_command_shadowing goodvibes-agent || verdict=$?; echo "verdict=$verdict"; cat "' + receipt + '"',
    });

    expect(result.stdout).toContain('remove -g @pellux/goodvibes-agent');
    expect(result.stdout).toMatch(/^verdict=0$/m);
    expect(existsSync(linkPath)).toBe(false);
  });

  test('a standalone earlier install that answers --version as us is deleted', () => {
    const host = makeHost();
    const otherBin = join(host.home, 'bin');
    writeFakeCommand(join(otherBin, 'goodvibes-agent'), 'goodvibes-agent 1.14.0');
    writeFakeCommand(join(host.installDir, 'goodvibes-agent'), 'goodvibes-agent 1.21.0');

    const result = runLib({
      host,
      shadowPath: [otherBin, host.installDir],
      env: { GOODVIBES_SHADOW_REMOVE: '1' },
      body: 'verdict=0; check_command_shadowing goodvibes-agent || verdict=$?; echo "verdict=$verdict"',
    });

    expect(result.stdout).toMatch(/^verdict=0$/m);
    expect(existsSync(join(otherBin, 'goodvibes-agent'))).toBe(false);
  });

  test('an unrelated program with the same name is reported and never deleted', () => {
    const host = makeHost();
    const otherBin = join(host.home, 'bin');
    const stranger = join(otherBin, 'goodvibes');
    writeFakeCommand(stranger, 'someone-elses-tool 3.2.1');
    writeFakeCommand(join(host.installDir, 'goodvibes'), 'goodvibes 1.25.0');

    const result = runLib({
      host,
      shadowPath: [otherBin, host.installDir],
      env: { GOODVIBES_SHADOW_REMOVE: '1' },
      body: 'verdict=0; check_command_shadowing goodvibes || verdict=$?; echo "verdict=$verdict"',
    });

    expect(result.stdout).toContain('not something we can identify as');
    expect(result.stdout).toMatch(/^verdict=1$/m);
    expect(existsSync(stranger)).toBe(true);
  });

  test('a copy outside the home directory is reported and never touched', () => {
    const host = makeHost();
    // A second scratch tree standing in for a system directory: it is not
    // under $HOME, so however well we recognise it, it is not ours to remove.
    const systemBin = scratch('gv-shadow-system');
    writeFakeCommand(join(systemBin, 'goodvibes-agent'), 'goodvibes-agent 1.18.1');
    writeFakeCommand(join(host.installDir, 'goodvibes-agent'), 'goodvibes-agent 1.21.0');

    const result = runLib({
      host,
      shadowPath: [systemBin, host.installDir],
      env: { GOODVIBES_SHADOW_REMOVE: '1' },
      body: 'verdict=0; check_command_shadowing goodvibes-agent || verdict=$?; echo "verdict=$verdict"',
    });

    expect(result.stdout).toContain('not something we can identify as');
    expect(result.stdout).toMatch(/^verdict=1$/m);
    expect(existsSync(join(systemBin, 'goodvibes-agent'))).toBe(true);
  });

  test('a link that escapes the home directory is reported and never touched', () => {
    const host = makeHost();
    const outside = scratch('gv-shadow-outside');
    writeFakeCommand(join(outside, 'node_modules', '@pellux', 'goodvibes-agent', 'bin', 'goodvibes-agent'), 'goodvibes-agent 1.18.1');
    const otherBin = join(host.home, 'bin');
    mkdirSync(otherBin, { recursive: true });
    symlinkSync(
      join(outside, 'node_modules', '@pellux', 'goodvibes-agent', 'bin', 'goodvibes-agent'),
      join(otherBin, 'goodvibes-agent'),
    );
    writeFakeCommand(join(host.installDir, 'goodvibes-agent'), 'goodvibes-agent 1.21.0');

    const result = runLib({
      host,
      shadowPath: [otherBin, host.installDir],
      env: { GOODVIBES_SHADOW_REMOVE: '1' },
      body: 'verdict=0; check_command_shadowing goodvibes-agent || verdict=$?; echo "verdict=$verdict"',
    });

    expect(result.stdout).toMatch(/^verdict=1$/m);
    expect(existsSync(join(otherBin, 'goodvibes-agent'))).toBe(true);
  });

  test('with removal switched off, nothing is deleted and the verdict stays failed', () => {
    const host = makeHost();
    const otherBin = join(host.home, 'bin');
    writeFakeCommand(join(otherBin, 'goodvibes-agent'), 'goodvibes-agent 1.14.0');
    writeFakeCommand(join(host.installDir, 'goodvibes-agent'), 'goodvibes-agent 1.21.0');

    const result = runLib({
      host,
      shadowPath: [otherBin, host.installDir],
      env: { GOODVIBES_SHADOW_REMOVE: '0' },
      body: 'verdict=0; check_command_shadowing goodvibes-agent || verdict=$?; echo "verdict=$verdict"',
    });

    expect(result.stdout).toMatch(/^verdict=1$/m);
    expect(existsSync(join(otherBin, 'goodvibes-agent'))).toBe(true);
  });
});

describe('the pieces the verdict is built from', () => {
  test('an npm-style global link is removed with npm, a bun one with bun', () => {
    const host = makeHost();
    const npmLink = join(host.home, '.npm-global', 'lib', 'node_modules', '@pellux', 'goodvibes-tui', 'bin', 'goodvibes');
    writeFakeCommand(npmLink, 'goodvibes 1.10.0');
    const result = runLib({
      host,
      shadowPath: ['/usr/bin'],
      body: [
        `shadow_removal_command package @pellux/goodvibes-tui "${npmLink}"`,
        `shadow_removal_command package @pellux/goodvibes-agent "${host.home}/.bun/install/global/node_modules/@pellux/goodvibes-agent/bin/goodvibes-agent"`,
      ].join('\n'),
    });
    expect(result.stdout).toContain('npm rm -g @pellux/goodvibes-tui');
    expect(result.stdout).toContain('bun remove -g @pellux/goodvibes-agent');
  });

  test('a nested install belongs to the innermost package, and other scopes are not ours', () => {
    const host = makeHost();
    const result = runLib({
      host,
      shadowPath: ['/usr/bin'],
      body: [
        'shadow_owning_package /x/node_modules/@other/thing/node_modules/@pellux/goodvibes-tui/bin/g',
        'echo "---"',
        'shadow_owning_package /x/node_modules/@pellux/goodvibes-tui/node_modules/@other/thing/bin/g',
        'echo "---"',
        'shadow_owning_package /x/node_modules/@pellux/something-else/bin/g',
        'echo "---"',
        'shadow_owning_package /usr/local/bin/goodvibes',
      ].join('\n'),
    });
    const sections = result.stdout.split('---').map((section) => section.trim());
    expect(sections[0]).toBe('@pellux/goodvibes-tui');
    expect(sections[1]).toBe('');
    expect(sections[2]).toBe('');
    expect(sections[3]).toBe('');
  });

  test('only the exact version shape our commands print counts as identification', () => {
    const host = makeHost();
    const probes = join(host.home, 'probes');
    writeFakeCommand(join(probes, 'ours'), 'goodvibes-agent 1.18.1');
    writeFakeCommand(join(probes, 'prefixed'), 'goodvibes-agent v1.18.1');
    writeFakeCommand(join(probes, 'stranger'), 'GNU coreutils 9.4');
    writeFakeCommand(join(probes, 'usage'), 'usage: goodvibes-agent [options]');
    writeFileSync(join(probes, 'silent'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(probes, 'silent'), 0o755);

    const result = runLib({
      host,
      shadowPath: ['/usr/bin'],
      body: [
        `for probe in ours prefixed stranger usage silent; do`,
        `  printf '%s=[%s]\\n' "$probe" "$(shadow_version_of "${probes}/$probe" goodvibes-agent)"`,
        `done`,
      ].join('\n'),
    });

    expect(result.stdout).toContain('ours=[1.18.1]');
    expect(result.stdout).toContain('prefixed=[1.18.1]');
    expect(result.stdout).toContain('stranger=[]');
    expect(result.stdout).toContain('usage=[]');
    expect(result.stdout).toContain('silent=[]');
  });

  test('the effective PATH counts the install directory once the rc line will prepend it', () => {
    const host = makeHost();
    const rc = join(host.home, '.profile');
    writeFileSync(rc, '\n# managed by goodvibes install.sh\nexport PATH="$HOME/.local/bin:$PATH"\n');
    writeFakeCommand(join(host.installDir, 'goodvibes'), 'goodvibes 1.25.0');

    const result = runLib({
      host,
      shadowPath: ['/usr/bin'],
      env: { SHELL: '/bin/sh' },
      body: 'resolve_path_shadows; echo "unresolved=$PATH_SHADOW_UNRESOLVED"',
    });

    expect(result.stdout).toMatch(/^unresolved=0$/m);
    expect(result.stdout).not.toContain('is not on your PATH');
  });
});
