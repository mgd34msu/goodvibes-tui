// ---------------------------------------------------------------------------
// fleet-tab-strip.test.ts
// renderFleetTabStrip: the fleet session-tab strip
// wrapper around the shared renderTabStrip primitive.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { renderFleetTabStrip } from '../../renderer/fleet-tab-strip.ts';
import { lineToString } from '../setup.ts';
import type { FleetTab, FleetTabsState } from '../../panels/fleet-tabs.ts';
import { MessageLineCache } from '../../core/conversation-line-cache.ts';

function makeTab(nodeId: string, label: string): FleetTab {
  return {
    nodeId,
    kind: 'agent',
    agentId: nodeId,
    label,
    lineCache: new MessageLineCache(),
    ledgerEntries: null,
    ledgerLoadStarted: false,
    steerDraft: null,
    steerBadge: null,
  };
}

describe('renderFleetTabStrip', () => {
  test('returns null when there are no attached tabs (keeps the root-tab-only view strip-free)', () => {
    const state: FleetTabsState = { tabs: [], activeTabIndex: 0 };
    expect(renderFleetTabStrip(state, 80)).toBeNull();
  });

  test('shows a "Tree" tab plus one entry per attached tab, with the active one bracketed', () => {
    const state: FleetTabsState = {
      tabs: [makeTab('a', 'agent a-01'), makeTab('b', 'agent b-01')],
      activeTabIndex: 2, // 'b' focused
    };
    const line = renderFleetTabStrip(state, 80);
    expect(line).not.toBeNull();
    const text = lineToString(line!);
    expect(text).toContain('Tree');
    expect(text).toContain('agent a-01');
    expect(text).toContain('[agent b-01]');
    expect(text).not.toContain('[Tree]');
  });

  test('the root tree is bracketed as active when activeTabIndex is 0', () => {
    const state: FleetTabsState = {
      tabs: [makeTab('a', 'agent a-01')],
      activeTabIndex: 0,
    };
    const text = lineToString(renderFleetTabStrip(state, 80)!);
    expect(text).toContain('[Tree]');
    expect(text).not.toContain('[agent a-01]');
  });

  test('reports hit regions covering every visible tab when the strip fits', () => {
    const state: FleetTabsState = {
      tabs: [makeTab('a', 'agent a-01')],
      activeTabIndex: 0,
    };
    let regions: readonly { index: number }[] = [];
    renderFleetTabStrip(state, 80, (r) => { regions = r; });
    expect(regions.length).toBe(2); // Tree + 1 attached tab
  });
});
