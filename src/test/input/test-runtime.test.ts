// ---------------------------------------------------------------------------
// test-runtime.test.ts — /test runner surface coverage:
//   (a) every Bun.spawn() call reachable from /test captures stderr (same
//       tty-corruption guard as diff-runtime.test.ts, extended to this file).
//   (b) no test script in package.json -> honest skip, no process spawned.
//   (c) happy path -> truthful parsed pass counts + a 'done' tool-result render.
//   (d) failure path -> truthful non-zero exit -> 'error' status + failing
//       file name surfaced.
//   (e) timeout path -> the process is killed and a timeout message prints,
//       never hangs.
//   (f) unrecognized output -> no fabricated counts, raw tail shown instead.
//   (g) shell-injection: a malicious pattern arg is rendered inert by shQuote,
//       both as a direct unit test of the quoting helper and as an
//       integration test that a malicious pattern never executes as a
//       second shell command.
//
// (b)-(f) each also assert that the command's final state (pass/fail summary,
// failing-file detail, timeout notice, or fallback exit code) is recorded via
// conversationManager.addSystemMessage — the durable path. logToolResultBlock
// and ctx.print only ever write into the display-only history buffer, which a
// later full rebuildHistory() (rebuilt strictly from getMessageSnapshot())
// wipes clean; without addSystemMessage the /test outcome would be visible
// only briefly during the run, then vanish with no scrollback record.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext } from '../../input/command-registry.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import {
  parseTestOutput,
  registerTestRuntimeCommands,
  runTestCommand,
  shQuote,
} from '../../input/commands/test-runtime.ts';
import { createShellPathService } from '@/runtime/index.ts';

/**
 * Every `Bun.spawn(` call site's option object must include `stderr:` — a
 * cheap static guard against reintroducing the tty-corruption bug fixed for
 * /diff (see diff-runtime.test.ts). Duplicated here (rather than imported)
 * because the original is a private test-file helper.
 */
function assertEverySpawnCapturesStderr(filePath: string): void {
  const src = readFileSync(filePath, 'utf-8');
  let idx = src.indexOf('Bun.spawn(');
  let checked = 0;
  while (idx !== -1) {
    const openParenIdx = idx + 'Bun.spawn'.length;
    let depth = 0;
    let end = -1;
    for (let i = openParenIdx; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    expect(end).toBeGreaterThan(-1);
    const callText = src.slice(openParenIdx, end);
    expect(callText).toContain('stderr:');
    checked++;
    idx = src.indexOf('Bun.spawn(', end);
  }
  expect(checked).toBeGreaterThan(0); // guard against a no-op scan (renamed/removed calls)
}

describe('(a) every /test-reachable Bun.spawn call captures stderr', () => {
  test('test-runtime.ts', () => {
    assertEverySpawnCapturesStderr(join(import.meta.dir, '../../input/commands/test-runtime.ts'));
  });
});

// ---------------------------------------------------------------------------
// Fake CommandContext harness
// ---------------------------------------------------------------------------

interface ToolResultCall {
  toolCall: { id: string; name: string; arguments: Record<string, unknown> };
  status: 'done' | 'error';
  resultSummary: string;
  durationMs: number;
  errorMsg?: string;
}

function makeCtx(
  dir: string,
): { ctx: CommandContext; printed: string[]; toolResults: ToolResultCall[]; systemMessages: string[] } {
  const printed: string[] = [];
  const toolResults: ToolResultCall[] = [];
  const systemMessages: string[] = [];
  const ctx = {
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    exit: () => {},
    session: {
      conversationManager: {
        logToolResultBlock: (
          toolCall: ToolResultCall['toolCall'],
          status: ToolResultCall['status'],
          resultSummary: string,
          durationMs: number,
          errorMsg?: string,
        ) => {
          toolResults.push({ toolCall, status, resultSummary, durationMs, errorMsg });
        },
        // addSystemMessage is the durable path (a real message in the
        // conversation model, unlike logToolResultBlock/ctx.print which only
        // ever write into the display-only history buffer). Tracked here so
        // tests can assert the /test end state actually persists.
        addSystemMessage: (text: string) => { systemMessages.push(text); },
      },
    },
    workspace: {
      shellPaths: createShellPathService({ workingDirectory: dir, homeDirectory: dir }),
    },
    provider: {},
    platform: {},
    ops: {},
    extensions: {},
  } as unknown as CommandContext;
  return { ctx, printed, toolResults, systemMessages };
}

function writePackageJson(dir: string, testScript: string | undefined): void {
  const scripts: Record<string, string> = {};
  if (testScript !== undefined) scripts.test = testScript;
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts }));
}

