import { describe, expect, test } from 'bun:test';
import { renderWorkstreamGraphLines, renderPoolSummary, type WorkstreamGraphSnapshot } from '../../panels/workstream-graph-render.ts';

// ---------------------------------------------------------------------------
// STEP 6, the task graph renders (fleet.graph.get): nodes/edges/states,
// ready / running / blocked-with-"waiting on: X" / at-cap / stalled, legible
// without opening transcripts. Full-string render at 80x24 and 60 columns, no
// clipping (every line fits the width).
// ---------------------------------------------------------------------------

type Node = WorkstreamGraphSnapshot['nodes'][number];

function node(partial: Partial<Node> & { id: string; title: string; state: string }): Node {
  return {
    cluster: undefined,
    files: [],
    mergeState: undefined,
    blockedReason: undefined,
    orphaned: false,
    remainingDepth: 0,
    stalled: false,
    agentId: undefined,
    ...partial,
  } as Node;
}

function snapshot(nodes: Node[], edges: { from: string; to: string }[], pool: WorkstreamGraphSnapshot['pool']): WorkstreamGraphSnapshot {
  return { workstreamId: 'ws1', title: 'fix-phase chain', nodes, edges, pool } as WorkstreamGraphSnapshot;
}

const noOverflow = (lines: string[], width: number) => lines.every((l) => [...l].length <= width);

describe('renderPoolSummary (STEP 6)', () => {
  test('names the at-cap posture with fleet.maxSize', () => {
    expect(renderPoolSummary({ ready: 2, running: 3, atCap: true, capKey: 'fleet.maxSize', maxSize: 3, refusal: undefined } as WorkstreamGraphSnapshot['pool']))
      .toBe('2 ready, 3 running, at cap (fleet.maxSize=3)');
  });
  test('below cap: no at-cap clause', () => {
    expect(renderPoolSummary({ ready: 1, running: 1, atCap: false, capKey: 'fleet.maxSize', maxSize: 5, refusal: undefined } as WorkstreamGraphSnapshot['pool']))
      .toBe('1 ready, 1 running');
  });
  test('no pool state is stated honestly', () => {
    expect(renderPoolSummary(null)).toBe('no pool state');
  });
});

describe('renderWorkstreamGraphLines states (STEP 6)', () => {
  for (const width of [80, 60]) {
    test(`ready / running / blocked-waiting-on / stalled all render at ${width} columns without clipping`, () => {
      const nodes = [
        node({ id: 'a', title: 'run tests', state: 'running', agentId: 'agent-7' }),
        node({ id: 'b', title: 'lint', state: 'ready' }),
        node({ id: 'c', title: 'deploy', state: 'blocked', blockedReason: 'run tests failed past its retry bound' }),
        node({ id: 'd', title: 'write docs', state: 'running', stalled: true }),
      ];
      const edges = [{ from: 'a', to: 'c' }];
      const lines = renderWorkstreamGraphLines(snapshot(nodes, edges, { ready: 1, running: 2, atCap: true, capKey: 'fleet.maxSize', maxSize: 2, refusal: undefined } as WorkstreamGraphSnapshot['pool']), width);
      // Normalize wrapped continuation lines to one flat string, nothing is
      // clipped, so the full tell survives even where it wrapped.
      const flat = lines.join(' ').replace(/\s+/g, ' ');
      expect(flat).toContain('fix-phase chain');
      expect(flat).toContain('at cap (fleet.maxSize=2)');
      expect(flat).toContain('running (agent-7)');
      expect(flat).toContain('ready');
      expect(flat).toContain('waiting on: run tests failed past its retry bound');
      expect(flat).toContain('stalled');
      expect(noOverflow(lines, width)).toBe(true);
    });
  }

  test('an orphaned node shows the orphaned tell', () => {
    const nodes = [node({ id: 'x', title: 'downstream', state: 'blocked', orphaned: true, blockedReason: 'blocker hard-failed' })];
    const text = renderWorkstreamGraphLines(snapshot(nodes, [], null), 80).join('\n');
    expect(text).toContain('orphaned');
    expect(text).toContain('waiting on: blocker hard-failed');
  });

  test('dependency edges are named inline for non-blocked nodes ("needs: …")', () => {
    const nodes = [
      node({ id: 'a', title: 'build', state: 'done' }),
      node({ id: 'b', title: 'package', state: 'ready' }),
    ];
    const text = renderWorkstreamGraphLines(snapshot(nodes, [{ from: 'a', to: 'b' }], null), 80).join('\n');
    expect(text).toContain('needs: build');
  });

  test('an empty graph is stated honestly, not a blank surface', () => {
    const lines = renderWorkstreamGraphLines(snapshot([], [], { ready: 0, running: 0, atCap: false, capKey: 'fleet.maxSize', maxSize: 4, refusal: undefined } as WorkstreamGraphSnapshot['pool']), 60);
    expect(lines.join('\n')).toContain('no work items');
    expect(noOverflow(lines, 60)).toBe(true);
  });

  test('a very long blocked reason wraps to fit 60 columns; nothing clipped, no overflow', () => {
    const nodes = [node({ id: 'a', title: 'a very long work-item title that eats the line', state: 'blocked', blockedReason: 'an extremely long blocking reason that would otherwise run well past the sixty-column boundary' })];
    const lines = renderWorkstreamGraphLines(snapshot(nodes, [], null), 60);
    expect(noOverflow(lines, 60)).toBe(true);
    // The full reason survives across wrapped lines (no clipping), the last
    // words are still present once continuation whitespace is normalized.
    const flat = lines.join(' ').replace(/\s+/g, ' ');
    expect(flat).toContain('sixty-column boundary');
    expect(flat).toContain('waiting on:');
  });
});
