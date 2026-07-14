import { describe, expect, test } from 'bun:test';
import type { StructuredDiff, StructuredDiffFile, StructuredDiffHunk, StructuredDiffLine } from '@pellux/goodvibes-sdk/platform/git';
import { DiffPanel } from '../../panels/diff-panel.ts';

// ---------------------------------------------------------------------------
// STEP 2c — /git diff routes to the real diff panel via the structural diff.
// The old path sliced the raw text at 4,000 chars and printed a
// "(diff truncated)" stub. loadStructuredDiff ingests the FULL, uncapped
// StructuredDiff (GitService.diffStructured) so a >4,000-char diff renders
// complete. These are full-string render assertions at 80x24 and 60-col.
// ---------------------------------------------------------------------------

function textOf(lines: import('../../types/grid.ts').Line[]): string {
  return lines.map((l) => l.map((c) => c.char ?? '').join('')).join('\n');
}

/** A single file with `count` changed lines — sized well past 4,000 chars. */
function bigStructuredDiff(count: number): { diff: StructuredDiff; lastText: string } {
  const lines: StructuredDiffLine[] = [];
  for (let i = 0; i < count; i++) {
    lines.push({ kind: 'del', text: `const value_${i} = "before longish content ${i}";` });
    lines.push({ kind: 'add', text: `const value_${i} = "after longish replacement content ${i}";` });
  }
  const lastText = `const value_${count - 1} = "after longish replacement content ${count - 1}";`;
  const hunk: StructuredDiffHunk = {
    header: `@@ -1,${count} +1,${count} @@`,
    oldStart: 1,
    oldLines: count,
    newStart: 1,
    newLines: count,
    lines,
  };
  const file: StructuredDiffFile = {
    oldPath: 'src/big.ts',
    newPath: 'src/big.ts',
    status: 'modified',
    hunks: [hunk],
    headerLines: ['diff --git a/src/big.ts b/src/big.ts', 'index 111..222 100644', '--- a/src/big.ts', '+++ b/src/big.ts'],
    additions: count,
    deletions: count,
  };
  return { diff: { files: [file], additions: count, deletions: count }, lastText };
}

describe('DiffPanel.loadStructuredDiff (STEP 2c)', () => {
  test('a >4,000-char structured diff loads every line with no truncation', () => {
    const { diff } = bigStructuredDiff(120); // ~240 changed lines
    const panel = new DiffPanel('/tmp', () => {});
    panel.loadStructuredDiff(diff);
    // The reconstructed raw for the single file must exceed the old 4,000 cap
    // several times over — proving the slice is gone.
    const rawLen = (panel as unknown as { entries: Array<{ raw: string }> }).entries[0]!.raw.length;
    expect(rawLen).toBeGreaterThan(4000);
    // Every structured line is retained: 240 changed + 1 hunk header.
    const parsedCount = (panel as unknown as { entries: Array<{ lines: unknown[] }> }).entries[0]!.lines.length;
    expect(parsedCount).toBe(245);
  });

  test('renders complete at 80x24 — full line count shown, no truncation stub', () => {
    const { diff } = bigStructuredDiff(120);
    const panel = new DiffPanel('/tmp', () => {});
    panel.loadStructuredDiff(diff);
    const text = textOf(panel.render(80, 24));
    // The status bar shows the FULL retained line count (L1/245), the honest
    // completeness signal — not a capped subset.
    expect(text).toContain('L1/245');
    // First-file content is visible from the top.
    expect(text).toContain('after longish replacement content 0');
    // The monument is gone: no "truncated" stub anywhere on the surface.
    expect(text.toLowerCase()).not.toContain('truncat');
  });

  test('renders complete at 60 columns — same completeness, no truncation stub', () => {
    const { diff } = bigStructuredDiff(120);
    const panel = new DiffPanel('/tmp', () => {});
    panel.loadStructuredDiff(diff);
    const text = textOf(panel.render(60, 24));
    expect(text).toContain('L1/245');
    expect(text.toLowerCase()).not.toContain('truncat');
  });

  test('paging to the end reaches the final line of a large diff', () => {
    const { diff, lastText } = bigStructuredDiff(120);
    const panel = new DiffPanel('/tmp', () => {});
    panel.loadStructuredDiff(diff);
    // Page down far enough to reach the tail; handleKey('pagedown') advances 20
    // rows and clamps at the maximum scroll offset.
    for (let i = 0; i < 40; i++) panel.handleInput('pagedown');
    const text = textOf(panel.render(80, 24));
    expect(text).toContain(lastText.slice(0, 40));
  });

  test('added / deleted / renamed file paths resolve to a real tab label', () => {
    const files: StructuredDiffFile[] = [
      { oldPath: null, newPath: 'src/added.ts', status: 'added', hunks: [], headerLines: ['diff --git a/src/added.ts b/src/added.ts'], additions: 1, deletions: 0 },
      { oldPath: 'src/gone.ts', newPath: null, status: 'deleted', hunks: [], headerLines: ['diff --git a/src/gone.ts b/src/gone.ts'], additions: 0, deletions: 1 },
      { oldPath: 'src/old.ts', newPath: 'src/new.ts', status: 'renamed', hunks: [], headerLines: ['diff --git a/src/old.ts b/src/new.ts'], additions: 0, deletions: 0 },
    ];
    const panel = new DiffPanel('/tmp', () => {});
    panel.loadStructuredDiff({ files, additions: 1, deletions: 1 });
    const paths = (panel as unknown as { entries: Array<{ filePath: string }> }).entries.map((e) => e.filePath);
    expect(paths).toEqual(['src/added.ts', 'src/gone.ts', 'src/new.ts']);
  });
});
