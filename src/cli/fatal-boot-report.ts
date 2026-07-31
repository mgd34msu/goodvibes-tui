/**
 * fatal-boot-report.ts — saying why, on a stream, before the process stops.
 *
 * ── Where this module comes from ──────────────────────────────────────────
 *
 * This is a local mirror of the SDK's `platform/daemon/fatal-boot-report.ts`,
 * kept identical in shape and in exported names (`writeFatalLine`,
 * `writeExitingStdoutLine`, `reportFatalBootFailure`). It lives here only
 * because the published `@pellux/goodvibes-sdk` this repository compiles
 * against predates that export — importing it would not typecheck and CI
 * builds against the published package regardless. Delete this file and switch
 * every importer to the SDK's copy at the next re-pin — but check the SDK's
 * `package.json` "exports" map first: as of the 1.21.0 re-pin (2026-07-30),
 * the compiled `dist/platform/daemon/fatal-boot-report.js` still exists
 * inside the published tarball and `cli.js` still imports it internally, but
 * there is no `./platform/daemon/fatal-boot-report` (or any other) entry in
 * "exports" that makes it importable from outside the package — confirmed by
 * attempting `import { reportFatalBootFailure } from
 * '@pellux/goodvibes-sdk/platform/daemon/fatal-boot-report'`, which Bun
 * refuses to resolve. This file stays load-bearing until a future SDK release
 * adds that subpath export.
 *
 * ── The failure this exists to close ──────────────────────────────────────
 *
 * The shipped daemon died mute. Measured, against the released 1.27.0 binary
 * in an isolated home with an unparseable `.goodvibes/daemon/settings.json`:
 * exit code 1, **zero bytes on stdout, zero bytes on stderr, and no activity
 * log written at all**. It crash-looped 77 times overnight and the only signal
 * an operator had was that everything had stopped.
 *
 * The mechanism was not buffering and not a bypassed handler. It was simpler:
 * `daemon/cli.ts` reported the failure to the activity LOGGER and exited, and
 * at that point in boot the logger had no destination — the daemon entrypoint
 * never called `configureActivityLogger` at all — so the line went nowhere and
 * no file descriptor was ever touched. A `logger.error` is not a disclosure.
 * Only a write to a file descriptor is.
 *
 * ── Why `writeSync(2, …)` and not `process.stderr.write` ──────────────────
 *
 * Because the fatal path must not depend on anything a host can replace or
 * defer. `process.stderr.write` is a property on a mutable global, and THIS
 * repository is the one that replaces it: `src/runtime/terminal-output-guard.ts`
 * intercepts terminal output to keep the rendered screen clean, and a replaced
 * writer that records instead of printing turns a fatal error into silence. It
 * is also a stream, so a write issued immediately before `process.exit()` can
 * still be in flight when the process stops existing.
 *
 * `writeSync(fd, …)` is neither. It is a direct write to the descriptor the
 * service journal is attached to, it has completed when it returns, and no
 * amount of replacing `process.stderr` upstream can intercept it. That is the
 * whole property this module provides, and it is why every early-exit site in
 * the daemon boot path routes through here.
 */

import { writeSync } from 'node:fs';
import { flushActivityLogSync, logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

/** stdout and stderr, as the file descriptors they actually are. */
const STDOUT_FD = 1;
const STDERR_FD = 2;

function writeLineToFd(fd: number, line: string): void {
  try {
    writeSync(fd, line.endsWith('\n') ? line : `${line}\n`);
  } catch {
    // A closed or unwritable descriptor must never turn a diagnostic into a
    // second failure. There is nothing further to fall back to: this IS the
    // fallback.
  }
}

/**
 * Write one line to stderr synchronously, immune to a replaced
 * `process.stderr` and to exit-time truncation. Use this for anything that
 * gates a process exit.
 */
export function writeFatalLine(line: string): void {
  writeLineToFd(STDERR_FD, line);
}

/**
 * The stdout twin, for output that must survive an exit that follows it — the
 * help text, the version line, the service-subcommand receipt and the cluster
 * output are all printed and then immediately exited on, which is the same
 * race.
 */
export function writeExitingStdoutLine(line: string): void {
  writeLineToFd(STDOUT_FD, line);
}

/**
 * Report a fatal boot failure everywhere it can be found, then leave the exit
 * to the caller.
 *
 * The stream write happens FIRST and synchronously. The activity log is
 * attempted after, because it is the part that can fail — it needs a
 * configured destination, a writable directory, and a flush — and the
 * guarantee this function makes is the stream line, not the log line.
 */
export function reportFatalBootFailure(error: unknown, context = 'goodvibes daemon host'): void {
  const summary = summarizeError(error);
  writeFatalLine(`${context} failed: ${summary}`);
  if (error instanceof Error && error.stack) writeFatalLine(error.stack);
  try {
    logger.error(`${context} failed`, { error: summary });
    flushActivityLogSync();
  } catch {
    // The reason is already on stderr, which is the guarantee. A log that
    // cannot be written must not escalate into a different failure.
  }
}
