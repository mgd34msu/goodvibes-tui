// ---------------------------------------------------------------------------
// conversation-tree-layout.test.ts
//
// Golden-row tests for the transcript tree's column grid. These pin the three
// things the owner rejected the previous layout for:
//
//   1. the status column IS the `●` bullet column (it used to be a separate
//      gutter at column 0, left of the whole transcript);
//   2. the vertical `│` runs unbroken from a row down to its next sibling —
//      the connector used to be drawn only on a row's FIRST line, so every
//      multi-line row (collapsed fragment box, expanded body) punched a hole
//      in the rail;
//   3. every level steps by exactly TREE_STEP_COLS and a result row lines up
//      predictably under the tool row it belongs to — the tool row, its result
//      row and that result's fragment each used to compute their own margin.
//
// The assertions are on EXACT emitted rows and exact column indices, because
// "looks aligned" is the property under test and nothing weaker detects a
// one-column drift.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { appendConversationMessages, type ConversationRenderContext } from '../../core/conversation-rendering.ts';
import {
  treeBranchCol,
  treeContentCol,
  treeIndentCols,
  treeTextCol,
} from '../../renderer/conversation-tree.ts';

/**
 * The column a branch row's status glyph must occupy: the same one a depth-0
 * row draws its `●` in. conversation-tree.ts derives it the same way
 * (treeBranchCol(0)) rather than storing a second number, and the rendered-row
 * tests below re-prove it against real output.
 */
const STATUS_COL = treeBranchCol(0);

/** The grid's step between levels, read off the grid rather than asserted at it. */
const STEP_COLS = treeBranchCol(treeIndentCols(2, 96)) - treeBranchCol(treeIndentCols(1, 96));
import type { Line } from '../../types/grid.ts';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';

type Message = ConversationMessageSnapshot;

const WIDTH = 96;

function renderRows(
  messages: Message[],
  options: {
    readonly resolveAgentSnapshot?: (agentId: string) => readonly Message[] | null;
    readonly collapseState?: Map<string, boolean>;
  } = {},
): string[] {
  const lines: Line[] = [];
  const context: ConversationRenderContext = {
    history: {
      addLine: (line) => { lines.push(line); },
      addLines: (added) => { for (const line of added) lines.push(line); },
      getLineCount: () => lines.length,
    },
    blockRegistry: [],
    collapseState: options.collapseState ?? new Map<string, boolean>(),
    errorLineRegistry: [],
    messageKindRegistry: new Map(),
    configManager: null,
    splashOptions: {},
    ...(options.resolveAgentSnapshot ? { resolveAgentSnapshot: options.resolveAgentSnapshot } : {}),
  };
  appendConversationMessages(context, messages, WIDTH, [], 0);
  return lines.map((line) => line.map((cell) => cell.char).join('').replace(/\s+$/, ''));
}

/** Column index of the first non-blank character, or -1 for a blank row. */
function firstGlyphCol(row: string): number {
  const index = row.search(/\S/);
  return index;
}

function colOf(row: string, glyph: string): number {
  return row.indexOf(glyph);
}

/** A three-call turn: one success, one failure, one still in flight. */
function mixedStatusTurn(): Message[] {
  return [
    {
      role: 'assistant',
      content: '',
      model: 'gpt-5.6-sol',
      provider: 'openai',
      toolCalls: [
        { id: 'c1', name: 'process', arguments: { mode: 'poll' } },
        { id: 'c2', name: 'find', arguments: { pattern: 'needle' } },
        { id: 'c3', name: 'exec', arguments: { command: 'bun test' } },
      ],
    } as Message,
    { role: 'tool', callId: 'c1', toolName: 'process', content: 'polled 3 jobs' },
    { role: 'tool', callId: 'c2', toolName: 'find', content: 'Error: no match for needle' },
  ];
}

