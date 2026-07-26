// ---------------------------------------------------------------------------
// fleet-steer.test.ts
// Pure steer-badge rendering helpers and the "dropped
// inference" reconciliation pass, independent of FleetPanel/rendering.
// Integration coverage (keyboard-driven steer -> badge -> consumed/dropped,
// end to end through FleetPanel.handleInput) lives in fleet-panel.test.ts;
// this file isolates the pure logic itself.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { STEER_TTL_MS, type ProcessNode } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import { reconcileSteerBadges, steerBadgeGlyph, steerBadgeTone } from '../../panels/fleet-steer.ts';
import type { FleetTab, SteerBadgeStatus } from '../../panels/fleet-tabs.ts';
import { DEFAULT_PANEL_PALETTE } from '../../panels/polish.ts';
import { MessageLineCache } from '../../core/conversation-line-cache.ts';

const NOW = 1_700_000_000_000;

function makeTab(overrides: Partial<FleetTab> & { nodeId: string }): FleetTab {
  return {
    kind: 'agent',
    agentId: overrides.nodeId,
    label: overrides.nodeId,
    lineCache: new MessageLineCache(),
    ledgerEntries: null,
    ledgerLoadStarted: false,
    steerDraft: null,
    steerBadge: null,
    ...overrides,
  };
}

function makeNode(overrides: Partial<ProcessNode> & { id: string }): ProcessNode {
  return {
    kind: 'agent',
    label: overrides.id,
    state: 'executing-tool',
    elapsedMs: 0,
    costState: 'unpriced',
    capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: true },
    ...overrides,
  };
}

describe('steerBadgeGlyph / steerBadgeTone', () => {
  test('every status maps to a distinct, non-empty glyph', () => {
    const statuses: SteerBadgeStatus[] = ['queued', 'consumed', 'dropped'];
    const glyphs = statuses.map(steerBadgeGlyph);
    expect(glyphs.every((g) => g.length > 0)).toBe(true);
    expect(new Set(glyphs).size).toBe(statuses.length);
  });

  test('tone falls back to the DEFAULT_PANEL_PALETTE when the given palette omits the optional tone fields', () => {
    const bare = { label: '#fff', value: '#fff', dim: '#888', info: '#0af', empty: '#000' };
    expect(steerBadgeTone('queued', bare)).toBe(DEFAULT_PANEL_PALETTE.warn);
    expect(steerBadgeTone('consumed', bare)).toBe(DEFAULT_PANEL_PALETTE.good);
    expect(steerBadgeTone('dropped', bare)).toBe(DEFAULT_PANEL_PALETTE.bad);
  });

  test('tone uses the palette override when present', () => {
    const custom = { ...DEFAULT_PANEL_PALETTE, warn: '#111111', good: '#222222', bad: '#333333' };
    expect(steerBadgeTone('queued', custom)).toBe('#111111');
    expect(steerBadgeTone('consumed', custom)).toBe('#222222');
    expect(steerBadgeTone('dropped', custom)).toBe('#333333');
  });
});

