// ---------------------------------------------------------------------------
// recovery-modals-golden.test.ts — golden frames for the two startup recovery
// questions, rendered through the real SelectionModal +
// renderSelectionModalOverlay path at three terminal sizes.
//
// These exist because of a shipped defect: at 60x24 the "Remove recovery
// point?" question rendered ONLY its destructive row, preselected, with the
// other answer pushed off the box behind a "(1 below)" hint while ten
// terminal rows sat empty — a blind Enter deleted a conversation. The facts
// string below is the worst case that produced it (long title, 8-hex session
// id, 1.2 MB), built from a FIXED timestamp so the frames never drift with
// the clock.
//
// The byte-exact goldens are paired with behavioral assertions that read the
// rendered text back: a golden alone can bless a regression the next time
// someone regenerates it, so "every answer is on screen" and "the cursor sits
// on the harmless row" are also asserted directly.
//
// Update path: GOODVIBES_UPDATE_GOLDENS=1 bun test <this file>.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SelectionModal } from '../../input/selection-modal.ts';
import { renderSelectionModalOverlay } from '../../renderer/selection-modal-overlay.ts';
import {
  RECOVERY_OFFER_TITLE,
  RECOVERY_RETIRE_TITLE,
  buildRecoveryOfferItems,
  buildRecoveryRetireItems,
  describeRecoverySnapshot,
} from '../../runtime/recovery-prompt.ts';
import type { SelectionItem } from '../../input/selection-modal.ts';
import type { RecoveryFileInfo } from '@/runtime/index.ts';
import type { Cell, Line } from '../../types/grid.ts';

const GOLDENS_DIR = new URL('./golden-frames/', import.meta.url).pathname;
const UPDATE = process.env['GOODVIBES_UPDATE_GOLDENS'] === '1';

function snapshotEncode(surface: string, lines: Line[]): string {
  const height = lines.length;
  const width = lines[0]?.length ?? 0;
  const textBlock: string[] = [];
  const styleBlock: string[] = [];
  for (let row = 0; row < height; row++) {
    const line = lines[row]!;
    textBlock.push(`|${line.map((c) => (c.char === '' ? ' ' : c.char)).join('')}|`);
    for (let col = 0; col < line.length; col++) {
      const c = line[col] as Cell;
      if (c.fg) styleBlock.push(`${row} ${col} fg=${c.fg}`);
      if (c.bg) styleBlock.push(`${row} ${col} bg=${c.bg}`);
      if (c.bold) styleBlock.push(`${row} ${col} bold=1`);
      if (c.dim) styleBlock.push(`${row} ${col} dim=1`);
      if (c.underline) styleBlock.push(`${row} ${col} underline=1`);
      if (c.italic) styleBlock.push(`${row} ${col} italic=1`);
      if (c.strikethrough) styleBlock.push(`${row} ${col} strikethrough=1`);
    }
  }
  return [`# GV_GOLDEN surface=${surface} width=${width} height=${height}`, ...textBlock, '@STYLES', ...styleBlock, ''].join('\n');
}

function assertGolden(surface: string, lines: Line[]): void {
  const actual = snapshotEncode(surface, lines);
  const path = join(GOLDENS_DIR, `${surface}.txt`);
  if (UPDATE) {
    mkdirSync(GOLDENS_DIR, { recursive: true });
    writeFileSync(path, actual, 'utf-8');
    return;
  }
  if (!existsSync(path)) throw new Error(`[${surface}] golden file missing. Run with GOODVIBES_UPDATE_GOLDENS=1 to generate.`);
  const expected = readFileSync(path, 'utf-8');
  if (expected !== actual) throw new Error(`[${surface}] golden-frame mismatch. Run with GOODVIBES_UPDATE_GOLDENS=1 to regenerate.`);
}

// A fixed instant, not Date.now(): the rendered age ("3h ago") is a delta
// against this, so the frames are the same bytes on every run forever.
const FIXED_NOW = Date.UTC(2026, 6, 24, 12, 0, 0);
const SNAPSHOT: RecoveryFileInfo = {
  sessionId: 'a1b2c3d4',
  timestamp: FIXED_NOW - 3 * 3_600_000,
  title: 'Refactoring the transcript journal rebind path across sessions',
};
const FACTS = describeRecoverySnapshot(SNAPSHOT, { nowMs: FIXED_NOW, bytes: 1_234_567 });

