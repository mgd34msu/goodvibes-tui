/**
 * fatal-boot-report.test.ts — the daemon says why it will not start, proven in
 * a compiled binary.
 *
 * ── Why a compiled binary ─────────────────────────────────────────────────
 *
 * Because this defect is invisible to a source-level test, and that is not a
 * guess. Measured against the released 1.27.0 daemon binary in an isolated home
 * holding an unparseable `.goodvibes/daemon/settings.json`: exit 1, zero bytes
 * on stdout, zero bytes on stderr, and no activity log written at all. It
 * crash-looped 77 times overnight and the only signal the owner had was that
 * everything had stopped. The identical source run under `bun` printed the
 * reason loudly, because a `bun` process has a console the fatal handler's
 * logger can reach.
 *
 * The cause was neither buffering nor a bypassed handler: `src/daemon/cli.ts`
 * reported the failure to the activity LOGGER and exited, the entrypoint never
 * called `configureActivityLogger`, and so no file descriptor was ever touched.
 * A `logger.error` is not a disclosure.
 *
 * ── What is compiled, and why it is not cli.ts itself ─────────────────────
 *
 * Two fixture entries under `fixtures/`, each importing the REAL modules the
 * daemon boots through — `resolveGoodVibesHomeOwnership`, the SDK's
 * `ConfigManager` (whose daemon-tier read is what throws), and for the fixed
 * one the real `reportFatalBootFailure`. The fixed entry mirrors cli.ts's tail
 * exactly; the legacy entry pins the tail as it shipped.
 *
 * `src/daemon/cli.ts` compiles in under a second, and was measured directly
 * both before and after this change (zero/zero bytes → 728 bytes on stderr).
 * It is not what this test compiles, because the resulting artifact only RUNS
 * after `scripts/prebuild.ts` has rewritten
 * `node_modules/css-tree/lib/data-patch.js` — a transitive dependency of jsdom
 * — into a form `bun build --compile` can bundle. On a fresh checkout, which is
 * exactly what the CI test job has, the compiled entrypoint dies at module init
 * with `Cannot find module '../data/patch.json'` before any daemon code runs.
 * Measured both ways. Making the test mutate node_modules to work around that
 * would be a worse test than one that compiles the same real failure path with
 * none of jsdom's reach.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import {
  reportFatalBootFailure,
  writeExitingStdoutLine,
  writeFatalLine,
} from '../../daemon/fatal-boot-report.ts';

const REPO_ROOT = process.cwd();
/** Generous: two `bun build --compile` runs on a loaded host. */
const COMPILE_TIMEOUT_MS = 180_000;
/** The runs themselves fail fast — anything near this is a hang, not a boot. */
const RUN_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// The module itself, in process
// ---------------------------------------------------------------------------