describe('reconcileSteerBadges', () => {
  test('a queued badge whose node is still running is left untouched', () => {
    const tab = makeTab({ nodeId: 'a', steerBadge: { messageId: 'm1', status: 'queued' } });
    const findLiveNode = (id: string) => makeNode({ id, state: 'streaming' });
    const changed = reconcileSteerBadges([tab], findLiveNode, NOW);
    expect(changed).toBe(false);
    expect(tab.steerBadge).toEqual({ messageId: 'm1', status: 'queued' });
  });

  test('a queued badge whose node has gone terminal resolves to dropped with a descriptive note', () => {
    const tab = makeTab({ nodeId: 'a', steerBadge: { messageId: 'm1', status: 'queued' } });
    const findLiveNode = (id: string) => makeNode({ id, state: 'failed' });
    const changed = reconcileSteerBadges([tab], findLiveNode, NOW);
    expect(changed).toBe(true);
    expect(tab.steerBadge?.status).toBe('dropped');
    expect(tab.steerBadge?.messageId).toBe('m1'); // messageId is preserved through the transition
    expect(tab.steerBadge?.note).toContain('went failed');
    expect(tab.steerBadge?.resolvedAt).toBe(NOW);
  });

  test('a queued badge whose node has disappeared entirely (pruned) also resolves to dropped', () => {
    const tab = makeTab({ nodeId: 'a', steerBadge: { messageId: 'm1', status: 'queued' } });
    const changed = reconcileSteerBadges([tab], () => null, NOW);
    expect(changed).toBe(true);
    expect(tab.steerBadge?.status).toBe('dropped');
    expect(tab.steerBadge?.note).toContain('no longer tracked');
  });

  test('a consumed badge past its linger clears to null', () => {
    const tab = makeTab({ nodeId: 'a', steerBadge: { messageId: 'm1', status: 'consumed', resolvedAt: NOW - 10_000 } });
    const changed = reconcileSteerBadges([tab], () => makeNode({ id: 'a', state: 'streaming' }), NOW);
    expect(changed).toBe(true);
    expect(tab.steerBadge).toBeNull();
  });

  test('a consumed badge still within its linger is left untouched', () => {
    const tab = makeTab({ nodeId: 'a', steerBadge: { messageId: 'm1', status: 'consumed', resolvedAt: NOW - 100 } });
    const changed = reconcileSteerBadges([tab], () => makeNode({ id: 'a', state: 'streaming' }), NOW);
    expect(changed).toBe(false);
    expect(tab.steerBadge?.status).toBe('consumed');
  });

  test('a dropped badge past its linger also clears to null', () => {
    const tab = makeTab({ nodeId: 'a', steerBadge: { messageId: 'm1', status: 'dropped', note: 'x', resolvedAt: NOW - 10_000 } });
    const changed = reconcileSteerBadges([tab], () => null, NOW);
    expect(changed).toBe(true);
    expect(tab.steerBadge).toBeNull();
  });

  test('a tab with no badge is a no-op', () => {
    const tab = makeTab({ nodeId: 'a' });
    const changed = reconcileSteerBadges([tab], () => makeNode({ id: 'a' }), NOW);
    expect(changed).toBe(false);
  });

  test('an empty tab list is a no-op', () => {
    expect(reconcileSteerBadges([], () => null, NOW)).toBe(false);
  });

  test('multiple tabs are reconciled independently', () => {
    const queuedAndTerminal = makeTab({ nodeId: 'a', steerBadge: { messageId: 'm1', status: 'queued' } });
    const queuedAndRunning = makeTab({ nodeId: 'b', steerBadge: { messageId: 'm2', status: 'queued' } });
    const findLiveNode = (id: string) => (id === 'a' ? makeNode({ id, state: 'done' }) : makeNode({ id, state: 'streaming' }));
    const changed = reconcileSteerBadges([queuedAndTerminal, queuedAndRunning], findLiveNode, NOW);
    expect(changed).toBe(true);
    expect(queuedAndTerminal.steerBadge?.status).toBe('dropped');
    expect(queuedAndRunning.steerBadge?.status).toBe('queued');
  });

  // -------------------------------------------------------------------------
  // TTL-expiry fallback (long-tool-call case): the target stays healthy and
  // non-terminal throughout, but the underlying steer message's own TTL
  // (the SDK's MessageBus stamps every steer with STEER_TTL_MS — see
  // registry.js's steer()) lapses in the bus without ever producing a
  // COMMUNICATION_CONSUMED. Without this, the badge would show 'queued'
  // forever even though the message is provably gone.
  // -------------------------------------------------------------------------
  test('a queued badge whose target is still healthy/non-terminal is left untouched well within the TTL', () => {
    const tab = makeTab({ nodeId: 'a', steerBadge: { messageId: 'm1', status: 'queued', queuedAt: NOW - 1_000 } });
    const changed = reconcileSteerBadges([tab], () => makeNode({ id: 'a', state: 'executing-tool' }), NOW);
    expect(changed).toBe(false);
    expect(tab.steerBadge?.status).toBe('queued');
  });

  test('a queued badge past STEER_TTL_MS resolves to dropped as "expired undelivered", even though the target is still non-terminal (long-tool-call case)', () => {
    const tab = makeTab({
      nodeId: 'a',
      steerBadge: { messageId: 'm1', status: 'queued', queuedAt: NOW - STEER_TTL_MS - 1 },
    });
    const changed = reconcileSteerBadges([tab], () => makeNode({ id: 'a', state: 'executing-tool' }), NOW);
    expect(changed).toBe(true);
    expect(tab.steerBadge?.status).toBe('dropped');
    expect(tab.steerBadge?.messageId).toBe('m1');
    expect(tab.steerBadge?.note).toBe('expired undelivered');
    expect(tab.steerBadge?.resolvedAt).toBe(NOW);
  });

  test('a queued badge with no queuedAt (older/hand-built badge) never TTL-expires — absence of the field just means no inference is possible, not an error', () => {
    const tab = makeTab({ nodeId: 'a', steerBadge: { messageId: 'm1', status: 'queued' } });
    const changed = reconcileSteerBadges([tab], () => makeNode({ id: 'a', state: 'executing-tool' }), NOW + STEER_TTL_MS * 10);
    expect(changed).toBe(false);
    expect(tab.steerBadge?.status).toBe('queued');
  });

  test('a badge already dropped by the terminal-target inference (not the TTL path) is not double-processed by the TTL branch', () => {
    const tab = makeTab({
      nodeId: 'a',
      steerBadge: { messageId: 'm1', status: 'queued', queuedAt: NOW - STEER_TTL_MS - 1 },
    });
    // Terminal-target branch takes priority when both conditions are true.
    const changed = reconcileSteerBadges([tab], () => makeNode({ id: 'a', state: 'failed' }), NOW);
    expect(changed).toBe(true);
    expect(tab.steerBadge?.status).toBe('dropped');
    expect(tab.steerBadge?.note).toContain('went failed'); // terminal-target note, not the TTL note
  });
});
