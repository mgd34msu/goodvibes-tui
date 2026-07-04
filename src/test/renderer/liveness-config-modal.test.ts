/**
 * W6 liveness coverage — E's liveness-contract harness (../helpers/liveness.ts)
 * pointed at the WO-A config-modal surfaces through the REAL host render path
 * (ConfigModal + renderConfigModal + ModalFactory), as the integrator brief
 * requires. A values-only update (mutating a non-selected row's live value while
 * the row-id set is unchanged) must repaint in place: identical skeleton, cursor
 * unmoved, exactly one row differs, no structural glyph touched.
 *
 * Covered: providers-modal (the charter's live-modal exemplar — REQUIRED; its
 * async inspect cache is driven deterministically) and remote-modal (a second
 * group-A surface, read-model backed). The group-B ported surface the brief also
 * calls for is not covered here: the group-B → ConfigModalSurface port is
 * deferred (see the WO-D report), so those surfaces do not yet render through
 * this host path.
 */
import { describe, test, expect } from 'bun:test';
import { ConfigModal } from '../../input/config-modal.ts';
import { renderConfigModal } from '../../renderer/config-modal.ts';
import { createProviderHealthModalSurface, type ProviderRuntimeInspect } from '../../panels/modals/provider-health-modal.ts';
import { createRemoteModalSurface } from '../../panels/modals/remote-modal.ts';
import {
  assertFrameLiveness,
  differingCells,
  selectionRow,
  DEFAULT_STRUCTURAL_GLYPHS,
} from '../helpers/liveness.ts';

const W = 120;
const H = 28;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 15));

describe('liveness contract — providers-modal (values-only update, real host path)', () => {
  test('a model-count value update on a NON-selected provider row repaints in place: no reflow, cursor unchanged, one row differs', async () => {
    // Same ids across both frames (structure stable); only modelCount changes.
    const snaps: Array<{ providerId: string; active: boolean; modelCount: number }> = [
      { providerId: 'anthropic', active: true, modelCount: 5 },
      { providerId: 'openai', active: true, modelCount: 3 },
    ];
    const runtime: ProviderRuntimeInspect = {
      listProviderIds: () => snaps.map((s) => s.providerId),
      inspectAll: async () => snaps as never,
    };
    const surface = createProviderHealthModalSurface(runtime);
    const modal = new ConfigModal();
    try {
      modal.open(surface, () => {});
      await tick(); // let the async reinspect populate the cache
      modal.moveDown(); // interaction boundary: re-freeze structure with the loaded cache, select row 2

      const frameA = renderConfigModal(modal, W, H);
      const cursorA = selectionRow(frameA);
      expect(cursorA).toBeGreaterThanOrEqual(0);

      // Values-only live tick: reinspect() stored the snapshot object refs in the
      // surface's cache, so mutating the NON-selected first provider's modelCount
      // mutates the cached object — the next render's buildView() reflects it with
      // no interaction (exactly what the surface's 3s live tick repaints). No
      // status line, no structural change.
      snaps[0]!.modelCount = 6;
      const frameB = renderConfigModal(modal, W, H);

      assertFrameLiveness(frameA, frameB);
      expect(selectionRow(frameB)).toBe(cursorA);

      const diffs = differingCells(frameA, frameB);
      expect(diffs.length).toBeGreaterThan(0);
      expect(new Set(diffs.map((d) => d.row)).size).toBe(1);
      expect(diffs.some((d) => DEFAULT_STRUCTURAL_GLYPHS.has(d.from) || DEFAULT_STRUCTURAL_GLYPHS.has(d.to))).toBe(false);
    } finally {
      modal.close(); // clears the surface's 3s live-tick interval
    }
  });

  test('an identical re-render trivially satisfies the contract (no diffs)', async () => {
    const snaps = [{ providerId: 'anthropic', active: true, modelCount: 5 }];
    const runtime: ProviderRuntimeInspect = {
      listProviderIds: () => snaps.map((s) => s.providerId),
      inspectAll: async () => snaps as never,
    };
    const modal = new ConfigModal();
    try {
      modal.open(createProviderHealthModalSurface(runtime), () => {});
      await tick();
      modal.moveDown();
      const a = renderConfigModal(modal, W, H);
      const b = renderConfigModal(modal, W, H);
      assertFrameLiveness(a, b);
      expect(differingCells(a, b)).toEqual([]);
    } finally {
      modal.close();
    }
  });
});

describe('liveness contract — remote-modal (values-only update, real host path)', () => {
  function makeSnapshot() {
    return {
      daemon: { transportState: 'connected', isRunning: true, reconnectAttempts: 0, runningJobCount: 1 },
      acp: {
        transportState: 'connected',
        activeConnections: [
          { agentId: 'agent-alpha', transportState: 'connected', messageCount: 4, errorCount: 0, label: 'r1' },
          { agentId: 'agent-bravo', transportState: 'connected', messageCount: 2, errorCount: 0, label: 'r2' },
        ],
      },
      contracts: [],
      artifacts: [],
      supervisor: { sessions: [] },
      distributed: { peers: [] },
    };
  }

  test('a message-count update on a NON-selected connection row repaints in place: no reflow, cursor unchanged, one row differs', () => {
    const snapshot = makeSnapshot();
    const readModel = { getSnapshot: () => snapshot, subscribe: () => () => {} };
    const surface = createRemoteModalSurface(readModel as never);
    const modal = new ConfigModal();
    try {
      modal.open(surface, () => {});
      modal.moveDown(); // select connection row 2, freeze structure

      const frameA = renderConfigModal(modal, W, H);
      const cursorA = selectionRow(frameA);
      expect(cursorA).toBeGreaterThanOrEqual(0);

      // Values-only: bump the NON-selected first connection's message count (same width).
      snapshot.acp.activeConnections[0]!.messageCount = 5;
      const frameB = renderConfigModal(modal, W, H);

      assertFrameLiveness(frameA, frameB);
      expect(selectionRow(frameB)).toBe(cursorA);

      const diffs = differingCells(frameA, frameB);
      expect(diffs.length).toBeGreaterThan(0);
      expect(new Set(diffs.map((d) => d.row)).size).toBe(1);
      expect(diffs.some((d) => DEFAULT_STRUCTURAL_GLYPHS.has(d.from) || DEFAULT_STRUCTURAL_GLYPHS.has(d.to))).toBe(false);
    } finally {
      modal.close();
    }
  });
});
