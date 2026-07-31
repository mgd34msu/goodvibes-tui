/**
 * fatal-boot-report.test.ts — writing the reason to a DESCRIPTOR, not to a
 * console that may not be there.
 *
 * ── The defect this module exists for ─────────────────────────────────────
 *
 * A compiled GoodVibes binary in an isolated home holding an unparseable
 * `.goodvibes/daemon/settings.json` exited 1 with zero bytes on stdout, zero on
 * stderr, and no activity log at all. It crash-looped 77 times overnight and
 * the only signal the owner had was that everything had stopped. The identical
 * source run under `bun` printed the reason loudly, because a `bun` process has
 * a console the fatal handler's logger can reach and a compiled one does not.
 *
 * The cause was neither buffering nor a bypassed handler: the failure was
 * reported to the activity LOGGER, the entrypoint never called
 * `configureActivityLogger`, and so no file descriptor was ever touched. A
 * `logger.error` is not a disclosure.
 *
 * ── What this file covers now ─────────────────────────────────────────────
 *
 * The module, in process: that it writes to descriptor 2 and descriptor 1
 * directly, so a replaced `console`, a torn-down stream, or a process with no
 * console at all cannot swallow the reason. `cli/tui-startup.ts` is the caller
 * — this app has its own version of the same failure, and this is what makes it
 * say so.
 *
 * The end-to-end half — compiling a daemon entry, feeding it a corrupt settings
 * file, and reading the reason back off stderr and the activity log — went with
 * the daemon to its own repository. It boots a daemon, and there is no longer
 * one here to boot.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import {
  reportFatalBootFailure,
  writeExitingStdoutLine,
  writeFatalLine,
} from '@pellux/goodvibes-sdk/platform/daemon';

const REPO_ROOT = process.cwd();
/** The runs themselves fail fast — anything near this is a hang, not a write. */
const RUN_TIMEOUT_MS = 30_000;

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
  const modulePath = '@pellux/goodvibes-sdk/platform/daemon';
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

/*
 * The compiled-daemon boot-honesty suite that used to live here — the one that
 * built a daemon entry, fed it an unparseable settings file, and proved the
 * reason reached stderr and the activity log — went with the daemon. It boots a
 * daemon, and this repository no longer contains one to boot; the daemon
 * repository runs it against its own entry point, which is where a regression
 * in daemon boot honesty would actually appear.
 *
 * What stays here is the module itself: writeFatalLine is what
 * cli/tui-startup.ts uses to say why THIS app could not start, and the
 * descriptor-level guarantees above are what make that reliable when a
 * replaced console or a torn-down stream would swallow it.
 */
