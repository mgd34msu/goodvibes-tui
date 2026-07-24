// ---------------------------------------------------------------------------
// ensure-goodvibes-gitignore.test.ts — a hygiene fix.
//
// The TUI's own `.goodvibes/` scratch directory (logs, overflow buffers,
// exec output, cache, session state) was never excluded from a *project's*
// .gitignore by anything in this codebase, so any `git add -A` (write-quit's
// auto-commit, a WRFC chain's own commit) could sweep the whole transient
// tree into the commit. ensureGoodvibesGitignore() closes that gap: it is
// idempotent, append-only, and a no-op outside a git repo.
// ---------------------------------------------------------------------------

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureGoodvibesGitignore } from '../../cli/ensure-goodvibes-gitignore.ts';

describe('entrypoint wiring', () => {
  test('the shell entrypoint calls ensureGoodvibesGitignore during bootstrap', () => {
    const src = readFileSync(join(import.meta.dir, '../../cli/entrypoint.ts'), 'utf-8');
    expect(src).toContain("import { ensureGoodvibesGitignore } from './ensure-goodvibes-gitignore.ts';");
    expect(src).toContain('ensureGoodvibesGitignore(bootstrapWorkingDir)');
  });

  test('the entrypoint only prints a notice when the rule was actually just added (gated on the return value)', () => {
    const src = readFileSync(join(import.meta.dir, '../../cli/entrypoint.ts'), 'utf-8');
    expect(src).toContain('if (ensureGoodvibesGitignore(bootstrapWorkingDir)) {');
    expect(src).toContain("added '.goodvibes/' to .gitignore");
  });
});

const dirs: string[] = [];
function makeProjectDir(withGit = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-gitignore-'));
  dirs.push(dir);
  if (withGit) mkdirSync(join(dir, '.git'));
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('ensureGoodvibesGitignore', () => {
  test('creates .gitignore with a .goodvibes/ exclusion when none exists', () => {
    const dir = makeProjectDir();
    ensureGoodvibesGitignore(dir);
    const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(content).toMatch(/\.goodvibes\/?/);
  });

  test('appends to an existing .gitignore without clobbering its content', () => {
    const dir = makeProjectDir();
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n*.log\n');
    ensureGoodvibesGitignore(dir);
    const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('*.log');
    expect(content).toMatch(/\.goodvibes\/?/);
  });

  test('is idempotent: running twice does not duplicate the rule', () => {
    const dir = makeProjectDir();
    ensureGoodvibesGitignore(dir);
    ensureGoodvibesGitignore(dir);
    const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
    const occurrences = content.split('.goodvibes').length - 1;
    expect(occurrences).toBe(1);
  });

  test('does not touch a .gitignore that already excludes .goodvibes in some form', () => {
    const dir = makeProjectDir();
    writeFileSync(join(dir, '.gitignore'), '# my rules\n.goodvibes/*\n');
    ensureGoodvibesGitignore(dir);
    const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(content).toBe('# my rules\n.goodvibes/*\n');
  });

  test('is a no-op outside a git repository (never creates a stray .gitignore)', () => {
    const dir = makeProjectDir(false);
    ensureGoodvibesGitignore(dir);
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
  });

  // ── Return-value contract (item 9): the caller prints a one-time notice
  // gated on this, so it must be true exactly once — the call that actually
  // wrote the rule — and false for every no-op / already-present / non-git case.
  describe('return value — "did this call just write the rule" (item 9)', () => {
    test('returns true when it creates a fresh .gitignore', () => {
      const dir = makeProjectDir();
      expect(ensureGoodvibesGitignore(dir)).toBe(true);
    });

    test('returns true when it appends to an existing .gitignore', () => {
      const dir = makeProjectDir();
      writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
      expect(ensureGoodvibesGitignore(dir)).toBe(true);
    });

    test('returns false on every subsequent call once the rule is present (only the first launch notices)', () => {
      const dir = makeProjectDir();
      expect(ensureGoodvibesGitignore(dir)).toBe(true);
      expect(ensureGoodvibesGitignore(dir)).toBe(false);
      expect(ensureGoodvibesGitignore(dir)).toBe(false);
    });

    test('returns false when the rule already exists in some other form', () => {
      const dir = makeProjectDir();
      writeFileSync(join(dir, '.gitignore'), '# my rules\n.goodvibes/*\n');
      expect(ensureGoodvibesGitignore(dir)).toBe(false);
    });

    test('returns false outside a git repository', () => {
      const dir = makeProjectDir(false);
      expect(ensureGoodvibesGitignore(dir)).toBe(false);
    });
  });
});