describe('tree column grid', () => {
  test('the status column IS the bullet column — one definition, not two numbers', () => {
    // Not a tautology in the direction that matters: the RENDERED tests below
    // prove writeTreeStatusMarker actually lands here, and this pins the column
    // itself to the depth-0 marker column rather than to a literal.
    expect(STATUS_COL).toBe(treeBranchCol(treeIndentCols(0, WIDTH)));
    expect(STEP_COLS).toBeGreaterThan(0);
  });

  test('every level steps by exactly the same width, for connector, content and text alike', () => {
    for (let depth = 0; depth < 5; depth++) {
      const here = treeIndentCols(depth, WIDTH);
      const next = treeIndentCols(depth + 1, WIDTH);
      expect(treeBranchCol(next) - treeBranchCol(here)).toBe(STEP_COLS);
      expect(treeContentCol(next) - treeContentCol(here)).toBe(STEP_COLS);
      expect(treeTextCol(next) - treeTextCol(here)).toBe(STEP_COLS);
    }
  });

  test('a level\'s connector sits where its parent\'s content began', () => {
    for (let depth = 0; depth < 5; depth++) {
      const parent = treeIndentCols(depth, WIDTH);
      const child = treeIndentCols(depth + 1, WIDTH);
      expect(treeBranchCol(child)).toBe(treeContentCol(parent));
    }
  });
});

describe('rendered turn: status markers align with the assistant bullet', () => {
  test('every tool row puts its glyph in the same column as the header\'s ●', () => {
    const rows = renderRows(mixedStatusTurn());
    const header = rows.find((row) => row.includes('assistant'));
    expect(header).toBeDefined();
    const bulletCol = colOf(header!, '●');
    expect(bulletCol).toBe(STATUS_COL);

    for (const glyph of ['✓', '✕', '◌']) {
      const row = rows.find((r) => r.includes(glyph));
      expect(row, `no row carrying ${glyph}`).toBeDefined();
      expect(colOf(row!, glyph)).toBe(bulletCol);
    }
  });

  test('the call row states the OUTCOME, not merely that a result arrived', () => {
    const callRailCol = treeBranchCol(treeIndentCols(1, WIDTH));
    const rows = renderRows(mixedStatusTurn())
      .filter((row) => row[callRailCol] === '├' || row[callRailCol] === '└');
    // process succeeded, find failed, exec has not run.
    expect(rows[0]).toContain('✓');
    expect(rows[0]).toContain('poll');
    expect(rows[1]).toContain('✕');
    expect(rows[1]).toContain('needle');
    expect(rows[2]).toContain('◌');
    expect(rows[2]).toContain('bun test');
  });

  test('a per-call cancellation reads ⊘ in the bullet column, not ✓', () => {
    const rows = renderRows([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: { path: '/tmp/a' } }],
      } as Message,
      { role: 'tool', callId: 'c1', toolName: 'read', content: 'Error: cancelled by user' },
    ]);
    const callRow = rows.find((row) => row.includes('/tmp/a'))!;
    expect(colOf(callRow, '⊘')).toBe(STATUS_COL);
    expect(callRow).not.toContain('✓');
  });

  test('a result row carries no marker of its own — the call row above already said it', () => {
    const rows = renderRows(mixedStatusTurn());
    const resultRow = rows.find((row) => row.includes('lines') || row.includes('line'))!;
    expect(resultRow.slice(0, STATUS_COL + 1).trim()).toBe('');
  });
});

describe('rendered turn: the exact rows', () => {
  test('golden layout of a three-call turn', () => {
    const rows = renderRows(mixedStatusTurn()).filter((row) => row.length > 0);
    expect(rows).toEqual([
      '   ●  assistant  gpt-5.6-sol (openai)  • 3 tools',
      '   ✓ ├  process  poll',
      '     │ └  ▾ 1 line',
      '     │    polled 3 jobs',
      '   ✕ ├  find  needle',
      '     │ └  ▾ 1 line',
      '     │    Error: no match for needle',
      '   ◌ └  exec  bun test',
    ]);
  });
});

