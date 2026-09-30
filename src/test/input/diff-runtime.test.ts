// ---------------------------------------------------------------------------
// diff-runtime.test.ts, regression coverage:
//   (a) every Bun.spawn() call reachable from /diff captures stderr instead
//       of letting git's `fatal: ...` write straight to the real tty.
//   (b) /diff in a non-git directory opens the Changes modal, which
//       short-circuits with a friendly message (and an init offer) instead of
//       running git per view and surfacing inconsistent error shapes.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerDiffRuntimeCommands } from '../../input/commands/diff-runtime.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { ChangesModal } from '../../input/changes-modal.ts';
import type { ChangesSource } from '../../input/changes-git.ts';
import { layerTextBlock } from '../helpers/surface-frame.ts';

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
