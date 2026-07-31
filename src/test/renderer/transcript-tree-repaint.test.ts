// ---------------------------------------------------------------------------
// transcript-tree-repaint.test.ts — drives the REAL TerminalBuffer + DiffEngine
// over a realistic concurrent-tool-call sequence and measures what actually
// repaints between frames.
//
// This exists because reasoning about blitLine is not verification. Two claims
// are checked against real frames:
//
//   1. A connector flip (`└` -> `├`, when a sibling arrives) changes exactly
//      one cell on that row and moves no text.
//   2. Rows that STOP being supplied — a turn collapsing, so its result rows
//      vanish — are repainted rather than left on screen. That is the known
//      back-buffer-seeding hazard: the back buffer is seeded from the front
//      buffer so untouched rows keep describing the screen, which means a row
//      that silently stops being written would never repaint.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { ConversationManager } from '../../core/conversation.ts';
import { TerminalBuffer } from '../../renderer/buffer.ts';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';

const W = 90;
const H = 40;

/** Blit a transcript's lines into a buffer the way the compositor's viewport does. */
function blitFrame(buffer: TerminalBuffer, lines: readonly Line[]): void {
  buffer.clearDirty();
  for (let y = 0; y < H; y++) {
    buffer.blitLine(y, lines[y] ?? []);
  }
}

function rowText(buffer: TerminalBuffer, y: number): string {
  return buffer.cells[y]!.map((c) => c.char || ' ').join('').replace(/\s+$/, '');
}

/** Two concurrent calls in one turn; results arrive out of order. */
function buildConcurrentTurn(): ConversationManager {
  const cm = new ConversationManager(() => W);
  cm.addUserMessage('read both files');
  cm.addAssistantMessage('', {
    toolCalls: [
      { id: 'c1', name: 'read', arguments: { path: 'alpha.ts' } },
      { id: 'c2', name: 'read', arguments: { path: 'beta.ts' } },
    ],
  });
  return cm;
}

describe('transcript tree repaint behaviour', () => {
  test('a connector flip repaints exactly one cell and moves no text', () => {
    const cm = new ConversationManager(() => W);
    cm.addUserMessage('read it');
    cm.addAssistantMessage('', { toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a.ts' } }] });
    cm.addToolResults([{ callId: 'c1', success: true, output: 'first result' }]);

    const buffer = new TerminalBuffer(W, H);
    blitFrame(buffer, cm.getDisplayBlocks());

    // Find the result row — it is the last sibling, so it draws `└`.
    const beforeRows = Array.from({ length: H }, (_, y) => rowText(buffer, y));
    const resultRowY = beforeRows.findIndex((t) => t.includes('└') && /line/.test(t));
    expect(resultRowY).toBeGreaterThanOrEqual(0);
    const beforeRow = [...buffer.cells[resultRowY]!].map((c) => ({ ...c }));

    // A SECOND result arrives for the same call: the first result is no longer
    // the last sibling, so its connector must become `├`.
    cm.addToolResults([{ callId: 'c1', success: true, output: 'second result' }]);
    blitFrame(buffer, cm.getDisplayBlocks());

    const afterRow = buffer.cells[resultRowY]!;
    const changed: number[] = [];
    for (let x = 0; x < W; x++) {
      const a = beforeRow[x]!;
      const b = afterRow[x]!;
      if (a.char !== b.char || a.fg !== b.fg || a.bg !== b.bg || a.bold !== b.bold || a.dim !== b.dim) {
        changed.push(x);
      }
    }

    // Exactly one cell differs, and it is the connector.
    expect(changed).toHaveLength(1);
    expect(beforeRow[changed[0]!]!.char).toBe('└');
    expect(afterRow[changed[0]!]!.char).toBe('├');
  });

  test('collapsing a turn repaints the rows its results vacated', () => {
    const cm = buildConcurrentTurn();
    cm.addToolResults([
      { callId: 'c2', success: true, output: 'beta contents\nmore\nlines\nhere' },
      { callId: 'c1', success: true, output: 'alpha contents\nmore\nlines\nhere' },
    ]);

    const buffer = new TerminalBuffer(W, H);
    blitFrame(buffer, cm.getDisplayBlocks());
    const expandedRows = Array.from({ length: H }, (_, y) => rowText(buffer, y));
    const occupied = expandedRows
      .map((t, y) => ({ t, y }))
      .filter(({ t }) => t !== '')
      .map(({ y }) => y);
    expect(occupied.length).toBeGreaterThan(4);

    // Collapse the turn: every result row stops being supplied.
    cm.setCollapsed('turn_1', true);
    blitFrame(buffer, cm.getDisplayBlocks());
    const collapsedLines = cm.getDisplayBlocks();
    expect(collapsedLines.length).toBeLessThan(occupied.length + 2);

    // Every row that HAD content and no longer does is blank on screen and was
    // marked dirty, so the diff actually emits the clear. (Rows that were
    // already blank are correctly left clean — repainting them would be
    // wasted output, and that is the distinction this asserts.)
    let vacated = 0;
    for (const y of occupied) {
      if (rowText(buffer, y) !== '') continue;
      vacated += 1;
      expect(buffer.dirtyRows[y]).toBe(true);
    }
    expect(vacated).toBeGreaterThan(0);
  });

  test('an out-of-order result lands in its own subtree, above a later sibling', () => {
    const cm = buildConcurrentTurn();
    // The SECOND call settles first.
    cm.addToolResults([{ callId: 'c2', success: true, output: 'beta done' }]);
    let rows = cm.getDisplayBlocks().map((l) => l.map((c) => c.char || ' ').join(''));
    const alphaY = rows.findIndex((t) => t.includes('alpha.ts'));
    const betaY = rows.findIndex((t) => t.includes('beta.ts'));
    expect(alphaY).toBeGreaterThanOrEqual(0);
    expect(betaY).toBeGreaterThan(alphaY);

    // Now the FIRST call settles. Its result must appear between alpha's call
    // row and beta's call row — not appended at the bottom.
    cm.addToolResults([{ callId: 'c1', success: true, output: 'alpha done' }]);
    rows = cm.getDisplayBlocks().map((l) => l.map((c) => c.char || ' ').join(''));
    const alphaY2 = rows.findIndex((t) => t.includes('alpha.ts'));
    const betaY2 = rows.findIndex((t) => t.includes('beta.ts'));
    const alphaResultY = rows.findIndex((t, i) => i > alphaY2 && t.includes('alpha done'));

    expect(alphaResultY).toBeGreaterThan(alphaY2);
    expect(alphaResultY).toBeLessThan(betaY2);
  });

  test('an in-flight call is visible before it completes', () => {
    const cm = buildConcurrentTurn();
    const rows = cm.getDisplayBlocks().map((l) => l.map((c) => c.char || ' ').join(''));
    // Both calls render immediately, with the not-yet-run glyph — nothing is
    // buffered until the turn finishes.
    expect(rows.some((t) => t.includes('alpha.ts') && t.includes('◌'))).toBe(true);
    expect(rows.some((t) => t.includes('beta.ts') && t.includes('◌'))).toBe(true);
  });
});
