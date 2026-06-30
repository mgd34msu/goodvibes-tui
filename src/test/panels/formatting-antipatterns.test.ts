// ---------------------------------------------------------------------------
// formatting-antipatterns.test.ts — regression ratchet for panel formatting.
//
// Panels must format text through the width-aware helpers in polish.ts /
// terminal-width.ts (truncateDisplay / fitDisplay / buildAlignedRow), never by
// hand-rolling `.padEnd(width).slice(0, width)` string truncation — that breaks
// on wide characters (emoji, CJK) and miscounts the visible width.
//
// This is a RATCHET: the set of files still using the idiom is frozen below.
// Introducing it in a new panel fails the test; fixing a listed panel and
// removing it from the baseline moves the floor down. The goal is an empty
// baseline. (We match the unambiguous `padEnd(...).slice(...)` idiom so plain
// array/Line slicing is never flagged.)
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PANELS_DIR = join(import.meta.dir, '../../panels');

// `.padEnd(...).slice(...)` — pad-then-truncate string formatting that should
// go through fitDisplay() instead.
const PADEND_SLICE = /padEnd\([^)]*\)\.slice\(/;

// Files known to still use the idiom. Shrink as panels migrate to the shared
// formatting helpers — never add to it.
const BASELINE_OFFENDERS = new Set<string>([
  'cost-tracker-panel.ts',
  'panel-list-panel.ts',
  'subscription-panel.ts',
  'work-plan-panel.ts',
]);

function panelFilesUsing(pattern: RegExp): Set<string> {
  const hits = new Set<string>();
  for (const file of readdirSync(PANELS_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const src = readFileSync(join(PANELS_DIR, file), 'utf-8');
    if (pattern.test(src)) hits.add(file);
  }
  return hits;
}

describe('panel formatting anti-pattern ratchet', () => {
  test('no NEW panel introduces padEnd().slice() string truncation', () => {
    const offenders = panelFilesUsing(PADEND_SLICE);
    const newOffenders = [...offenders].filter((f) => !BASELINE_OFFENDERS.has(f));
    expect(newOffenders).toEqual([]);
  });

  test('baseline does not list files that are already clean (keep it tight)', () => {
    const offenders = panelFilesUsing(PADEND_SLICE);
    const staleBaseline = [...BASELINE_OFFENDERS].filter((f) => !offenders.has(f));
    expect(staleBaseline).toEqual([]);
  });
});