describe('fatal-boot-report writes to descriptors, not to replaceable globals', () => {
  test('writeFatalLine reaches fd 2 even when process.stderr.write has been replaced', () => {
    // This repository really does replace process.stderr.write to keep the
    // rendered screen clean (runtime/terminal-output-guard.ts). A replacement
    // that records instead of printing is how a fatal reason becomes silence,
    // so the guarantee is that this write does not go through it at all.
    const run = runInlineWriter(
      `const captured = [];\n`
        + `process.stderr.write = ((chunk) => { captured.push(String(chunk)); return true; });\n`
        + `writeFatalLine('daemon refused to start: settings unreadable');\n`
        + `process.stdout.write('CAPTURED=' + captured.length + '\\n');`,
    );
    // The replacement saw nothing...
    expect(run.stdout).toBe('CAPTURED=0\n');
    // ...and the descriptor got the line anyway.
    expect(run.stderr).toBe('daemon refused to start: settings unreadable\n');
  });

  test('a line already ending in a newline is not given a second one', () => {
    // Asserted through a child process, because the only honest observation of
    // a descriptor write is what the descriptor received.
    const run = runInlineWriter(`writeFatalLine('one\\n'); writeFatalLine('two');`);
    expect(run.stderr).toBe('one\ntwo\n');
    expect(run.stdout).toBe('');
  });

  test('writeExitingStdoutLine goes to fd 1, and survives an immediate process.exit', () => {
    const run = runInlineWriter(`writeExitingStdoutLine('service unit installed'); process.exit(0);`);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('service unit installed\n');
    expect(run.stderr).toBe('');
  });

  test('reportFatalBootFailure names the context and the reason, and adds the stack', () => {
    const run = runInlineWriter(
      `const err = new Error('settings.json could not be read'); reportFatalBootFailure(err);`,
    );
    expect(run.stderr).toContain('goodvibes daemon host failed: settings.json could not be read');
    expect(run.stderr).toContain('Error: settings.json could not be read');
    expect(run.stderr).toContain('at ');
  });

  test('a caller-supplied context replaces the default label', () => {
    const run = runInlineWriter(`reportFatalBootFailure(new Error('boom'), 'goodvibes service install');`);
    expect(run.stderr).toContain('goodvibes service install failed: boom');
  });

  test('a non-Error value is still disclosed, with no stack invented for it', () => {
    const run = runInlineWriter(`reportFatalBootFailure('just a string');`);
    expect(run.stderr).toContain('just a string');
    expect(run.stderr).not.toContain('at ');
  });

  test('a closed descriptor does not turn a diagnostic into a second failure', () => {
    // The whole point of the try/catch inside writeLineToFd: this IS the
    // fallback, so it has nothing to fall back to and must not throw.
    const run = runInlineWriter(
      `import { closeSync } from 'node:fs';\n`
        + `closeSync(2); writeFatalLine('nobody can hear this'); process.stdout.write('SURVIVED\\n');`,
    );
    expect(run.stdout).toContain('SURVIVED');
    expect(run.status).toBe(0);
  });

  test('the exported surface is the SDK\'s, name for name, so the re-pin is a one-line import swap', () => {
    expect(typeof writeFatalLine).toBe('function');
    expect(typeof writeExitingStdoutLine).toBe('function');
    expect(typeof reportFatalBootFailure).toBe('function');
  });
});

interface InlineRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run one statement against the real module in a child `bun` process, so the
 * assertion is about what the descriptors received rather than about what a
 * spy was told.
 */
