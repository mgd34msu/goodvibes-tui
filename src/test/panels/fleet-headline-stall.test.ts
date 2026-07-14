// ---------------------------------------------------------------------------
// fleet-headline-stall.test.ts — fleet rows render the read-model's headline
// (replaced in place, never a scrolling feed) and the stall marker
// ('quiet Nm'), and the waiting-on-human classification adopts the registry's
// canonical needsAttention projection (approval AND input reasons).
//
// Row assertions are FULL-STRING at 80 and 60 columns — never prefix checks —
// so any layout drift in the row composer is named, not hidden.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type { ProcessNode } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import {
  buildFleetSnapshot,
  fleetAttentionText,
  fleetNodeAttention,
  fleetStallMarker,
  isBlockedOnUserNode,
  type FleetTreeRow,
} from '../../panels/fleet-read-model.ts';
import { renderFleetDetailLines, renderFleetRowLine } from '../../panels/fleet-panel-format.ts';

function makeNode(node: Partial<ProcessNode> & { id: string }): ProcessNode {
  return {
    kind: 'agent',
    label: node.id,
    state: 'executing-tool',
    elapsedMs: 65_000,
    costState: 'unpriced',
    capabilities: { interruptible: true, killable: true, pausable: false, steerable: false },
    ...node,
  };
}

function row(node: Partial<ProcessNode> & { id: string }): FleetTreeRow {
  return { node: makeNode(node), depth: 0, treePrefix: '', isLastChild: true, hasChildren: false };
}

function text(line: { char?: string }[]): string {
  return line.map((c) => c.char ?? ' ').join('');
}

describe('fleet row headline + stall marker (full-string, 80 and 60 cols)', () => {
  const headlineNode = {
    id: 'a1',
    label: 'reviewer',
    headline: { text: 'reviewing auth module', updatedAt: 1_000 },
    currentActivity: { kind: 'tool', text: 'grep src/', at: 2_000 },
  } as const;

  test('80 cols: the headline replaces the activity feed text in the steady slot', () => {
    const line = renderFleetRowLine(row(headlineNode), 80, false, false, null);
    expect(text(line)).toBe('● agent    reviewer                  1m05s     n/a unpriced reviewing auth modu…');
  });

  test('60 cols: the row stays readable and never overflows', () => {
    const line = renderFleetRowLine(row(headlineNode), 60, false, false, null);
    expect(text(line)).toBe('● agent    reviewer     1m05s     n/a unpriced reviewing aut');
    expect(text(line).length).toBeLessThanOrEqual(60);
  });

  test('80 cols: a stalled node appends the quiet marker to the headline', () => {
    const line = renderFleetRowLine(
      row({ ...headlineNode, stall: { since: 0, quietForMs: 5 * 60_000 } }),
      80,
      false,
      false,
      null,
    );
    expect(text(line)).toBe('● agent    reviewer                  1m05s     n/a unpriced reviewin… · quiet 5m');
  });

  test('80 cols: a stalled node with no headline shows the bare quiet marker', () => {
    const line = renderFleetRowLine(
      row({ id: 'a2', label: 'worker', stall: { since: 0, quietForMs: 12 * 60_000 } }),
      80,
      false,
      false,
      null,
    );
    expect(text(line)).toBe('● agent    worker                    1m05s     n/a unpriced quiet 12m           ');
  });

  test('80 cols: a needs-your-input node says so in the badge slot', () => {
    const line = renderFleetRowLine(
      row({ id: 'a3', label: 'asker', needsAttention: { reason: 'input' } }),
      80,
      false,
      true,
      null,
    );
    expect(text(line)).toBe('… agent    asker                     1m05s     n/a unpriced needs your input    ');
  });

  test('80 cols: an awaiting-approval node still reads blocked on you', () => {
    const line = renderFleetRowLine(
      row({ id: 'a4', label: 'approver', state: 'awaiting-approval' }),
      80,
      false,
      true,
      null,
    );
    expect(text(line)).toBe('… agent    approver                  1m05s     n/a unpriced blocked on you      ');
  });
});

