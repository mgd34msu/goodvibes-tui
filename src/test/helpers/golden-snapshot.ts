/**
 * golden-snapshot.ts, the golden-frame snapshot format (the one
 * golden-frames.test.ts writes and golden-frames-audit.test.ts reads) for
 * golden tests that live in their own files.
 *
 *   # GV_GOLDEN surface=<name> width=<W> height=<H>
 *   |<chars>|            one row per line
 *   @STYLES
 *   <row> <col> <attr>=<value>   non-default attributes only
 *
 * Update path: GOODVIBES_UPDATE_GOLDENS=1 bun test <file>
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';

export function encodeGolden(surface: string, lines: readonly Line[]): string {
  const text: string[] = [];
  const styles: string[] = [];
  lines.forEach((line, row) => {
    text.push(`|${line.map((c) => (c.char === '' ? ' ' : c.char)).join('')}|`);
    line.forEach((c, col) => {
      if (c.fg) styles.push(`${row} ${col} fg=${c.fg}`);
      if (c.bg) styles.push(`${row} ${col} bg=${c.bg}`);
      if (c.bold) styles.push(`${row} ${col} bold=1`);
      if (c.dim) styles.push(`${row} ${col} dim=1`);
      if (c.underline) styles.push(`${row} ${col} underline=1`);
      if (c.italic) styles.push(`${row} ${col} italic=1`);
      if (c.strikethrough) styles.push(`${row} ${col} strikethrough=1`);
    });
  });
  return [`# GV_GOLDEN surface=${surface} width=${lines[0]?.length ?? 0} height=${lines.length}`, ...text, '@STYLES', ...styles, ''].join('\n');
}

/** Compare `lines` against `<dir>/<surface>.txt` (or write it when updating). Throws with the first difference. */
export function assertGoldenIn(dir: string, surface: string, lines: readonly Line[]): string {
  const actual = encodeGolden(surface, lines);
  const path = join(dir, `${surface}.txt`);
  if (process.env['GOODVIBES_UPDATE_GOLDENS'] === '1') {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, actual, 'utf-8');
    return actual;
  }
  if (!existsSync(path)) throw new Error(`[${surface}] golden file missing. Run with GOODVIBES_UPDATE_GOLDENS=1 to generate.`);
  const expected = readFileSync(path, 'utf-8');
  if (expected !== actual) {
    const a = expected.split('\n');
    const b = actual.split('\n');
    const at = a.findIndex((line, i) => line !== b[i]);
    throw new Error(`[${surface}] differs at snapshot line ${at + 1}:\n  golden: ${a[at]}\n  actual: ${b[at]}\nRun with GOODVIBES_UPDATE_GOLDENS=1 to regenerate.`);
  }
  return actual;
}
