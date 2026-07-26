// ---------------------------------------------------------------------------
// fleet-attempt-badge.test.ts — a best-of-N sibling node renders its group
// badge on the fleet row (attempt index/total + held state).
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type { ProcessNode } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import type { FleetTreeRow } from '../../panels/fleet-read-model.ts';
import { renderFleetRowLine } from '../../panels/fleet-panel-format.ts';

function row(node: Partial<ProcessNode> & { id: string }): FleetTreeRow {
  const full: ProcessNode = {
    kind: 'work-item',
    label: node.id,
    state: 'executing-tool',
    elapsedMs: 1_000,
    costState: 'unpriced',
    capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: false },
    ...node,
  };
  return { node: full, depth: 0, treePrefix: '', isLastChild: true, hasChildren: false };
}

function text(line: { char?: string }[]): string {
  return line.map((c) => c.char ?? ' ').join('');
}

describe('fleet row best-of-N badge', () => {
  test('a held candidate shows [attempt N/M, held]', () => {
    const line = renderFleetRowLine(row({ id: 'cand', label: 'implement parser', attemptGroup: { groupId: 'g1', index: 1, total: 3, held: true, ready: false } }), 200, false, false, null);
    expect(text(line)).toContain('[attempt 2/3, held]');
  });

  test('a running (not-held) candidate shows [attempt N/M] without held', () => {
    const line = renderFleetRowLine(row({ id: 'cand', label: 'implement parser', attemptGroup: { groupId: 'g1', index: 0, total: 2, held: false, ready: false } }), 200, false, false, null);
    expect(text(line)).toContain('[attempt 1/2]');
    expect(text(line)).not.toContain('held');
  });

  test('an ordinary node has no attempt badge', () => {
    const line = renderFleetRowLine(row({ id: 'plain', label: 'plain node' }), 200, false, false, null);
    expect(text(line)).not.toContain('[attempt');
  });
});