describe('rails are continuous through a subtree', () => {
  test('no gap in the depth-1 rail between the first branch and the last sibling', () => {
    const rows = renderRows(mixedStatusTurn()).filter((row) => row.length > 0);
    const railCol = treeBranchCol(treeIndentCols(1, WIDTH));
    const first = rows.findIndex((row) => row[railCol] === '├');
    const last = rows.findIndex((row) => row[railCol] === '└');
    expect(first).toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(first);
    for (let i = first; i <= last; i++) {
      const glyph = rows[i]![railCol];
      expect(
        glyph === '├' || glyph === '│' || glyph === '└',
        `row ${i} (${JSON.stringify(rows[i])}) breaks the rail at column ${railCol}`,
      ).toBe(true);
    }
  });

  test('a collapsed result\'s fragment box carries the rail on every one of its lines', () => {
    const padded: Record<string, string> = {};
    for (let i = 0; i < 30; i++) padded[`k${i}`] = `value-${i}`;
    const rows = renderRows([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'find', arguments: { pattern: 'needle' } },
          { id: 'c2', name: 'exec', arguments: { command: 'second-command' } },
        ],
      } as Message,
      { role: 'tool', callId: 'c1', toolName: 'find', content: JSON.stringify(padded) },
      { role: 'tool', callId: 'c2', toolName: 'exec', content: 'ok' },
    ]).filter((row) => row.length > 0);

    const railCol = treeBranchCol(treeIndentCols(1, WIDTH));
    // The fragment box is the run of rows between the two call rows; every one
    // of them (top border, preview, bottom border) must carry the rail.
    const firstCall = rows.findIndex((row) => row.includes('needle'));
    const secondCall = rows.findIndex((row) => row.includes('second-command'));
    expect(secondCall - firstCall).toBeGreaterThan(3);
    for (let i = firstCall + 1; i < secondCall; i++) {
      expect(rows[i]![railCol], `row ${i}: ${JSON.stringify(rows[i])}`).toBe('│');
    }
  });

  test('the last sibling ends the rail — nothing is drawn below its └', () => {
    const rows = renderRows(mixedStatusTurn()).filter((row) => row.length > 0);
    const railCol = treeBranchCol(treeIndentCols(1, WIDTH));
    const last = rows.findIndex((row) => row[railCol] === '└');
    for (let i = last + 1; i < rows.length; i++) {
      expect(rows[i]![railCol] ?? ' ').not.toBe('│');
    }
  });
});

describe('result rows line up under the call they belong to', () => {
  test('the result row, its badge and its body all sit on the depth-2 grid', () => {
    const rows = renderRows(mixedStatusTurn()).filter((row) => row.length > 0);
    const depth2Connector = treeBranchCol(treeIndentCols(2, WIDTH));
    const depth2Text = treeTextCol(treeIndentCols(2, WIDTH));

    const badgeRow = rows.find((row) => row.includes('1 line'))!;
    expect(badgeRow[depth2Connector]).toBe('└');
    expect(firstGlyphCol(badgeRow.slice(depth2Connector + 1)) + depth2Connector + 1).toBe(depth2Text);

    const bodyRow = rows.find((row) => row.includes('polled 3 jobs'))!;
    expect(colOf(bodyRow, 'polled')).toBe(depth2Text);
  });

  test('a collapsed preview\'s ▸ sits in the same column as its header\'s ▸', () => {
    const padded: Record<string, string> = {};
    for (let i = 0; i < 30; i++) padded[`k${i}`] = `value-${i}`;
    const rows = renderRows([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'find', arguments: { pattern: 'needle' } }],
      } as Message,
      { role: 'tool', callId: 'c1', toolName: 'find', content: JSON.stringify(padded) },
    ]).filter((row) => row.length > 0);

    const headerRow = rows.find((row) => /▸ \d+ lines/.test(row))!;
    const previewRow = rows.find((row) => row.includes('hidden]'))!;
    expect(colOf(previewRow, '▸')).toBe(colOf(headerRow, '▸'));
    expect(colOf(headerRow, '▸')).toBe(treeTextCol(treeIndentCols(2, WIDTH)));
  });
});

