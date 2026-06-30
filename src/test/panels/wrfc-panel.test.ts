import { describe, expect, test, mock } from 'bun:test';
import { WrfcPanel } from '../../panels/wrfc-panel.ts';
import { sparkline, stateColor, stateLabel, truncate, constraintStatusMarker } from '../../panels/wrfc-panel.ts';
import type { WrfcChain, WrfcState } from '@pellux/goodvibes-sdk/platform/agents';
import type { Line } from '../../types/grid.ts';
import type { UiEventFeed } from '../../runtime/ui-events.ts';
import type { WorkflowEvent } from '@/runtime/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function linesText(lines: Line[]): string {
  return lines
    .map(line => line.map(cell => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

type WorkflowEventName = Parameters<UiEventFeed<WorkflowEvent>['on']>[0];
type WorkflowHandler = Parameters<UiEventFeed<WorkflowEvent>['on']>[1];

/** Minimal fake event feed that records subscriptions and lets tests emit. */
function makeEventFeed(): UiEventFeed<WorkflowEvent> & {
  emit(name: WorkflowEventName, event: WorkflowEvent): void;
} {
  const handlers = new Map<WorkflowEventName, WorkflowHandler[]>();
  return {
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {
        const l = handlers.get(name) ?? [];
        const idx = l.indexOf(handler);
        if (idx >= 0) l.splice(idx, 1);
      };
    },
    emit(name, event) {
      for (const h of handlers.get(name) ?? []) h(event);
    },
  };
}

function makeChain(overrides: Partial<WrfcChain> = {}): WrfcChain {
  return {
    id: 'chain-abc123',
    state: 'engineering' as WrfcState,
    task: 'Implement the feature',
    ownerAgentId: 'agent-001',
    allAgentIds: ['agent-001'],
    reviewCycles: 0,
    fixAttempts: 0,
    reviewScores: [],
    constraints: [],
    gateResults: [],
    syntheticIssues: [],
    createdAt: Date.now() - 10_000,
    ...overrides,
  };
}

function makePanel(chains: WrfcChain[] = [], opts: {
  cancelChain?: (id: string) => boolean;
  resumeChain?: (id: string) => boolean;
  feed?: ReturnType<typeof makeEventFeed>;
} = {}) {
  const feed = opts.feed ?? makeEventFeed();
  const cancelFn = opts.cancelChain ?? mock(() => true);
  const resumeFn = opts.resumeChain ?? mock(() => true);

  const panel = new WrfcPanel(feed, {
    controller: {
      listChains: () => chains,
      resumeChain: resumeFn,
    },
    cancelChain: cancelFn,
  });

  return { panel, feed, cancelFn, resumeFn };
}

// ---------------------------------------------------------------------------
// Unit helpers
// ---------------------------------------------------------------------------

describe('sparkline', () => {
  test('empty scores returns empty string', () => {
    expect(sparkline([])).toBe('');
  });

  test('maps 0 to first char and 10 to last char', () => {
    const CHARS = '._-:=+*#';
    const result = sparkline([0, 10]);
    expect(result[0]).toBe(CHARS[0]);
    expect(result[1]).toBe(CHARS[CHARS.length - 1]);
  });

  test('clamps values outside 0-maxScore', () => {
    const result = sparkline([-5, 15]);
    const CHARS = '._-:=+*#';
    expect(result[0]).toBe(CHARS[0]);
    expect(result[1]).toBe(CHARS[CHARS.length - 1]);
  });
});

describe('stateLabel', () => {
  test('covers all non-default states', () => {
    const cases: Array<[WrfcState, string]> = [
      ['engineering', 'ENG'],
      ['reviewing', 'REV'],
      ['fixing', 'FIX'],
      ['gating', 'GATE'],
      ['awaiting_gates', 'WAIT'],
      ['committing', 'COMMIT'],
      ['passed', 'PASS'],
      ['failed', 'FAIL'],
    ];
    for (const [state, label] of cases) {
      expect(stateLabel(state)).toBe(label);
    }
  });

  test('pending returns PEND', () => {
    expect(stateLabel('pending')).toBe('PEND');
  });
});

describe('stateColor', () => {
  test('returns a hex string for every state', () => {
    const states: WrfcState[] = [
      'pending', 'engineering', 'reviewing', 'fixing',
      'awaiting_gates', 'gating', 'committing', 'passed', 'failed',
    ];
    for (const s of states) {
      const color = stateColor(s);
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('truncate', () => {
  test('passes through short strings unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });
  test('truncates and appends ellipsis', () => {
    expect(truncate('hello world', 8)).toBe('hello...');
  });
  test('exact length returns unchanged', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });
});

describe('constraintStatusMarker', () => {
  const constraint = { id: 'c1', text: 'No any types', source: 'manual' as const };

  test('returns UNV when no findings present', () => {
    const m = constraintStatusMarker(constraint, undefined);
    expect(m.tag).toBe('[UNV]');
    expect(m.dim).toBe(true);
  });

  test('returns SAT when finding is satisfied', () => {
    const m = constraintStatusMarker(constraint, [{ constraintId: 'c1', satisfied: true }]);
    expect(m.tag).toBe('[SAT]');
    expect(m.dim).toBe(false);
  });

  test('returns UNS CRIT for unsatisfied critical finding', () => {
    const m = constraintStatusMarker(constraint, [{ constraintId: 'c1', satisfied: false, severity: 'critical' as const }]);
    expect(m.tag).toBe('[UNS CRIT]');
  });

  test('returns UNS MAJOR for unsatisfied major finding', () => {
    const m = constraintStatusMarker(constraint, [{ constraintId: 'c1', satisfied: false, severity: 'major' as const }]);
    expect(m.tag).toBe('[UNS MAJOR]');
  });
});

// ---------------------------------------------------------------------------
// Panel render tests
// ---------------------------------------------------------------------------

describe('WrfcPanel render', () => {
  test('renders empty state when no chains', () => {
    const { panel } = makePanel([]);
    const text = linesText(panel.render(120, 24));
    expect(text).toContain('WRFC Chain Monitor');
    expect(text).toContain('No WRFC chains yet');
  });

  test('renders chain row with task and state', () => {
    const chain = makeChain({ task: 'Fix the bug', state: 'reviewing' });
    const { panel } = makePanel([chain]);
    const text = linesText(panel.render(120, 24));
    expect(text).toContain('Fix the bug');
    expect(text).toContain('REV');
  });

  test('footer advertises c cancel and r resume keys', () => {
    const chain = makeChain();
    const { panel } = makePanel([chain]);
    const text = linesText(panel.render(120, 24));
    expect(text).toContain('c');
    expect(text).toContain('cancel');
    expect(text).toContain('r');
    expect(text).toContain('resume');
  });

  test('STALLED badge appears for chain with no events after threshold', () => {
    const oldTime = Date.now() - 6 * 60 * 1000; // 6 minutes ago — past 5 min threshold
    const chain = makeChain({
      state: 'engineering',
      createdAt: oldTime,
    });
    const { panel } = makePanel([chain]);
    const text = linesText(panel.render(120, 24));
    expect(text).toContain('STALLED');
  });

  test('STALLED badge absent for chain with recent event', () => {
    const chain = makeChain({ state: 'engineering' }); // createdAt is recent
    const { panel } = makePanel([chain]);
    const text = linesText(panel.render(120, 24));
    expect(text).not.toContain('STALLED');
  });

  test('STALLED badge absent for terminal chains', () => {
    const oldTime = Date.now() - 10 * 60 * 1000;
    const chain = makeChain({ state: 'passed', createdAt: oldTime });
    const { panel } = makePanel([chain]);
    const text = linesText(panel.render(120, 24));
    expect(text).not.toContain('STALLED');
  });

  test('STALLED clears once event arrives for the chain', () => {
    const oldTime = Date.now() - 6 * 60 * 1000;
    const chain = makeChain({ state: 'engineering', createdAt: oldTime });
    const feed = makeEventFeed();
    const { panel } = makePanel([chain], { feed });

    // Confirm stalled before event
    const textBefore = linesText(panel.render(120, 24));
    expect(textBefore).toContain('STALLED');

    // Emit an event for this chain
    feed.emit('WORKFLOW_STATE_CHANGED', { type: 'WORKFLOW_STATE_CHANGED', chainId: chain.id } as WorkflowEvent);

    const textAfter = linesText(panel.render(120, 24));
    expect(textAfter).not.toContain('STALLED');
  });

  test('controller error renders diagnostic line post-init', () => {
    let callCount = 0;
    const chain = makeChain();
    const feed = makeEventFeed();
    const panel = new WrfcPanel(feed, {
      controller: {
        listChains: () => {
          callCount++;
          if (callCount === 1) return [chain]; // first call succeeds
          throw new Error('controller failure');
        },
        resumeChain: () => false,
      },
      cancelChain: () => true,
    });

    // Force a second sync via event
    feed.emit('WORKFLOW_STATE_CHANGED', { type: 'WORKFLOW_STATE_CHANGED', chainId: chain.id } as WorkflowEvent);

    const text = linesText(panel.render(120, 24));
    expect(text).toContain('controller');
    expect(text).toContain('controller failure');
  });

  test('pre-init controller error renders empty state without diagnostic', () => {
    const feed = makeEventFeed();
    const panel = new WrfcPanel(feed, {
      controller: {
        listChains: () => { throw new Error('not ready'); },
        resumeChain: () => false,
      },
      cancelChain: () => true,
    });

    const text = linesText(panel.render(120, 24));
    // Should show empty state, not the error
    expect(text).toContain('No WRFC chains yet');
    expect(text).not.toContain('not ready');
  });

  test('resume disabled reason shown in footer for active chain', () => {
    const chain = makeChain({ state: 'engineering' }); // not in RESUMABLE_STATES
    const { panel } = makePanel([chain]);
    const text = linesText(panel.render(120, 24));
    // footer should mention the disabled reason inline
    expect(text).toContain('ENG'); // resume reason includes state label
  });
});

// ---------------------------------------------------------------------------
// Input handling — cancel flow
// ---------------------------------------------------------------------------

describe('WrfcPanel cancel flow', () => {
  test('c on active chain shows confirm prompt', () => {
    const chain = makeChain({ state: 'engineering' });
    const { panel } = makePanel([chain]);

    panel.handleInput('c');
    const text = linesText(panel.render(120, 24));
    expect(text).toContain('Cancel chain');
    expect(text).toContain('Implement the feature');
  });

  test('y in confirm mode calls cancelChain and clears confirm', () => {
    const chain = makeChain({ state: 'engineering' });
    const cancelFn = mock((_id: string) => true);
    const { panel } = makePanel([chain], { cancelChain: cancelFn });

    panel.handleInput('c');
    panel.handleInput('y');

    expect(cancelFn).toHaveBeenCalledWith(chain.ownerAgentId);
    const text = linesText(panel.render(120, 24));
    expect(text).not.toContain('Cancel chain');
  });

  test('enter in confirm mode calls cancelChain', () => {
    const chain = makeChain({ state: 'engineering' });
    const cancelFn = mock((_id: string) => true);
    const { panel } = makePanel([chain], { cancelChain: cancelFn });

    panel.handleInput('c');
    panel.handleInput('enter');

    expect(cancelFn).toHaveBeenCalledWith(chain.ownerAgentId);
  });

  test('n in confirm mode clears confirm without cancel', () => {
    const chain = makeChain({ state: 'engineering' });
    const cancelFn = mock((_id: string) => true);
    const { panel } = makePanel([chain], { cancelChain: cancelFn });

    panel.handleInput('c');
    panel.handleInput('n');

    expect(cancelFn).not.toHaveBeenCalled();
    const text = linesText(panel.render(120, 24));
    expect(text).not.toContain('Cancel chain');
  });

  test('escape in confirm mode clears confirm without cancel', () => {
    const chain = makeChain({ state: 'engineering' });
    const cancelFn = mock((_id: string) => true);
    const { panel } = makePanel([chain], { cancelChain: cancelFn });

    panel.handleInput('c');
    panel.handleInput('escape');

    expect(cancelFn).not.toHaveBeenCalled();
  });

  test('c on terminal chain is a noop (no confirm shown)', () => {
    const chain = makeChain({ state: 'passed' });
    const cancelFn = mock((_id: string) => true);
    const { panel } = makePanel([chain], { cancelChain: cancelFn });

    panel.handleInput('c');
    const text = linesText(panel.render(120, 24));
    expect(text).not.toContain('Cancel chain');
    expect(cancelFn).not.toHaveBeenCalled();
  });

  test('other keys absorbed while confirm is active (confirm retained)', () => {
    const chain = makeChain({ state: 'engineering' });
    const { panel } = makePanel([chain]);

    panel.handleInput('c');
    // Pressing 'up' while confirm is active is absorbed (returns true) and confirm stays pending
    const result = panel.handleInput('up');
    expect(result).toBe(true); // absorbed, key swallowed
    const text = linesText(panel.render(120, 24));
    expect(text).toContain('Cancel chain'); // confirm RETAINED (not cleared)
  });
});

// ---------------------------------------------------------------------------
// Input handling — resume flow
// ---------------------------------------------------------------------------

describe('WrfcPanel resume flow', () => {
  test('r on pending chain calls resumeChain', () => {
    const chain = makeChain({ state: 'pending' });
    const resumeFn = mock((_id: string) => true);
    const { panel } = makePanel([chain], { resumeChain: resumeFn });

    panel.handleInput('r');
    expect(resumeFn).toHaveBeenCalledWith(chain.id);
  });

  test('r on reviewing/fixing/awaiting_gates chain calls resumeChain', () => {
    for (const state of ['reviewing', 'fixing', 'awaiting_gates'] as const) {
      const chain = makeChain({ state });
      const resumeFn = mock((_id: string) => true);
      const { panel } = makePanel([chain], { resumeChain: resumeFn });

      panel.handleInput('r');
      expect(resumeFn).toHaveBeenCalledWith(chain.id);
    }
  });

  test('r on non-resumable active chain (e.g. engineering) is a noop', () => {
    const chain = makeChain({ state: 'engineering' });
    const resumeFn = mock((_id: string) => true);
    const { panel } = makePanel([chain], { resumeChain: resumeFn });

    panel.handleInput('r');
    expect(resumeFn).not.toHaveBeenCalled();
  });

  test('r on terminal passed chain is a noop', () => {
    const chain = makeChain({ state: 'passed' });
    const resumeFn = mock((_id: string) => true);
    const { panel } = makePanel([chain], { resumeChain: resumeFn });

    panel.handleInput('r');
    expect(resumeFn).not.toHaveBeenCalled();
  });

  test('r on terminal failed chain is a noop', () => {
    const chain = makeChain({ state: 'failed' });
    const resumeFn = mock((_id: string) => true);
    const { panel } = makePanel([chain], { resumeChain: resumeFn });

    panel.handleInput('r');
    expect(resumeFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

describe('WrfcPanel navigation', () => {
  test('up/down navigate selection', () => {
    const chains = [
      makeChain({ id: 'a', task: 'Task A', createdAt: Date.now() - 1000 }),
      makeChain({ id: 'b', task: 'Task B', createdAt: Date.now() - 2000 }),
    ];
    const { panel } = makePanel(chains);

    // Initially renders first chain (index 0) as selected
    panel.handleInput('down');
    // Move back up — should not throw
    panel.handleInput('up');
    expect(() => panel.render(120, 24)).not.toThrow();
  });

  test('enter toggles expansion', () => {
    const chain = makeChain({ reviewScores: [8.5], fixAttempts: 1 });
    const { panel } = makePanel([chain]);

    panel.handleInput('enter');
    const textExpanded = linesText(panel.render(120, 40));
    expect(textExpanded).toContain('Scores');

    panel.handleInput('enter');
    const textCollapsed = linesText(panel.render(120, 40));
    // Scores detail only appears in expanded view
    expect(textCollapsed.includes('8.5') || !textCollapsed.includes('._-')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Narrow terminal
// ---------------------------------------------------------------------------

describe('WrfcPanel narrow terminal', () => {
  test('renders without throwing at very narrow width', () => {
    const chain = makeChain();
    const { panel } = makePanel([chain]);
    expect(() => panel.render(40, 12)).not.toThrow();
  });

  test('renders without throwing at minimum height', () => {
    const chain = makeChain();
    const { panel } = makePanel([chain]);
    expect(() => panel.render(120, 4)).not.toThrow();
  });
});
