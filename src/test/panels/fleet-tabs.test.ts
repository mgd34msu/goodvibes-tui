// ---------------------------------------------------------------------------
// fleet-tabs.test.ts
// Pure tab-state transitions: attach/detach/switch,
// independent of FleetPanel/rendering. Integration coverage (keyboard-driven
// attach/detach/switch through FleetPanel.handleInput) lives in
// fleet-panel.test.ts; this file isolates the state machine itself.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type { ProcessNode } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import {
  activeFleetTab,
  appendSteerText,
  attachFleetTab,
  detachActiveFleetTab,
  detachFleetTab,
  EMPTY_FLEET_TABS_STATE,
  isAttachableFleetKind,
  stepFleetTab,
  switchFleetTab,
  type FleetTabsState,
} from '../../panels/fleet-tabs.ts';

function makeNode(overrides: Partial<ProcessNode> & { id: string }): ProcessNode {
  return {
    kind: 'agent',
    label: overrides.id,
    state: 'executing-tool',
    elapsedMs: 0,
    costState: 'unpriced',
    capabilities: { interruptible: true, killable: true, pausable: false, steerable: false },
    ...overrides,
  };
}

describe('isAttachableFleetKind', () => {
  test('agent and wrfc-chain are attachable', () => {
    expect(isAttachableFleetKind('agent')).toBe(true);
    expect(isAttachableFleetKind('wrfc-chain')).toBe(true);
  });

  test('every other kind is not attachable', () => {
    for (const kind of ['wrfc-subtask', 'workflow', 'trigger', 'schedule', 'watcher', 'background-process'] as const) {
      expect(isAttachableFleetKind(kind)).toBe(false);
    }
  });

  // workstream/phase/work-item are aggregates (workstream,
  // phase) or delegate-to-their-agent leaves (work-item) — none carry their
  // own transcript, mirroring wrfc-subtask. Users attach the live 'agent'
  // leaf directly; no default change here, verified explicitly per the brief.
  test('workstream/phase/work-item are not attachable', () => {
    for (const kind of ['workstream', 'phase', 'work-item'] as const) {
      expect(isAttachableFleetKind(kind)).toBe(false);
    }
  });
});

describe('attachFleetTab', () => {
  test('attaching an agent node appends a tab and focuses it', () => {
    const state = attachFleetTab(EMPTY_FLEET_TABS_STATE, makeNode({ id: 'a' }));
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]!.nodeId).toBe('a');
    expect(state.tabs[0]!.agentId).toBe('a');
    expect(state.activeTabIndex).toBe(1);
  });

  test('attaching a second node appends without disturbing the first', () => {
    let state = attachFleetTab(EMPTY_FLEET_TABS_STATE, makeNode({ id: 'a' }));
    state = attachFleetTab(state, makeNode({ id: 'b' }));
    expect(state.tabs.map((t) => t.nodeId)).toEqual(['a', 'b']);
    expect(state.activeTabIndex).toBe(2);
  });

  test('attaching an already-open node re-focuses it instead of duplicating', () => {
    let state = attachFleetTab(EMPTY_FLEET_TABS_STATE, makeNode({ id: 'a' }));
    state = attachFleetTab(state, makeNode({ id: 'b' }));
    state = attachFleetTab(state, makeNode({ id: 'a' })); // re-attach 'a'
    expect(state.tabs.map((t) => t.nodeId)).toEqual(['a', 'b']);
    expect(state.activeTabIndex).toBe(1);
  });

  test('a wrfc-chain node attaches with an empty agentId (no single conversation)', () => {
    const state = attachFleetTab(EMPTY_FLEET_TABS_STATE, makeNode({ id: 'chain-1', kind: 'wrfc-chain' }));
    expect(state.tabs[0]!.kind).toBe('wrfc-chain');
    expect(state.tabs[0]!.agentId).toBe('');
  });

  test('a non-attachable node is a no-op (defense in depth; callers guard with isAttachableFleetKind)', () => {
    const state = attachFleetTab(EMPTY_FLEET_TABS_STATE, makeNode({ id: 'w', kind: 'watcher' }));
    expect(state).toBe(EMPTY_FLEET_TABS_STATE);
  });
});