describe('the tree still builds live', () => {
  test('a late sibling flips the previous last row from └ to ├ and the rail closes behind it', () => {
    const messages = mixedStatusTurn();
    const before = renderRows(messages).filter((row) => row.length > 0);
    const railCol = treeBranchCol(treeIndentCols(1, WIDTH));
    expect(before.at(-1)![railCol]).toBe('└');

    // A fourth call arrives on a follow-up assistant message of the same run.
    const grown: Message[] = [
      ...messages,
      { role: 'assistant', content: '', toolCalls: [{ id: 'c4', name: 'write', arguments: { path: '/tmp/b' } }] } as Message,
    ];
    const after = renderRows(grown).filter((row) => row.length > 0);
    const execRow = after.findIndex((row) => row.includes('bun test'));
    expect(after[execRow]![railCol]).toBe('├');
    expect(after.at(-1)!).toContain('/tmp/b');
    expect(after.at(-1)![railCol]).toBe('└');
  });

  test('a result that settles out of order still renders inside its own call\'s subtree', () => {
    const rows = renderRows([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'slow', arguments: { path: '/tmp/slow' } },
          { id: 'c2', name: 'fast', arguments: { path: '/tmp/fast' } },
        ],
      } as Message,
      // fast settles first in the message array; slow's result arrives after.
      { role: 'tool', callId: 'c2', toolName: 'fast', content: 'fast done' },
      { role: 'tool', callId: 'c1', toolName: 'slow', content: 'slow done' },
    ]).filter((row) => row.length > 0);

    const slowCall = rows.findIndex((row) => row.includes('/tmp/slow'));
    const slowResult = rows.findIndex((row) => row.includes('slow done'));
    const fastCall = rows.findIndex((row) => row.includes('/tmp/fast'));
    expect(slowCall).toBeLessThan(slowResult);
    expect(slowResult).toBeLessThan(fastCall);
  });

  test('a spawned agent\'s rows nest on the same grid, one step per level', () => {
    const child: Message[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'k1', name: 'read', arguments: { path: '/tmp/child' } }] } as Message,
      { role: 'tool', callId: 'k1', toolName: 'read', content: 'child read done' },
    ];
    const rows = renderRows([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'agent', arguments: { agentId: 'agent-1', task: 'go' } },
          { id: 'c2', name: 'exec', arguments: { command: 'true' } },
        ],
      } as Message,
      { role: 'tool', callId: 'c1', toolName: 'agent', content: JSON.stringify({ agentId: 'agent-1' }) },
      { role: 'tool', callId: 'c2', toolName: 'exec', content: 'ok' },
    ], { resolveAgentSnapshot: (id) => (id === 'agent-1' ? child : null) }).filter((row) => row.length > 0);

    const childCallRow = rows.find((row) => row.includes('/tmp/child'))!;
    // The spawned agent's own call row sits two levels below the call that
    // spawned it (its header, then its calls), i.e. on the depth-3 grid.
    expect(childCallRow[treeBranchCol(treeIndentCols(3, WIDTH))]).toBe('└');
    // ...and the rails of both open ancestors pass through it.
    expect(childCallRow[treeBranchCol(treeIndentCols(1, WIDTH))]).toBe('│');
  });

  test('expanding a result keeps its body on the grid and the rail intact', () => {
    const padded: Record<string, string> = {};
    for (let i = 0; i < 30; i++) padded[`k${i}`] = `value-${i}`;
    const collapseState = new Map<string, boolean>();
    const messages: Message[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'find', arguments: { pattern: 'needle' } },
          { id: 'c2', name: 'exec', arguments: { command: 'second-command' } },
        ],
      } as Message,
      { role: 'tool', callId: 'c1', toolName: 'find', content: JSON.stringify(padded) },
      { role: 'tool', callId: 'c2', toolName: 'exec', content: 'ok' },
    ];
    renderRows(messages, { collapseState });
    // Expand every collapsed key this turn registered.
    for (const key of [...collapseState.keys()]) collapseState.set(key, false);
    const rows = renderRows(messages, { collapseState }).filter((row) => row.length > 0);

    const railCol = treeBranchCol(treeIndentCols(1, WIDTH));
    const firstCall = rows.findIndex((row) => row.includes('needle'));
    const secondCall = rows.findIndex((row) => row.includes('second-command'));
    expect(secondCall - firstCall).toBeGreaterThan(5);
    for (let i = firstCall + 1; i < secondCall; i++) {
      expect(rows[i]![railCol], `row ${i}: ${JSON.stringify(rows[i])}`).toBe('│');
    }
  });
});
