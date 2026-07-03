// ---------------------------------------------------------------------------
// diff-runtime.test.ts — Wave 0 (W0.4 cluster) regression coverage:
//   (a) every Bun.spawn() call reachable from /diff captures stderr instead
//       of letting git's `fatal: ...` write straight to the real tty.
//   (b) /diff short-circuits with a friendly message in a non-git directory
//       instead of running git per-subcommand and surfacing inconsistent
//       error shapes.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerDiffRuntimeCommands } from '../../input/commands/diff-runtime.ts';
import { createShellPathService } from '@/runtime/index.ts';

/**
 * Every `Bun.spawn(` call site's option object must include `stderr:` — a
 * cheap static guard against reintroducing the tty-corruption bug: for a
 * spawned child with no explicit stdio option, Bun inherits stderr from the
 * parent process (verified directly: `Bun.spawn([...], { stdout: 'pipe' })`
 * in a non-git cwd writes git's `fatal:` text to the real stderr stream).
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

describe('(a) every /diff-reachable Bun.spawn call captures stderr', () => {
  test('diff-runtime.ts', () => {
    assertEverySpawnCapturesStderr(join(import.meta.dir, '../../input/commands/diff-runtime.ts'));
  });

  test('diff-panel.ts', () => {
    assertEverySpawnCapturesStderr(join(import.meta.dir, '../../panels/diff-panel.ts'));
  });
});

// ── (b) /diff in a non-git directory ────────────────────────────────────────

function makeCtx(dir: string): { ctx: CommandContext; printed: string[]; opened: string[]; fullRepaints: number } {
  const printed: string[] = [];
  const opened: string[] = [];
  let fullRepaints = 0;
  const panelManager = {
    getAllOpen: () => [] as { id: string }[],
    open: (id: string) => { opened.push(id); throw new Error('panel open should not be reached when not a git repo'); },
    activateById: () => {},
    isVisible: () => false,
    show: () => {},
  };
  const ctx = {
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    requestFullRepaint: () => { fullRepaints++; },
    focusPanels: () => {},
    exit: () => {},
    session: { changeTracker: { getChangedFiles: () => [] } },
    workspace: {
      shellPaths: createShellPathService({ workingDirectory: dir, homeDirectory: dir }),
      panelManager,
    },
    provider: {},
    platform: {},
    ops: {},
    extensions: {},
  } as unknown as CommandContext;
  return { ctx, printed, opened, fullRepaints };
}

describe('(b) /diff short-circuits in a non-git directory', () => {
  test('prints a friendly "not a git repository" message and never opens the diff panel', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-diff-runtime-nogit-'));
    try {
      const registry = new CommandRegistry();
      registerDiffRuntimeCommands(registry);
      const { ctx, printed, opened } = makeCtx(dir);

      await registry.execute('diff', [], ctx);

      expect(printed.some((line) => /not a git repository/i.test(line))).toBe(true);
      // None of the misleading per-subcommand success/failure text should appear.
      expect(printed.some((line) => /Diff panel updated/i.test(line))).toBe(false);
      expect(opened).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the same short-circuit applies to the working/head/staged subcommands too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-diff-runtime-nogit-'));
    try {
      const registry = new CommandRegistry();
      registerDiffRuntimeCommands(registry);
      for (const sub of ['working', 'head', 'staged']) {
        const { ctx, printed, opened } = makeCtx(dir);
        await registry.execute('diff', [sub], ctx);
        expect(printed.some((line) => /not a git repository/i.test(line))).toBe(true);
        expect(opened).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
