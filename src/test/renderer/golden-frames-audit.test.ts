// ---------------------------------------------------------------------------
// golden-frames-audit.test.ts, the design's layout audit over every golden
// frame.
//
// The concept page's measurements are verified by an audit script with five
// checks (overflow, overlap, side padding inside fills, empty first/last row
// in blocks, bars spanning their block). This test applies the four that make
// sense for a finished frame (see helpers/frame-audit.ts) to every committed
// golden snapshot, in both theme sets, with the theme the frame was drawn in.
// A new or regenerated golden that breaks a measurement fails here.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEmptyCell, type Line } from '@pellux/goodvibes-sdk/platform/types';
import { activeTokens, setActiveThemeMode, setActiveThemeName } from '../../renderer/theme.ts';
import { auditFrame } from '../helpers/frame-audit.ts';

const SETS: ReadonlyArray<{ readonly dir: string; readonly theme: string }> = [
  { dir: new URL('./golden-frames/', import.meta.url).pathname, theme: 'goodvibes' },
  { dir: new URL('./golden-frames-goodvibes-neon/', import.meta.url).pathname, theme: 'goodvibes-neon' },
];

/** Rebuild a frame (chars and backgrounds) from the golden snapshot format. */
function parseGolden(raw: string): { width: number; lines: Line[] } | null {
  const rows = raw.split('\n');
  const header = rows[0]?.match(/^# GV_GOLDEN surface=\S+ width=(\d+) height=(\d+)/);
  if (!header) return null;
  const width = Number(header[1]);
  const height = Number(header[2]);
  const lines: Line[] = [];
  for (let r = 1; r <= height; r++) {
    const text = rows[r] ?? '';
    const chars = [...text.slice(1, -1)];
    lines.push(Array.from({ length: Math.max(width, chars.length) }, (_, x) => ({ ...createEmptyCell(), char: chars[x] ?? ' ' })));
  }
  const stylesAt = rows.indexOf('@STYLES');
  for (const record of rows.slice(stylesAt + 1)) {
    const m = record.match(/^(\d+) (\d+) (fg|bg)=(.*)$/);
    if (!m) continue;
    const cell = lines[Number(m[1])]?.[Number(m[2])];
    if (cell) cell[m[3] as 'fg' | 'bg'] = m[4]!;
  }
  return { width, lines };
}

for (const set of SETS) {
  const files = readdirSync(set.dir).filter((f) => f.endsWith('.txt')).sort();
  describe(`golden frame layout audit : ${set.theme}`, () => {
    test('there are frames to audit', () => {
      expect(files.length).toBeGreaterThan(0);
    });
    for (const file of files) {
      test(file, () => {
        setActiveThemeName(set.theme);
        setActiveThemeMode(/light/.test(file) ? 'light' : 'dark');
        try {
          const frame = parseGolden(readFileSync(join(set.dir, file), 'utf8'));
          expect(frame).not.toBeNull();
          const issues = auditFrame(frame!.lines, frame!.width, activeTokens());
          expect(issues.map((i) => `${i.kind} row ${i.row}: ${i.detail}`)).toEqual([]);
        } finally {
          setActiveThemeName('goodvibes');
          setActiveThemeMode('dark');
        }
      });
    }
  });
}
