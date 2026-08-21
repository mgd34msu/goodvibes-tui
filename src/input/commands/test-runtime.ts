import { loadPackageScripts, getSkippedGateReason } from '@pellux/goodvibes-sdk/platform/agents';
import type { ToolCall } from '@pellux/goodvibes-sdk/platform/types';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';

/**
 * Timeout for a /test run, in milliseconds. Deliberately much longer than
 * WRFC's WRFC_GATE_TIMEOUT_MS (120s, tuned for CI gates), this repo's own
 * suite is 600+ test files (scripts/run-tests.ts), and /test is an
 * interactive command with no other caller waiting on it.
 *
 * Exported (rather than a private const) so tests can pass a shorter override
 * straight through to runTestCommand's optional third parameter instead of
 * waiting out the real timeout.
 */
export const TEST_RUN_TIMEOUT_MS = 300_000;

/** How often buffered stdout/stderr lines are flushed to the transcript during
 * a run. Batching avoids hammering the transcript.append_one perf budget
 * (6ms, scripts/perf-baseline.json) with one ctx.print() call per output line. */
const STREAM_FLUSH_INTERVAL_MS = 250;

/** Cap on individually-listed failing test file names before truncating. */
const MAX_FAILING_NAMES_SHOWN = 20;

/** Lines of raw output shown when structured results could not be parsed. */
const RAW_TAIL_LINES = 30;

const FAIL_LINE_RE = /^==> (.+?)\s+\[FAIL\]$/gm;
const SUMMARY_LINE_RE = /^Test files: (\d+), passed: (\d+), failed: (\d+)$/m;
// Plain `bun test` output: " N pass" / " N fail" counters (tests, not files),
// "Ran N tests across M files.", and "(fail) suite > name" per failing test.
const BUN_PASS_RE = /^\s*(\d+) pass\s*$/m;
const BUN_FAIL_RE = /^\s*(\d+) fail\s*$/m;
const BUN_FILES_RE = /across (\d+) files?\./;
const BUN_FAIL_TEST_RE = /^\(fail\) (.+)$/gm;

interface ParsedTestResults {
  totalFiles: number;
  passed: number;
  failed: number;
  failingFiles: string[];
  /** Whether passed/failed count files (goodvibes runner) or tests (bun test). */
  unit: 'files' | 'tests';
}

/**
 * Parse this repo's own scripts/run-tests.ts output shape:
 *   per-file:  `==> path/to/file.test.ts  [FAIL]` (only present on failure)
 *   summary:   `Test files: N, passed: P, failed: F`
 * Returns null when the summary line isn't present at all, the fallback
 * path (raw tail, no fabricated counts) covers a different project's
 * jest/vitest/pytest output, or any run that bypassed run-tests.ts.
 */
export function parseTestOutput(output: string): ParsedTestResults | null {
  const summaryMatch = SUMMARY_LINE_RE.exec(output);
  if (summaryMatch) {
    const failingFiles: string[] = [];
    FAIL_LINE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FAIL_LINE_RE.exec(output)) !== null) {
      failingFiles.push(match[1]!);
    }
    return {
      totalFiles: Number(summaryMatch[1]),
      passed: Number(summaryMatch[2]),
      failed: Number(summaryMatch[3]),
      failingFiles,
      unit: 'files',
    };
  }
  // Plain `bun test`: counts are per-test, failing entries are test names.
  const bunPass = BUN_PASS_RE.exec(output);
  const bunFail = BUN_FAIL_RE.exec(output);
  if (bunPass && bunFail) {
    const failingTests: string[] = [];
    BUN_FAIL_TEST_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = BUN_FAIL_TEST_RE.exec(output)) !== null) {
      failingTests.push(match[1]!);
    }
    return {
      totalFiles: Number(BUN_FILES_RE.exec(output)?.[1] ?? 0),
      passed: Number(bunPass[1]),
      failed: Number(bunFail[1]),
      failingFiles: failingTests,
      unit: 'tests',
    };
  }
  return null;
}

/**
 * Single-quote shell-escape a value for safe interpolation into a
 * `/bin/sh -c` string: wrap in single quotes, turning any embedded single
 * quote into `'\''` (close quote, escaped literal quote, reopen quote).
 * Mirrors the injection-risk class already present in the SDK's
 * wrfc-gates.ts (executeGateCommand) and this repo's git-runtime.ts /
 * diff-runtime.ts, which build shell command strings the same way, a
 * pattern arg is never string-concatenated into the command raw.
 */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Reads a ReadableStream<Uint8Array> incrementally, decoding and forwarding
 * each chunk of text as it arrives (display-only accumulation happens in the
 * caller; this just pumps the stream to completion). */
async function pumpStream(
  stream: ReadableStream<Uint8Array> | undefined,
  onChunk: (text: string) => void,
): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    onChunk(decoder.decode(chunk, { stream: true }));
  }
}

export function registerTestRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'test',
    aliases: [],
    description: 'Run the project test script and show pass/fail results',
    usage: '[pattern]',
    argsHint: '[pattern]',
    async handler(args, ctx) {
      await runTestCommand(args, ctx);
    },
  });
}

/**
 * Core /test implementation, factored out of the registered handler so tests
 * can call it directly with a shortened `timeoutMs` override (the timeout
 * path would otherwise take TEST_RUN_TIMEOUT_MS to exercise).
 */
