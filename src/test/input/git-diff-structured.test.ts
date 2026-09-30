// ---------------------------------------------------------------------------
// git-diff-structured.test.ts (STEP 2c), /git diff opens the Changes modal on
// its "not staged" view, and the diff that view loads is the FULL, uncapped
// working-tree diff. The old path sliced the raw text at 4,000 chars and
// printed a "(diff truncated)" stub; that branch is gone.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerGitRuntimeCommands } from '../../input/commands/git-runtime.ts';
import { loadDiff, type ChangesSource } from '../../input/changes-git.ts';
import { parseChanges } from '../../input/changes-model.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function sh(cmd: string, cwd: string): void {
  const proc = Bun.spawnSync(['/bin/sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) throw new Error(`cmd failed: ${cmd}\n${proc.stderr.toString()}`);
}

function makeCtx(dir: string): {
  ctx: CommandContext;
  printed: string[];
  opened: Array<ChangesSource | undefined>;
} {
  const printed: string[] = [];
  const opened: Array<ChangesSource | undefined> = [];
  const ctx = {
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    openChanges: (options?: { readonly source?: ChangesSource }) => { opened.push(options?.source); },
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

describe('/git diff opens the Changes modal on the full, uncapped working-tree diff (STEP 2c)', () => {
  test('a >4,000-char diff opens Changes (not staged) and the view loads it complete, with no truncation stub', async () => {
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
      const { ctx, printed, opened } = makeCtx(dir);

      await registry.execute('git', ['diff'], ctx);

      // Changes opened on the "not staged" view, with an honest count printed.
      expect(opened).toEqual(['working']);
      expect(printed.some((l) => /^Unstaged: 1 file, \+200 -200\.$/.test(l))).toBe(true);
      expect(printed.some((l) => /truncat/i.test(l))).toBe(false);

      // The diff that view loads is complete: every changed line survives.
      const loaded = await loadDiff(dir, 'working', []);
      expect(loaded.error).toBeNull();
      expect(loaded.raw.length).toBeGreaterThan(4000);
      const files = parseChanges(loaded.raw);
      expect(files.length).toBe(1);
      expect(files[0]!.path).toBe('big.ts');
      expect(files[0]!.added).toBe(200);
      expect(files[0]!.removed).toBe(200);
      const totalLines = files[0]!.hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind !== 'ctx').length, 0);
      expect(totalLines).toBe(400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an empty working tree prints "No unstaged changes." and never opens Changes', async () => {
    const dir = makeProjectTempDir('gv-git-diff-clean');
    try {
      sh('git init -q && git config user.email t@t && git config user.name t', dir);
      writeFileSync(join(dir, 'a.ts'), 'const a = 1;\n');
      sh('git add -A && git commit -q -m base', dir);

      const registry = new CommandRegistry();
      registerGitRuntimeCommands(registry);
      const { ctx, printed, opened } = makeCtx(dir);

      await registry.execute('git', ['diff'], ctx);

      expect(printed).toContain('No unstaged changes.');
      expect(opened).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