function runInlineWriter(body: string): InlineRun {
  const dir = makeProjectTempDir('gv-fatal-inline');
  const modulePath = join(REPO_ROOT, 'src', 'daemon', 'fatal-boot-report.ts');
  const script = join(dir, 'inline.ts');
  writeFileSync(
    script,
    `import { reportFatalBootFailure, writeExitingStdoutLine, writeFatalLine } from ${JSON.stringify(modulePath)};\n`
      + `void [reportFatalBootFailure, writeExitingStdoutLine, writeFatalLine];\n`
      + `${body}\n`,
    'utf-8',
  );
  const result = spawnSync(process.execPath, ['run', script], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: RUN_TIMEOUT_MS,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// ---------------------------------------------------------------------------
// The compiled artifacts
// ---------------------------------------------------------------------------

interface CompiledEntry {
  readonly binary: string;
  readonly dir: string;
}

/** The host's bun compile target, in the same shape toolchain.config.json names. */
function hostBunTarget(): string {
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `bun-${platform}-${arch}`;
}

/**
 * Compile one entry the way the release lane does — see
 * `buildCompileArgs` in @pellux/goodvibes-toolchain's build-binaries, which the
 * `build:daemon:*` scripts drive: `bun build <entry> --compile --target=<t>
 * --outfile <o> --external <nativeAddonPackage>`.
 */
function compileEntry(entry: string, name: string): CompiledEntry {
  const dir = makeProjectTempDir(`gv-compiled-${name}`);
  const binary = join(dir, name);
  const built = spawnSync(
    process.execPath,
    [
      'build',
      join(REPO_ROOT, entry),
      '--compile',
      `--target=${hostBunTarget()}`,
      '--outfile',
      binary,
      '--external',
      'sqlite-vec-linux-x64',
    ],
    { cwd: REPO_ROOT, encoding: 'utf-8', timeout: COMPILE_TIMEOUT_MS },
  );
  if (built.status !== 0) {
    throw new Error(`compiling ${entry} failed (${built.status}): ${built.stderr ?? ''}`);
  }
  return { binary, dir };
}

interface DaemonRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run a compiled entry against a throwaway home.
 *
 * The environment is built from nothing but what is passed — no ambient
 * `GOODVIBES_*` from the developer's shell can decide the outcome, which
 * matters because `GOODVIBES_HOME` and `GOODVIBES_DAEMON_HOME` would each move
 * the tree this reads.
 */
function runEntry(binary: string, home: string): DaemonRun {
  const result = spawnSync(binary, [], {
    encoding: 'utf-8',
    timeout: RUN_TIMEOUT_MS,
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: home,
      GOODVIBES_WORKING_DIR: join(home, 'work'),
    },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** A throwaway home whose daemon tier holds exactly `contents`. */
function homeWithDaemonSettings(contents: string, label: string): string {
  const home = makeProjectTempDir(label);
  mkdirSync(join(home, '.goodvibes', 'daemon'), { recursive: true });
  mkdirSync(join(home, 'work'), { recursive: true });
  writeFileSync(join(home, '.goodvibes', 'daemon', 'settings.json'), contents, 'utf-8');
  return home;
}

describe('the compiled daemon says why it will not start', () => {
  let fixed: CompiledEntry;
  let legacy: CompiledEntry;

  beforeAll(() => {
    fixed = compileEntry('src/test/daemon/fixtures/daemon-fatal-boot-entry.ts', 'gvd');
    legacy = compileEntry('src/test/daemon/fixtures/daemon-fatal-boot-legacy-entry.ts', 'gvd-legacy');
  }, COMPILE_TIMEOUT_MS);

  afterAll(() => {
    rmSync(fixed.dir, { recursive: true, force: true });
    rmSync(legacy.dir, { recursive: true, force: true });
  });

  test('the shape that shipped writes NOTHING to either stream — the baseline', () => {
    // Not an assumption about how a compiled binary flushes: a fatal handler
    // that only calls logger.error has no descriptor to flush, and the shipped
    // entrypoint never gave the logger a destination either. This is what an
    // operator saw for 77 crash-loops, held still so nobody restores it.
    const home = homeWithDaemonSettings('{ "controlPlane": { "port": 39153 }', 'gv-legacy-home');
    const run = runEntry(legacy.binary, home);
    expect(run.status).toBe(1);
    expect(run.stdout).toHaveLength(0);
    expect(run.stderr).toHaveLength(0);
  }, RUN_TIMEOUT_MS);

  test('an unparseable settings file names the file and the parse error on stderr', () => {
    const home = homeWithDaemonSettings('{ "controlPlane": { "port": 39153 }', 'gv-corrupt-home');
    const settingsPath = join(home, '.goodvibes', 'daemon', 'settings.json');

    const run = runEntry(fixed.binary, home);
    expect(run.status).toBe(1);
    expect(run.stderr.length).toBeGreaterThan(0);
    expect(run.stderr).toContain(settingsPath);
    expect(run.stderr).toContain('JSON Parse error');
    // The stack too: the reason alone does not say which read refused.
    expect(run.stderr).toContain('at ');
  }, RUN_TIMEOUT_MS);

  test('a settings file it CAN read still boots — the disclosure is not a new failure', () => {
    const home = homeWithDaemonSettings(JSON.stringify({ controlPlane: { port: 31111 } }), 'gv-ok-home');
    const run = runEntry(fixed.binary, home);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('BOOTED controlPlane.port=31111');
    expect(run.stderr).toHaveLength(0);
  }, RUN_TIMEOUT_MS);

  test('the reason also reaches the activity log, which the shipped entrypoint never configured', () => {
    // The stream line is the guarantee; the log line is what a person finds
    // hours later. The daemon entrypoint called neither before this change.
    const home = homeWithDaemonSettings('{ "controlPlane": { "port": 39153 }', 'gv-logged-home');
    const run = runEntry(fixed.binary, home);
    expect(run.status).toBe(1);
    const logDir = join(home, 'work', '.goodvibes', 'logs');
    const logged = readdirSafe(logDir)
      .map((name) => readFileSync(join(logDir, name), 'utf-8'))
      .join('\n');
    expect(logged).toContain('goodvibes daemon host failed');
  }, RUN_TIMEOUT_MS);
});

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