export async function runTestCommand(
  args: string[],
  ctx: CommandContext,
  timeoutMs: number = TEST_RUN_TIMEOUT_MS,
): Promise<void> {
  const cwd = requireShellPaths(ctx).workingDirectory;
  const pkgScripts = await loadPackageScripts(cwd);
  const skip = getSkippedGateReason('test', cwd, pkgScripts);
  if (skip) {
    ctx.print(skip);
    return;
  }

  const pattern = args.length > 0 ? args.join(' ') : undefined;
  const command = args.length > 0
    ? `${pkgScripts.test} ${args.map(shQuote).join(' ')}`
    : pkgScripts.test!;
  const toolCall: ToolCall = { id: 'test-run', name: 'test', arguments: pattern ? { pattern } : {} };

  ctx.print(`Running: ${command}`);

  const startedAt = Date.now();
  const proc = Bun.spawn(['/bin/sh', '-c', command], { cwd, stdout: 'pipe', stderr: 'pipe' });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  timer.unref?.();

  let combinedOutput = '';
  let pendingDisplay = '';
  const appendChunk = (text: string): void => {
    combinedOutput += text;
    pendingDisplay += text;
  };
  const flushDisplay = (force = false): void => {
    if (!pendingDisplay) return;
    if (force) {
      ctx.print(pendingDisplay);
      pendingDisplay = '';
      return;
    }
    const lastNewline = pendingDisplay.lastIndexOf('\n');
    if (lastNewline === -1) return; // no complete line buffered yet
    const toPrint = pendingDisplay.slice(0, lastNewline);
    pendingDisplay = pendingDisplay.slice(lastNewline + 1);
    if (toPrint) ctx.print(toPrint);
  };
  const flushTimer = setInterval(() => flushDisplay(false), STREAM_FLUSH_INTERVAL_MS);

  let exitCode: number;
  try {
    [exitCode] = await Promise.all([
      proc.exited,
      pumpStream(proc.stdout, appendChunk),
      pumpStream(proc.stderr, appendChunk),
    ]);
  } finally {
    clearTimeout(timer);
    clearInterval(flushTimer);
  }

  const durationMs = Date.now() - startedAt;

  if (timedOut) {
    flushDisplay(true);
    const timeoutSeconds = Math.round(timeoutMs / 1000);
    ctx.print(`Test run timed out after ${timeoutSeconds}s and was killed.`);
    ctx.session.conversationManager.logToolResultBlock(
      toolCall,
      'error',
      'timed out',
      durationMs,
      `timed out after ${timeoutSeconds}s`,
    );
    // Durable end state: logToolResultBlock (above) renders straight into the
    // display-only history buffer and never touches the real message list, so
    // it does not survive the next full rebuildHistory() (which rebuilds
    // strictly from conversationManager.getMessageSnapshot()), the very next
    // dirty render silently wipes it back to how the transcript looked before
    // /test ran. addSystemMessage persists the same content as a real message
    // (same durable pattern as /rewind's confirm notice in
    // checkpoint-runtime.ts) so the timeout outcome survives like any other
    // command's output. The streamed output during the run is allowed to stay
    // transient, only this final state needs to persist.
    ctx.session.conversationManager.addSystemMessage(
      `[Test] Timed out after ${timeoutSeconds}s and was killed.`,
    );
    ctx.renderRequest();
    return;
  }

  flushDisplay(true);

  const ok = exitCode === 0;
  const parsed = parseTestOutput(combinedOutput);

  if (parsed) {
    const summary = parsed.unit === 'files'
      ? `${parsed.passed}/${parsed.totalFiles} files passed`
      : `${parsed.passed} passed, ${parsed.failed} failed${parsed.totalFiles ? ` across ${parsed.totalFiles} file${parsed.totalFiles === 1 ? '' : 's'}` : ''}`;
    const failedNoun = parsed.unit === 'files' ? 'file' : 'test';
    const errorMsg = ok ? undefined : `${parsed.failed} ${failedNoun}${parsed.failed === 1 ? '' : 's'} failed`;
    ctx.session.conversationManager.logToolResultBlock(toolCall, ok ? 'done' : 'error', summary, durationMs, errorMsg);
    const durableLines = [`[Test] ${summary}${errorMsg ? `: ${errorMsg}` : ''}`];
    if (parsed.failingFiles.length > 0) {
      const shown = parsed.failingFiles.slice(0, MAX_FAILING_NAMES_SHOWN);
      const failListHeader = parsed.unit === 'files' ? 'Failing test files:' : 'Failing tests:';
      const lines = [failListHeader, ...shown.map((f) => `  - ${f}`)];
      const remaining = parsed.failingFiles.length - shown.length;
      if (remaining > 0) lines.push(`  ...and ${remaining} more`);
      ctx.print(lines.join('\n'));
      durableLines.push(...lines);
    }
    // See the timeout branch's comment above: logToolResultBlock's tool-styled
    // render is display-only and does not survive the next full history
    // rebuild. addSystemMessage persists the pass/fail summary AND the
    // failing-file detail as a real message so both remain in the transcript
    // after the command completes, not just during the ~1s before the next
    // render wipes the display-only copy.
    ctx.session.conversationManager.addSystemMessage(durableLines.join('\n'));
  } else {
    ctx.session.conversationManager.logToolResultBlock(
      toolCall,
      ok ? 'done' : 'error',
      `exit code ${exitCode}`,
      durationMs,
      ok ? undefined : `exit code ${exitCode}`,
    );
    const tail = combinedOutput.split('\n').slice(-RAW_TAIL_LINES).join('\n');
    ctx.print(`(could not parse structured test results; showing raw tail)\n${tail}`);
    ctx.session.conversationManager.addSystemMessage(
      `[Test] exit code ${exitCode} (could not parse structured test results)`,
    );
  }

  ctx.renderRequest();
}