// STEP 2: the ready best-of-N pick and the merge-conflict flag are first-class
// members of the ONE waiting-on-human state class — same ⚑ glyph idiom (which
// truncates to '…' in the 1-width glyph cell, exactly like approval/input),
// same jump key, same count — but each names its required act in its own words,
// distinct from the bare 'blocked on you'. Full-string at 80 AND 60 columns.
describe('fleet row waiting-on-human: pick + conflict reasons (full-string, 80 and 60 cols)', () => {
  test('80 cols: a ready best-of-N pick reads "needs your pick"', () => {
    const line = renderFleetRowLine(
      row({ id: 'ws1', label: 'stream', kind: 'workstream', needsAttention: { reason: 'pick' } }),
      80,
      false,
      true,
      null,
    );
    expect(text(line)).toBe('… stream   stream                    1m05s     n/a unpriced needs your pick     ');
  });

  test('60 cols: a ready best-of-N pick stays readable and never overflows', () => {
    const line = renderFleetRowLine(
      row({ id: 'ws1', label: 'stream', kind: 'workstream', needsAttention: { reason: 'pick' } }),
      60,
      false,
      true,
      null,
    );
    expect(text(line)).toBe('… stream   stream       1m05s     n/a unpriced needs your pi');
    expect(text(line).length).toBeLessThanOrEqual(60);
  });

  test('80 cols: a merge conflict reads "merge conflict waiting on you"', () => {
    const line = renderFleetRowLine(
      row({ id: 'wi1', label: 'item', kind: 'work-item', needsAttention: { reason: 'conflict' } }),
      80,
      false,
      true,
      null,
    );
    expect(text(line)).toBe('… item     item                      1m05s     n/a unpriced merge conflict wait…');
  });

  test('60 cols: a merge conflict stays readable and never overflows', () => {
    const line = renderFleetRowLine(
      row({ id: 'wi1', label: 'item', kind: 'work-item', needsAttention: { reason: 'conflict' } }),
      60,
      false,
      true,
      null,
    );
    expect(text(line)).toBe('… item     item         1m05s     n/a unpriced merge conflic');
    expect(text(line).length).toBeLessThanOrEqual(60);
  });

  test('all four reasons flow through fleetAttentionText with distinct wording', () => {
    expect(fleetAttentionText({ reason: 'approval' })).toBe('blocked on you');
    expect(fleetAttentionText({ reason: 'input' })).toBe('needs your input');
    expect(fleetAttentionText({ reason: 'pick' })).toBe('needs your pick');
    expect(fleetAttentionText({ reason: 'conflict' })).toBe('merge conflict waiting on you');
  });

  test('pick + conflict are counted and jumpable exactly like an approval ask', () => {
    const snapshot = buildFleetSnapshot([
      makeNode({ id: 'ws1', kind: 'workstream', needsAttention: { reason: 'pick' } }),
      makeNode({ id: 'wi1', kind: 'work-item', needsAttention: { reason: 'conflict' } }),
      makeNode({ id: 'ap1', state: 'awaiting-approval' }),
      makeNode({ id: 'plain1' }),
    ]);
    // Same count + jump membership: every waiting-on-human node (approval, pick,
    // conflict), never the plain running one.
    expect(snapshot.blockedNodeIds).toContain('ws1');
    expect(snapshot.blockedNodeIds).toContain('wi1');
    expect(snapshot.blockedNodeIds).toContain('ap1');
    expect(snapshot.blockedNodeIds).not.toContain('plain1');
    expect(isBlockedOnUserNode(makeNode({ id: 'ws1', kind: 'workstream', needsAttention: { reason: 'pick' } }))).toBe(true);
    expect(isBlockedOnUserNode(makeNode({ id: 'wi1', kind: 'work-item', needsAttention: { reason: 'conflict' } }))).toBe(true);
  });

  test('the detail block names the reason (pick / conflict) in the state slot', () => {
    const pick = renderFleetDetailLines(
      makeNode({ id: 'ws1', label: 'stream', kind: 'workstream', needsAttention: { reason: 'pick' } }),
      80,
      false,
      true,
    );
    expect(text(pick[0]!)).toContain('state needs your pick');
    const conflict = renderFleetDetailLines(
      makeNode({ id: 'wi1', label: 'item', kind: 'work-item', needsAttention: { reason: 'conflict' } }),
      80,
      false,
      true,
    );
    expect(text(conflict[0]!)).toContain('state merge conflict waiting on you');
  });
});

