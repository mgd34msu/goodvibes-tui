// ---------------------------------------------------------------------------
// git-diff-structured.test.ts (STEP 2c) — /git diff routes the FULL, uncapped
// working-tree diff into the real diff panel via GitService.diffStructured.
// The old path sliced the raw text at 4,000 chars and printed a
// "(diff truncated)" stub; that branch is gone.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerGitRuntimeCommands } from '../../input/commands/git-runtime.ts';
import { createShellPathService } from '@/runtime/index.ts';
import type { StructuredDiff } from '@pellux/goodvibes-sdk/platform/git';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function sh(cmd: string, cwd: string): void {
  const proc = Bun.spawnSync(['/bin/sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) throw new Error(`cmd failed: ${cmd}\n${proc.stderr.toString()}`);
}

function makeCtx(dir: string): {
  ctx: CommandContext;
  printed: string[];
  loaded: StructuredDiff[];
  opened: string[];
} {
  const printed: string[] = [];
  const loaded: StructuredDiff[] = [];
  const opened: string[] = [];
  const fakePanel = { id: 'diff', loadStructuredDiff: (d: StructuredDiff) => { loaded.push(d); } };
  const panelManager = {
    getAllOpen: () => [] as { id: string }[],
    open: (id: string) => { opened.push(id); return fakePanel; },
    activateById: () => {},
    isVisible: () => true,
    show: () => {},
  };
  const ctx = {
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    focusPanels: () => {},
    workspace: {
      shellPaths: createShellPathService({ workingDirectory: dir, homeDirectory: dir }),
      panelManager,
    },
    provider: {},
    platform: {},
    ops: {},
    extensions: {},
  } as unknown as CommandContext;
  return { ctx, printed, loaded, opened };
}

describe('/git diff routes to the diff panel via the structural diff (STEP 2c)', () => {
  test('a >4,000-char diff is handed to the panel complete, and no truncation stub is printed', async () => {
    const dir = makeProjectTempDir('gv-git-diff');
    try {
      sh('git init -q && git config user.email t@t && git config user.name t', dir);
      // A committed baseline, then a large modification (well past 4,000 chars).
      const baseline = Array.from({ length: 200 }, (_, i) => `const value_${i} = "before ${i}";`).join('\n');
      writeFileSync(join(dir, 'big.ts'), baseline + '\n');
      sh('git add -A && git commit -q -m base', dir);
      const changed = Array.from({ length: 200 }, (_, i) => `const value_${i} = "after longer replacement content ${i}";`).join('\n');
      writeFileSync(join(dir, 'big.ts'), changed + '\n');

      const registry = new CommandRegistry();
      registerGitRuntimeCommands(registry);
      const { ctx, printed, loaded, opened } = makeCtx(dir);

      await registry.execute('git', ['diff'], ctx);

      // The panel was opened and fed the full structured diff.
      expect(opened).toEqual(['diff']);
      expect(loaded.length).toBe(1);
      const diff = loaded[0]!;
      expect(diff.files.length).toBe(1);
      // Completeness: every changed line survives (200 del + 200 add across the hunks).
      const totalLines = diff.files.flatMap((f) => f.hunks).reduce((n, h) => n + h.lines.length, 0);
      expect(totalLines).toBeGreaterThanOrEqual(400);
      expect(diff.additions).toBeGreaterThanOrEqual(200);
      // Honest completion message, and no "(diff truncated)" monument anywhere.
      expect(printed.some((l) => /complete, uncapped/.test(l))).toBe(true);
      expect(printed.some((l) => /truncat/i.test(l))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the 4,000-char slice and its stub string are gone from the source', () => {
    const src = readFileSync(join(import.meta.dir, '../../input/commands/git-runtime.ts'), 'utf-8');
    expect(src).not.toContain('diff truncated');
    expect(src).not.toContain('slice(0, 4000)');
  });

  test('an empty working tree prints "No unstaged changes." and never opens the panel', async () => {
    const dir = makeProjectTempDir('gv-git-diff-clean');
    try {
      sh('git init -q && git config user.email t@t && git config user.name t', dir);
      writeFileSync(join(dir, 'a.ts'), 'const a = 1;\n');
      sh('git add -A && git commit -q -m base', dir);

      const registry = new CommandRegistry();
      registerGitRuntimeCommands(registry);
      const { ctx, printed, loaded, opened } = makeCtx(dir);

      await registry.execute('git', ['diff'], ctx);

      expect(printed).toContain('No unstaged changes.');
      expect(loaded).toEqual([]);
      expect(opened).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