function withTmpDir(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-test-runtime-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// ---------------------------------------------------------------------------
// (b) no test script -> honest skip, no spawn
// ---------------------------------------------------------------------------

describe('(b) no test script in package.json', () => {
  test('prints exactly the skip reason and runs nothing', withTmpDir(async (dir) => {
    writePackageJson(dir, undefined);
    const { ctx, printed, toolResults, systemMessages } = makeCtx(dir);

    await runTestCommand([], ctx);

    expect(printed).toEqual(['Skipped: no test script in package.json']);
    expect(toolResults).toEqual([]);
    // A skip is not a run outcome — nothing durable should be recorded.
    expect(systemMessages).toEqual([]);
  }));
});

// ---------------------------------------------------------------------------
// (c) happy path
// ---------------------------------------------------------------------------

describe('(c) happy path', () => {
  test('parses passed/failed counts and renders a done status', withTmpDir(async (dir) => {
    writePackageJson(dir, 'printf "==> src/test/a.test.ts\\nTest files: 1, passed: 1, failed: 0\\n"');
    const { ctx, printed, toolResults, systemMessages } = makeCtx(dir);

    await runTestCommand([], ctx);

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.status).toBe('done');
    expect(toolResults[0]!.resultSummary).toBe('1/1 files passed');
    expect(printed.some((line) => /Failing test files/.test(line))).toBe(false);

    // Persistence: the pass/fail summary must be recorded via addSystemMessage
    // (a real conversation message — see ConversationManager.addSystemMessage
    // in src/core/conversation.ts), not just printed to the display-only
    // history buffer, so it survives the next full history rebuild instead of
    // vanishing like the display-only logToolResultBlock render does.
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]).toContain('1/1 files passed');
  }));
});

// ---------------------------------------------------------------------------
// (d) failure path
// ---------------------------------------------------------------------------

describe('(d) failure path', () => {
  test('truthful non-zero exit surfaces as error status with the failing file named', withTmpDir(async (dir) => {
    writePackageJson(
      dir,
      'printf "==> src/test/b.test.ts  [FAIL]\\nTest files: 1, passed: 0, failed: 1\\n"; exit 1',
    );
    const { ctx, printed, toolResults, systemMessages } = makeCtx(dir);

    await runTestCommand([], ctx);

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.status).toBe('error');
    expect(toolResults[0]!.errorMsg).toBe('1 file failed');
    expect(printed.some((line) => line.includes('src/test/b.test.ts'))).toBe(true);

    // Persistence: both the pass/fail summary AND the failing-file detail
    // must be in the durable message, not just the transient printed lines.
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]).toContain('0/1 files passed');
    expect(systemMessages[0]).toContain('1 file failed');
    expect(systemMessages[0]).toContain('src/test/b.test.ts');
  }));
});

// ---------------------------------------------------------------------------
// (e) timeout path
// ---------------------------------------------------------------------------

describe('(e) timeout path', () => {
  test('kills the process and prints a timeout message instead of hanging', withTmpDir(async (dir) => {
    writePackageJson(dir, 'sleep 5');
    const { ctx, printed, toolResults, systemMessages } = makeCtx(dir);

    await runTestCommand([], ctx, 50);

    expect(printed.some((line) => /timed out after/.test(line))).toBe(true);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.status).toBe('error');
    expect(toolResults[0]!.errorMsg).toMatch(/timed out/);

    // The timeout outcome is also a final state, not streaming — it must
    // persist the same way the pass/fail summary does.
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]).toMatch(/timed out/i);
  }), 10_000);
});