describe('detachFleetTab / detachActiveFleetTab', () => {
  function twoTabState(): FleetTabsState {
    let state = attachFleetTab(EMPTY_FLEET_TABS_STATE, makeNode({ id: 'a' }));
    state = attachFleetTab(state, makeNode({ id: 'b' }));
    return state; // tabs=[a,b], activeTabIndex=2 ('b' focused)
  }

  test('detaching the active tab falls back to the root tree', () => {
    const state = detachFleetTab(twoTabState(), 1); // detach 'b' (active)
    expect(state.tabs.map((t) => t.nodeId)).toEqual(['a']);
    expect(state.activeTabIndex).toBe(0);
  });

  test('detaching a tab BEFORE the active one shifts activeTabIndex left to keep pointing at the same logical tab', () => {
    const state = detachFleetTab(twoTabState(), 0); // detach 'a'; 'b' (active) shifts from slot 2 to slot 1
    expect(state.tabs.map((t) => t.nodeId)).toEqual(['b']);
    expect(state.activeTabIndex).toBe(1);
  });

  test('detachActiveFleetTab on the root tree is a no-op', () => {
    const root: FleetTabsState = { tabs: [makeAttached('a')], activeTabIndex: 0 };
    expect(detachActiveFleetTab(root)).toBe(root);
  });

  test('detachFleetTab disposes the removed tab\'s line cache', () => {
    const state = twoTabState();
    const removed = state.tabs[1]!;
    removed.lineCache.renderInto(
      { history: { addLine: () => {}, addLines: () => {}, getLineCount: () => 0 }, blockRegistry: [], collapseState: new Map(), errorLineRegistry: [], messageKindRegistry: new Map(), configManager: null, splashOptions: {} },
      [{ role: 'user', content: 'x' }],
      80,
      [],
      0,
      -1,
    );
    expect(removed.lineCache.size).toBeGreaterThan(0);
    detachFleetTab(state, 1);
    expect(removed.lineCache.size).toBe(0);
  });

  function makeAttached(id: string) {
    return attachFleetTab(EMPTY_FLEET_TABS_STATE, makeNode({ id })).tabs[0]!;
  }
});

describe('switchFleetTab / stepFleetTab / activeFleetTab', () => {
  function twoTabState(): FleetTabsState {
    let state = attachFleetTab(EMPTY_FLEET_TABS_STATE, makeNode({ id: 'a' }));
    state = attachFleetTab(state, makeNode({ id: 'b' }));
    return switchFleetTab(state, 0); // start on root
  }

  test('activeFleetTab returns null for the root tree, and the tab object for a focused one', () => {
    const state = twoTabState();
    expect(activeFleetTab(state)).toBeNull();
    expect(activeFleetTab(switchFleetTab(state, 2))!.nodeId).toBe('b');
  });

  test('switchFleetTab clamps out-of-range requests to a no-op', () => {
    const state = twoTabState();
    expect(switchFleetTab(state, -1)).toBe(state);
    expect(switchFleetTab(state, 99)).toBe(state);
  });

  test('stepFleetTab walks Tree -> tab1 -> tab2 and clamps at both ends (no wraparound)', () => {
    let state = twoTabState(); // activeTabIndex 0
    state = stepFleetTab(state, 1);
    expect(state.activeTabIndex).toBe(1);
    state = stepFleetTab(state, 1);
    expect(state.activeTabIndex).toBe(2);
    state = stepFleetTab(state, 1); // clamp at the last tab
    expect(state.activeTabIndex).toBe(2);
    state = stepFleetTab(state, -1);
    state = stepFleetTab(state, -1);
    expect(state.activeTabIndex).toBe(0);
    state = stepFleetTab(state, -1); // clamp at the root
    expect(state.activeTabIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// appendSteerText — steer-composer paste normalization. A
// pasted multi-line block arrives as literal \r/\n characters, one at a time
// (see fleet-panel.ts's isCapturingTextBurst contract); this must collapse
// each line break to a single space rather than corrupting the one-line
// field with a raw control character or jamming words together.
// ---------------------------------------------------------------------------

describe('appendSteerText', () => {
  test('ordinary printable characters just append', () => {
    let draft = '';
    for (const ch of 'hello') draft = appendSteerText(draft, ch);
    expect(draft).toBe('hello');
  });

  test('a \\r in the middle of a draft becomes a single space', () => {
    expect(appendSteerText('first', '\r')).toBe('first ');
  });

  test('a \\n behaves identically to \\r', () => {
    expect(appendSteerText('first', '\n')).toBe('first ');
  });

  test('a line break on an empty draft contributes nothing (no leading space)', () => {
    expect(appendSteerText('', '\r')).toBe('');
  });

  test('a line break immediately after an existing space does not double the space', () => {
    expect(appendSteerText('first ', '\r')).toBe('first ');
  });

  test('a full CR-separated paste normalizes to single-spaced words', () => {
    let draft = '';
    for (const ch of 'first\rsecond\rthird') draft = appendSteerText(draft, ch);
    expect(draft).toBe('first second third');
  });

  test('a CRLF pair collapses to one space, not two', () => {
    let draft = '';
    for (const ch of 'first\r\nsecond') draft = appendSteerText(draft, ch);
    expect(draft).toBe('first second');
  });

  test('repeated line breaks collapse to a single space', () => {
    let draft = '';
    for (const ch of 'first\r\r\rsecond') draft = appendSteerText(draft, ch);
    expect(draft).toBe('first second');
  });
});
