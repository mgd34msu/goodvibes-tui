// ---------------------------------------------------------------------------
// diff-runtime.test.ts, regression coverage:
//   (a) every Bun.spawn() call reachable from /diff captures stderr instead
//       of letting git's `fatal: ...` write straight to the real tty.
//   (b) /diff in a non-git directory opens the Changes modal, which
//       short-circuits with a friendly message (and an init offer) instead of
//       running git per view and surfacing inconsistent error shapes.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerDiffRuntimeCommands } from '../../input/commands/diff-runtime.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { ChangesModal } from '../../input/changes-modal.ts';
import type { ChangesSource } from '../../input/changes-git.ts';
import { layerTextBlock } from '../helpers/surface-frame.ts';

/**
 * Every `Bun.spawn(` call site's option object must include `stderr:`, a
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
  test('changes-git.ts (every git read and write behind /diff and the Changes modal)', () => {
    assertEverySpawnCapturesStderr(join(import.meta.dir, '../../input/changes-git.ts'));
  });

  test('diff-runtime.ts spawns nothing itself (it only opens the Changes modal)', () => {
    const src = readFileSync(join(import.meta.dir, '../../input/commands/diff-runtime.ts'), 'utf-8');
    expect(src).not.toContain('Bun.spawn(');
  });
});

// ── (b) /diff in a non-git directory ────────────────────────────────────────

function makeCtx(dir: string): { ctx: CommandContext; printed: string[]; opened: Array<ChangesSource | undefined> } {
  const printed: string[] = [];
  const opened: Array<ChangesSource | undefined> = [];
  const ctx = {
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    openChanges: (options?: { readonly source?: ChangesSource }) => { opened.push(options?.source); },
    exit: () => {},
    session: { changeTracker: { getChangedFiles: () => [] } },
    workspace: {
      shellPaths: createShellPathService({ workingDirectory: dir, homeDirectory: dir }),
    },
    provider: {},
    platform: {},
    ops: {},
    extensions: {},
  } as unknown as CommandContext;
  return { ctx, printed, opened };
}

describe('(b) /diff in a non-git directory', () => {
  test('/diff and its subcommands open the Changes modal on the matching view', async () => {
    const dir = makeProjectTempDir('gv-diff-runtime-nogit');
    try {
      const registry = new CommandRegistry();
      registerDiffRuntimeCommands(registry);
      const { ctx, opened } = makeCtx(dir);
      await registry.execute('diff', [], ctx);
      for (const sub of ['working', 'head', 'staged']) await registry.execute('diff', [sub], ctx);
      expect(opened).toEqual(['session', 'working', 'head', 'staged']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the Changes modal short-circuits with a friendly "not a git repository" message for every view', async () => {
    const dir = makeProjectTempDir('gv-diff-runtime-nogit');
    try {
      for (const source of ['session', 'working', 'head', 'staged'] as const) {
        const modal = new ChangesModal({ workingDirectory: dir, getSessionFiles: () => [], requestRender: () => {} });
        await modal.reload(source);
        expect(modal.notRepo).toBe(true);
        // No git diff ran: nothing loaded, no error text from git.
        expect(modal.files).toEqual([]);
        expect(modal.error).toBeNull();
        const text = layerTextBlock(modal.render(120, 40));
        expect(text).toMatch(/Not a git repository here/);
        expect(text).not.toMatch(/fatal:/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
