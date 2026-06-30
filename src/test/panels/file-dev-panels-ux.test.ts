// ---------------------------------------------------------------------------
// file-dev-panels-ux.test.ts — UX behavior tests for the development-surface
// panels (git / diff / file-explorer / file-preview / symbol-outline / worktree).
//
// These assert the *user-facing* improvements: at-a-glance counts, status
// glyphs, context-aware footer hints, and tree icons — not just geometry.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import type { Line } from '../../types/grid.ts';
import { DiffPanel } from '../../panels/diff-panel.ts';
import { GitPanel } from '../../panels/git-panel.ts';
import { SymbolOutlinePanel } from '../../panels/symbol-outline-panel.ts';
import { WorktreePanel } from '../../panels/worktree-panel.ts';

function linesText(lines: Line[]): string {
  return lines.map((l) => l.map((c) => c.char ?? ' ').join('')).join('\n');
}

const W = 120;
const H = 24;

// ── DiffPanel ────────────────────────────────────────────────────────────────

describe('DiffPanel — at-a-glance change counts', () => {
  const diff = '@@ -1,3 +1,4 @@\n line one\n-line two\n+line two mod\n+line ins\n line three';

  test('tab bar surfaces +adds/-dels for the file', () => {
    const panel = new DiffPanel('/tmp');
    panel.showDiff('src/foo.ts', diff);
    const text = linesText(panel.render(W, H));
    // 2 additions, 1 deletion in the sample diff.
    expect(text).toContain('+2');
    expect(text).toContain('-1');
  });

  test('status bar surfaces counts and position', () => {
    const panel = new DiffPanel('/tmp');
    panel.showDiff('src/foo.ts', diff);
    const lines = panel.render(W, H);
    const status = (lines[lines.length - 1] ?? []).map((c) => c.char ?? ' ').join('');
    expect(status).toContain('src/foo.ts');
    expect(status).toContain('+2');
    expect(status).toContain('-1');
  });

  test('active file is marked with a leading caret in the tab bar', () => {
    const panel = new DiffPanel('/tmp');
    panel.showDiff('a.ts', '@@ -1,1 +1,1 @@\n-a\n+b');
    panel.showDiff('b.ts', '@@ -1,1 +1,1 @@\n-b\n+c');
    const text = linesText(panel.render(W, H));
    expect(text).toContain('▸ b.ts');
  });
});

// ── GitPanel ─────────────────────────────────────────────────────────────────

describe('GitPanel — loading + geometry', () => {
  test('still renders exactly height lines while loading', () => {
    const panel = new GitPanel('/tmp');
    const lines = panel.render(W, H);
    expect(lines).toHaveLength(H);
    for (const line of lines) expect(line).toHaveLength(W);
  });
});

// ── SymbolOutlinePanel — tree icons ──────────────────────────────────────────

describe('SymbolOutlinePanel — tree icons and footer', () => {
  const src = 'export class Foo {\n  bar() {}\n}\nexport function baz() {}\n';

  test('renders a per-kind type icon for classes and functions', () => {
    const panel = new SymbolOutlinePanel();
    panel.loadFile('a.ts', src);
    const text = linesText(panel.render(80, H));
    expect(text).toContain('Foo');
    expect(text).toContain('baz');
    // Container icon (class) and function icon are present.
    expect(text).toContain('C');
    expect(text).toContain('ƒ');
  });

  test('footer hints reference jump-to-source', () => {
    const panel = new SymbolOutlinePanel();
    panel.loadFile('a.ts', src);
    const text = linesText(panel.render(80, H));
    expect(text).toContain('jump to source');
  });

  test('empty (no file) state offers a concrete next-step command', () => {
    const panel = new SymbolOutlinePanel();
    const text = linesText(panel.render(80, H));
    expect(text).toContain('No file loaded');
    expect(text).toContain('/explorer');
  });
});

// ── WorktreePanel — active glyph + aligned columns ───────────────────────────

describe('WorktreePanel — status glyph and column header', () => {
  function makeRegistry() {
    return {
      list: async () => [
        { path: '/repo/wt-a', kind: 'agent', state: 'active', branch: 'feature/x', head: 'abc123def456', updatedAt: Date.now(), sessionId: 's1', taskId: 't1' },
        { path: '/repo/wt-b', kind: 'orchestrator', state: 'paused', branch: 'main', head: '0000', updatedAt: Date.now() },
      ],
      subscribe: () => () => {},
    } as unknown as ConstructorParameters<typeof WorktreePanel>[0];
  }

  test('renders an active status glyph and a column header', async () => {
    const panel = new WorktreePanel(makeRegistry());
    await new Promise((r) => setTimeout(r, 30));
    const text = linesText(panel.render(100, H));
    expect(text).toContain('KIND');
    expect(text).toContain('feature/x');
    expect(text).toContain('●'); // active state glyph
  });

  test('empty state offers a concrete /worktree command', async () => {
    const empty = { list: async () => [], subscribe: () => () => {} } as unknown as ConstructorParameters<typeof WorktreePanel>[0];
    const panel = new WorktreePanel(empty);
    await new Promise((r) => setTimeout(r, 30)); // let the initial async refresh settle
    const text = linesText(panel.render(100, H));
    expect(text).toContain('/worktree attach');
  });
});