describe('fleet detail block: headline row', () => {
  test('a node with a headline gets a dedicated headline row mirroring the tree slot', () => {
    const lines = renderFleetDetailLines(
      makeNode({
        id: 'a1',
        label: 'reviewer',
        headline: { text: 'reviewing auth module', updatedAt: 1_000 },
        stall: { since: 0, quietForMs: 3 * 60_000 },
        currentActivity: { kind: 'tool', text: 'grep src/', at: 2_000 },
      }),
      80,
      false,
      false,
    );
    const texts = lines.map(text);
    expect(texts.some((t) => t.includes('headline reviewing auth module · quiet 3m'))).toBe(true);
    expect(texts.some((t) => t.includes('activity tool: grep src/'))).toBe(true);
  });

  test('a node without headline or stall has no headline row', () => {
    const lines = renderFleetDetailLines(makeNode({ id: 'a9', label: 'plain' }), 80, false, false);
    expect(lines.map(text).some((t) => t.includes('headline'))).toBe(false);
  });

  test('a merge-conflict work item lists its structured conflict files, never clipped', () => {
    const node = makeNode({
      id: 'work-item:it1',
      kind: 'work-item',
      label: 'conflicted',
      needsAttention: { reason: 'conflict' },
      raw: { item: { mergeState: 'conflict', conflictFiles: ['src/very/deeply/nested/module/that/is/quite/long/parser.ts', 'README.md'] } },
    });
    const texts = renderFleetDetailLines(node, 60, false, true).map(text);
    expect(texts.some((t) => t.includes('conflicts') && t.includes('2 file(s)') && t.includes('press Enter to resolve'))).toBe(true);
    // The long path is fully present across (hard-)wrapped, padded segments —
    // never truncated with an ellipsis. Stripping whitespace reconstructs it
    // (wrap only inserts line breaks / indent padding, never drops characters).
    const stripped = texts.join('').replace(/\s/g, '');
    expect(stripped).toContain('src/very/deeply/nested/module/that/is/quite/long/parser.ts');
    expect(stripped).toContain('README.md');
    expect(texts.some((t) => t.includes('…'))).toBe(false);
    // Every rendered line stays within the 60-col width (wrapped, never overflowing).
    for (const line of renderFleetDetailLines(node, 60, false, true)) {
      expect(text(line).length).toBeLessThanOrEqual(60);
    }
  });

  test('a non-conflict work item shows no conflict-files block', () => {
    const node = makeNode({ id: 'work-item:it2', kind: 'work-item', label: 'clean' });
    expect(renderFleetDetailLines(node, 80, false, false).map(text).some((t) => t.includes('conflicts'))).toBe(false);
  });
});

describe('waiting-on-human classification (needsAttention projection)', () => {
  test('needsAttention input reason counts as blocked on user even in a running state', () => {
    const node = makeNode({ id: 'n1', state: 'streaming', needsAttention: { reason: 'input' } });
    expect(isBlockedOnUserNode(node)).toBe(true);
    expect(fleetNodeAttention(node)).toEqual({ reason: 'input' });
    expect(fleetAttentionText({ reason: 'input' })).toBe('needs your input');
  });

  test('awaiting-approval without the projection falls back to the approval reason', () => {
    const node = makeNode({ id: 'n2', state: 'awaiting-approval' });
    expect(isBlockedOnUserNode(node)).toBe(true);
    expect(fleetNodeAttention(node)).toEqual({ reason: 'approval' });
    expect(fleetAttentionText({ reason: 'approval' })).toBe('blocked on you');
  });

  test('a plain running node is not blocked', () => {
    expect(isBlockedOnUserNode(makeNode({ id: 'n3', state: 'thinking' }))).toBe(false);
  });

  test('blockedNodeIds includes needsAttention nodes in row order', () => {
    const snapshot = buildFleetSnapshot([
      makeNode({ id: 'r1', state: 'thinking', startedAt: 1 }),
      makeNode({ id: 'r2', state: 'streaming', needsAttention: { reason: 'input' }, startedAt: 2 }),
      makeNode({ id: 'r3', state: 'awaiting-approval', startedAt: 3 }),
    ]);
    // Blocked-first sibling ordering floats both attention nodes to the top.
    expect(snapshot.blockedNodeIds).toEqual(['r2', 'r3']);
  });
});

describe('fleetStallMarker', () => {
  test('minutes render as quiet Nm', () => {
    expect(fleetStallMarker(makeNode({ id: 's1', stall: { since: 0, quietForMs: 5 * 60_000 } }))).toBe('quiet 5m');
  });
  test('sub-minute quiet clamps to quiet 1m (never quiet 0m)', () => {
    expect(fleetStallMarker(makeNode({ id: 's2', stall: { since: 0, quietForMs: 30_000 } }))).toBe('quiet 1m');
  });
  test('past an hour renders hours and minutes', () => {
    expect(fleetStallMarker(makeNode({ id: 's3', stall: { since: 0, quietForMs: 90 * 60_000 } }))).toBe('quiet 1h30m');
  });
  test('exact hours drop the minute part', () => {
    expect(fleetStallMarker(makeNode({ id: 's4', stall: { since: 0, quietForMs: 120 * 60_000 } }))).toBe('quiet 2h');
  });
  test('no stall tell means no marker', () => {
    expect(fleetStallMarker(makeNode({ id: 's5' }))).toBeNull();
  });
});
