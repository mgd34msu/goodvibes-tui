// ---------------------------------------------------------------------------
// fleet-detail-surfaces.test.ts, the in-panel review checklist (7b) and the
// task-graph edges/pool posture (7c) rendered under a chain/workstream row.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type { ProcessNode, ProcessReviewSummary } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import { renderFleetDetailLines, renderGraphPostureLines, renderReviewLines } from '../../panels/fleet-panel-format.ts';
import type { WorkstreamGraphSnapshot } from '../../panels/workstream-graph-render.ts';
import { FleetActs, type FleetDiffSurface } from '../../panels/fleet-acts.ts';
import type { FleetGateway, FleetGraphSnapshot } from '../../panels/fleet-gateway.ts';
import { lineToString } from '../setup.ts';

const text = (lines: ReturnType<typeof renderReviewLines>): string => lines.map(lineToString).join('\n');

const review: ProcessReviewSummary = {
  score: 82,
  passed: false,
  cycles: 2,
  checklist: [
    { item: 'the parser handles empty input', verified: true, evidence: 'added a test for the empty case', howExercised: 'bun test parser' },
    { item: 'errors surface a line number', verified: false, evidence: 'no line number in the thrown error' },
  ],
};

function chainNode(withReview: boolean): ProcessNode {
  return {
    id: 'wrfc-chain:abc', kind: 'wrfc-chain', label: 'implement the parser', state: 'executing-tool',
    elapsedMs: 1000, costState: 'unpriced',
    capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: false },
    ...(withReview ? { review } : {}),
  } as ProcessNode;
}

const graph: WorkstreamGraphSnapshot = {
  workstreamId: 'ws-1',
  title: 'ship the feature',
  nodes: [
    { id: 'a', title: 'schema', state: 'done', files: [], orphaned: false, remainingDepth: 0, stalled: false } as WorkstreamGraphSnapshot['nodes'][number],
    { id: 'b', title: 'API', state: 'running', files: [], orphaned: false, remainingDepth: 1, stalled: false } as WorkstreamGraphSnapshot['nodes'][number],
  ],
  edges: [{ from: 'a', to: 'b' }],
  pool: { ready: 1, running: 1, atCap: true, capKey: 'fleet.maxSize', maxSize: 2 } as WorkstreamGraphSnapshot['pool'],
};

describe('review checklist render (7b)', () => {
  test('renders the verdict, score, cycles and each checklist item with verified/evidence/howExercised', () => {
    const t = text(renderReviewLines(review, 100));
    expect(t).toContain('not passed');
    expect(t).toContain('score');
    expect(t).toContain('82');
    expect(t).toContain('2 cycles');
    expect(t).toContain('[verified]');
    expect(t).toContain('the parser handles empty input');
    expect(t).toContain('evidence: added a test for the empty case');
    expect(t).toContain('exercised: bun test parser');
    expect(t).toContain('[unverified]');
    expect(t).toContain('errors surface a line number');
  });

  test('an empty checklist is called out as a gate failure, not hidden', () => {
    const t = text(renderReviewLines({ score: 0, passed: false, cycles: 1, checklist: [] }, 100));
    expect(t).toContain('emitted no acceptance checklist');
  });

  test('the fleet detail renders the review section only when node.review is present (never an empty shell)', () => {
    const withT = text(renderFleetDetailLines(chainNode(true), 100, false, false));
    expect(withT).toContain('the parser handles empty input');
    const withoutT = text(renderFleetDetailLines(chainNode(false), 100, false, false));
    expect(withoutT).not.toContain('review');
  });
});

describe('task-graph posture render (7c)', () => {
  test('renders the pool posture and the dependency edges by title', () => {
    const t = text(renderGraphPostureLines(graph, 100));
    expect(t).toContain('1 ready, 1 running');
    expect(t).toContain('at cap (fleet.maxSize=2)');
    expect(t).toContain('1 dependency link(s)');
    expect(t).toContain('schema → API');
  });

  test('an edgeless graph states so honestly', () => {
    const t = text(renderGraphPostureLines({ ...graph, edges: [] }, 100));
    expect(t).toContain('no dependency edges');
  });
});

describe('fleet-acts graph fetch/cache (7c wiring)', () => {
  function makeActs(getGraph: FleetGateway['getGraph'], available = true) {
    const gateway = { getGraph } as unknown as FleetGateway;
    const acts = new FleetActs({
      resolveGateway: () => (available ? { available: true, gateway } : { available: false, reason: 'daemon off' }),
      diffSurface: { show: () => {}, armConfirm: () => {}, close: () => {} } as FleetDiffSurface,
      notify: () => {},
      markDirty: () => {},
      findNode: () => null,
    });
    return acts;
  }
  const wsNode = { id: 'workstream:ws-1', kind: 'workstream' } as ProcessNode;

  test('ensureGraphFor fetches once and caches; graphFor returns the snapshot', async () => {
    let calls = 0;
    const acts = makeActs(async () => { calls += 1; return graph as unknown as FleetGraphSnapshot; });
    acts.ensureGraphFor(wsNode);
    acts.ensureGraphFor(wsNode); // second call must not refetch (in-flight/cache guard)
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toBe(1);
    expect(acts.graphFor(wsNode.id)).toBeTruthy();
  });

  test('a non-workstream node never triggers a fetch', () => {
    let calls = 0;
    const acts = makeActs(async () => { calls += 1; return graph as unknown as FleetGraphSnapshot; });
    acts.ensureGraphFor({ id: 'agent:1', kind: 'agent' } as ProcessNode);
    expect(calls).toBe(0);
    expect(acts.graphFor('agent:1')).toBeUndefined();
  });

  test('an unavailable daemon caches null (no per-frame nag)', () => {
    const acts = makeActs(async () => graph as unknown as FleetGraphSnapshot, false);
    acts.ensureGraphFor(wsNode);
    expect(acts.graphFor(wsNode.id)).toBeNull();
  });
});