interface RecoveryModalEntry {
  readonly name: string;
  readonly title: string;
  readonly items: () => SelectionItem[];
  /** Every answer the question offers. All of them must be on screen at once. */
  readonly choices: readonly string[];
  /** The row Enter lands on when the question opens. */
  readonly defaultChoice: string;
}

const RECOVERY_MODALS: readonly RecoveryModalEntry[] = [
  {
    name: 'recovery-offer-modal',
    title: RECOVERY_OFFER_TITLE,
    items: () => buildRecoveryOfferItems(FACTS),
    choices: ['Resume it', 'Not now'],
    defaultChoice: 'Resume it',
  },
  {
    name: 'recovery-retire-modal',
    title: RECOVERY_RETIRE_TITLE,
    items: () => buildRecoveryRetireItems(FACTS),
    choices: ['Keep it', 'Remove it'],
    defaultChoice: 'Keep it',
  },
];

const SIZES = [
  // 60x24 is the size the defect was reproduced at.
  { label: '60x24', width: 60, height: 24 },
  { label: '80x24', width: 80, height: 24 },
  { label: '140x38', width: 140, height: 38 },
] as const;

/** Render a question exactly as the recovery flow opens it. */
function renderRecoveryModal(entry: RecoveryModalEntry, width: number, height: number): Line[] {
  const modal = new SelectionModal();
  modal.open(entry.title, entry.items(), { allowSearch: false, primaryVerbLabel: 'Choose' });
  return renderSelectionModalOverlay(modal, width, height);
}

function rowsOf(lines: Line[]): string[] {
  return lines.map((line) => line.map((c) => (c.char === '' ? ' ' : c.char)).join(''));
}

/**
 * The row a choice's label sits on, or -1. Wrapped detail lines carry
 * sentences, never a bare label, so a row whose whole content is the label
 * (with the borders and the selection indicator taken out) is that choice's
 * own row.
 */
function findChoiceRow(rows: readonly string[], label: string): number {
  return rows.findIndex((row) => row.replace(/[│┌┐└┘├┤─▸]/g, ' ').trim() === label);
}

for (const entry of RECOVERY_MODALS) {
  describe(`recovery modal golden — ${entry.name}`, () => {
    for (const size of SIZES) {
      const surfaceName = `${entry.name}-${size.label}`;

      test(`${size.label} matches committed golden`, () => {
        const lines = renderRecoveryModal(entry, size.width, size.height);
        expect(lines.length).toBeGreaterThan(0);
        assertGolden(surfaceName, lines);
      });

      test(`${size.label} render is deterministic`, () => {
        const a = snapshotEncode(surfaceName, renderRecoveryModal(entry, size.width, size.height));
        const b = snapshotEncode(surfaceName, renderRecoveryModal(entry, size.width, size.height));
        expect(a).toBe(b);
      });

      test(`${size.label} shows every answer at once, with nothing scrolled away`, () => {
        const rows = rowsOf(renderRecoveryModal(entry, size.width, size.height));
        for (const choice of entry.choices) {
          // Thrown rather than expect()ed so the failure carries the frame
          // that lost the answer, which is the whole diagnosis.
          if (findChoiceRow(rows, choice) < 0) {
            throw new Error(`"${choice}" is not on screen at ${size.label}:\n${rows.join('\n')}`);
          }
        }
        // No answer may be hidden behind a scroll hint: these questions are
        // short enough to fit whole at every size a terminal realistically is.
        expect(rows.join('\n')).not.toMatch(/\(\d+ (above|below)/);
        // And the box must stay inside the terminal it is drawn over.
        expect(rows.length).toBeLessThanOrEqual(size.height);
      });

      test(`${size.label} opens with the cursor on "${entry.defaultChoice}"`, () => {
        const rows = rowsOf(renderRecoveryModal(entry, size.width, size.height));
        const defaultRow = findChoiceRow(rows, entry.defaultChoice);
        expect(defaultRow).toBeGreaterThanOrEqual(0);
        expect(rows[defaultRow]).toContain('▸');
        for (const other of entry.choices.filter((c) => c !== entry.defaultChoice)) {
          expect(rows[findChoiceRow(rows, other)]).not.toContain('▸');
        }
      });
    }
  });
}
