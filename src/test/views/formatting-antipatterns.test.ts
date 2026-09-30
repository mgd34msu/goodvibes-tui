// ---------------------------------------------------------------------------
// formatting-antipatterns.test.ts, regression ratchet for view formatting.
//
// Views must format text through the width-aware helpers in polish.ts /
// terminal-width.ts (truncateDisplay / fitDisplay / buildAlignedRow), never by
// hand-rolling string truncation, code-unit slicing breaks on wide characters
// (emoji, CJK) and miscounts the visible width.
//
// Two unambiguous idioms are banned outright (baselines are empty, so any
// reintroduction in any view fails):
//   1. `…`.padEnd(n).slice(0, n)       , pad-then-truncate column formatting
//   2. `…${expr}`.slice(0, n)          , template literal truncated by code unit
// Both are matched narrowly (template literals / padEnd chains) so plain array
// or Line[] slicing is never flagged.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const VIEWS_DIR = join(import.meta.dir, '../../views');

// `.padEnd(...).slice(...)`, pad-then-truncate string formatting (use fitDisplay).
const PADEND_SLICE = /padEnd\([^)]*\)\.slice\(/;
// `.slice(0, N).padEnd(N)`, truncate-then-pad fixed-width column (use fitDisplay).
const SLICE_PADEND = /\.slice\(0, *[0-9]+\)\.padEnd\(/;
// A template literal immediately truncated by `.slice(0, ...)` (use truncateDisplay).
const TEMPLATE_SLICE = /`[^`]*`\.slice\(0,/;

// Files known to still use an idiom. Both empty: the idioms are fully swept,
// so any reintroduction anywhere fails the test. Never add to these.
const PADEND_SLICE_BASELINE = new Set<string>([]);
const TEMPLATE_SLICE_BASELINE = new Set<string>([]);

function viewFilesUsing(pattern: RegExp): Set<string> {
  const hits = new Set<string>();
  for (const file of readdirSync(VIEWS_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const src = readFileSync(join(VIEWS_DIR, file), 'utf-8');
    if (pattern.test(src)) hits.add(file);
  }
  return hits;
}

describe('view formatting anti-pattern ratchet', () => {
  test('no NEW view introduces padEnd().slice() string truncation', () => {
    const offenders = viewFilesUsing(PADEND_SLICE);
    expect([...offenders].filter((f) => !PADEND_SLICE_BASELINE.has(f))).toEqual([]);
  });

  test('no NEW view introduces template-literal .slice(0,…) truncation', () => {
    const offenders = viewFilesUsing(TEMPLATE_SLICE);
    expect([...offenders].filter((f) => !TEMPLATE_SLICE_BASELINE.has(f))).toEqual([]);
  });

  test('no view uses .slice(0,N).padEnd(N) truncate-then-pad columns', () => {
    expect([...viewFilesUsing(SLICE_PADEND)]).toEqual([]);
  });
});
