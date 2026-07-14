import { describe, expect, test } from 'bun:test';
import type { ProcessNode, ProcessObserved } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import { renderObservedRowLine, renderObservedDetailLines, isObservedExternalNode, type ObservedNode } from '../../panels/fleet-observed-render.ts';
import { buildFleetSnapshot } from '../../panels/fleet-read-model.ts';
import { lineToString } from '../setup.ts';

// ---------------------------------------------------------------------------
// Observed foreign agents render — externally-launched Claude Code / Codex
// sessions goodvibes only WATCHES: honest kind + liveness state, never counted
// in our-fleet counts, no stop ever, steer as a drill-in (channel or honest
// reason). Full strings at 80x24 and 60 columns.
// ---------------------------------------------------------------------------

function observedNode(steer: ProcessObserved['steer'], livenessState: 'active' | 'quiet' = 'active'): ObservedNode {
  const observed: ProcessObserved = {
    externalKind: 'claude-code',
    pid: 4242,
    cwd: '/home/dev/project',
    liveness: { state: livenessState, cpuSeconds: 12.5, detail: livenessState === 'quiet' ? 'no CPU burned since last check — may be blocked on you, not proof of idle' : 'CPU advancing' },
    steer,
    steerDrillInOnly: true,
  };
  return {
    id: 'observed:4242',
    kind: 'observed-external',
    label: 'Claude Code',
    state: 'streaming',
    elapsedMs: 60_000,
    usage: undefined,
    costUsd: null,
    costState: 'unpriced',
    capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: steer.kind === 'tmux' },
    observed,
  } as unknown as ObservedNode;
}

const TMUX_STEER: ProcessObserved['steer'] = { kind: 'tmux', paneId: '%90', tty: '/dev/pts/11' };
const NO_STEER: ProcessObserved['steer'] = { kind: 'none', reason: 'no controlling tty — cannot map a tmux pane' };

const noOverflow = (text: string, width: number) => text.split('\n').every((l) => [...l].length <= width);

describe('isObservedExternalNode (guard)', () => {
  test('true only for an observed-external node carrying observed facts', () => {
    expect(isObservedExternalNode(observedNode(TMUX_STEER))).toBe(true);
    expect(isObservedExternalNode({ kind: 'agent' } as unknown as ProcessNode)).toBe(false);
  });
});

describe('observed row render', () => {
  for (const width of [80, 60]) {
    test(`shows the honest external kind + liveness state at ${width} columns, no overflow`, () => {
      const text = lineToString(renderObservedRowLine(observedNode(TMUX_STEER, 'active'), width));
      expect(text).toContain('observed');
      expect(text).toContain('Claude Code');
      expect(text).toContain('active');
      expect(noOverflow(text, width)).toBe(true);
    });
  }

  test('a quiet session reads "quiet", not a fabricated running state', () => {
    const text = lineToString(renderObservedRowLine(observedNode(TMUX_STEER, 'quiet'), 80));
    expect(text).toContain('quiet');
  });
});

describe('observed detail render — steer drill-in, never a stop', () => {
  for (const width of [80, 60]) {
    test(`a steerable channel is named at ${width} columns`, () => {
      const lines = renderObservedDetailLines(observedNode(TMUX_STEER), width, undefined as never).map(lineToString);
      const text = lines.join('\n');
      const flat = lines.join(' ').replace(/\s+/g, ' ');
      expect(text).toContain('Claude Code');
      expect(text).toContain('pid 4242');
      expect(flat).toContain('tmux pane %90');
      // Never a stop affordance.
      expect(text).toContain('not offered');
      expect(noOverflow(text, width)).toBe(true);
    });

    test(`a none-channel states the honest reason at ${width} columns`, () => {
      const lines = renderObservedDetailLines(observedNode(NO_STEER), width, undefined as never).map(lineToString);
      const flat = lines.join(' ').replace(/\s+/g, ' ');
      expect(flat).toContain('unavailable — no controlling tty — cannot map a tmux pane');
      expect(flat).not.toContain('tmux pane %'); // no channel pane named
      expect(flat).toContain('not offered'); // still no stop
      expect(noOverflow(lines.join('\n'), width)).toBe(true);
    });
  }
});

describe('observed rows are NEVER counted in our-fleet counts', () => {
  test('an observed row present does not change the panel\'s own running count', () => {
    const ourAgent = { id: 'a1', kind: 'agent', label: 'our agent', state: 'streaming', elapsedMs: 1, usage: undefined, costUsd: null, costState: 'unpriced', capabilities: { steerable: true, killable: true, interruptible: true, pausable: false, resumable: false } } as unknown as ProcessNode;
    const baseline = buildFleetSnapshot([ourAgent]);
    const withObserved = buildFleetSnapshot([ourAgent, observedNode(TMUX_STEER, 'active') as unknown as ProcessNode]);
    expect(baseline.runningCount).toBe(1);
    // The observed foreign agent (also "running") must NOT bump our count.
    expect(withObserved.runningCount).toBe(1);
  });
});