// ---------------------------------------------------------------------------
// (f) unrecognized-output fallback
// ---------------------------------------------------------------------------

describe('(f) unrecognized output fallback', () => {
  test('does not fabricate counts; shows exit code + raw tail instead', withTmpDir(async (dir) => {
    writePackageJson(dir, 'echo "some other output"; exit 1');
    const { ctx, printed, toolResults, systemMessages } = makeCtx(dir);

    await runTestCommand([], ctx);

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.resultSummary).toBe('exit code 1');
    expect(printed.some((line) => line.includes('could not parse structured test results'))).toBe(true);
    expect(printed.some((line) => line.includes('some other output'))).toBe(true);

    // Fallback path's compact summary must persist too, not just the raw
    // tail (which is allowed to stay transient — no fabricated counts here).
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]).toContain('exit code 1');
  }));

  test('parseTestOutput returns null when neither pattern matches', () => {
    expect(parseTestOutput('some other output\n')).toBeNull();
  });

  test('parseTestOutput parses plain bun test output (green)', () => {
    const out = 'bun test v1.3.14\n\n 5 pass\n 0 fail\n 12 expect() calls\nRan 5 tests across 2 files. [42.00ms]\n';
    expect(parseTestOutput(out)).toEqual({
      totalFiles: 2, passed: 5, failed: 0, failingFiles: [], unit: 'tests',
    });
  });

  test('parseTestOutput parses plain bun test output (red, with failing test names)', () => {
    const out = 'bun test v1.3.14\n(fail) todo CLI > done marks a todo complete [1.00ms]\n\n 4 pass\n 1 fail\n 10 expect() calls\nRan 5 tests across 2 files. [40.00ms]\n';
    expect(parseTestOutput(out)).toEqual({
      totalFiles: 2, passed: 4, failed: 1,
      failingFiles: ['todo CLI > done marks a todo complete [1.00ms]'], unit: 'tests',
    });
  });
});

// ---------------------------------------------------------------------------
// (g) shell-injection safety
// ---------------------------------------------------------------------------

describe('(g) shQuote', () => {
  test('wraps a plain value in single quotes', () => {
    expect(shQuote('diff-runtime')).toBe("'diff-runtime'");
  });

  test('escapes an embedded single quote', () => {
    expect(shQuote("it's")).toBe("'it'\\''s'");
  });

  test('renders a shell-injection attempt as an inert single literal', () => {
    const malicious = '; rm -rf /tmp/x';
    expect(shQuote(malicious)).toBe(`'${malicious}'`);
  });
});

describe('(g) integration: a malicious pattern does not execute as a second command', () => {
  test('a semicolon-bearing pattern arg is passed through as inert literal text', withTmpDir(async (dir) => {
    const markerPath = join(dir, 'should-not-exist');
    writePackageJson(dir, 'echo'); // echoes back whatever args it's given
    const { ctx } = makeCtx(dir);

    await runTestCommand([`; touch ${markerPath}`], ctx);

    expect(existsSync(markerPath)).toBe(false);
  }));

  test('a multi-token injection attempt is also inert (each token individually quoted)', withTmpDir(async (dir) => {
    const markerPath = join(dir, 'should-not-exist-2');
    writePackageJson(dir, 'echo');
    const { ctx } = makeCtx(dir);

    await runTestCommand([';', 'touch', markerPath], ctx);

    expect(existsSync(markerPath)).toBe(false);
  }));
});

// ---------------------------------------------------------------------------
// (h) registration sanity — /test is registered with the expected shape.
// command-grammar.test.ts and command-aliases-lint.test.ts already validate
// naming/description conventions repo-wide once registered; this just checks
// the command exists under the expected name.
// ---------------------------------------------------------------------------

describe('(h) registration', () => {
  test('/test is registered', () => {
    const registry = new CommandRegistry();
    registerTestRuntimeCommands(registry);
    const cmd = registry.getAll().find((c) => c.name === 'test');
    expect(cmd).toBeDefined();
    expect(cmd?.usage).toBe('[pattern]');
  });
});
