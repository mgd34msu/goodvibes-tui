import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeatureAnnouncementStore } from '@pellux/goodvibes-sdk/platform/runtime/feature-announcements';
import type { MemoryConsolidationRunReceipt } from '@pellux/goodvibes-sdk/platform/state';
import { formatConsolidationReceipt } from '../../core/consolidation-receipt.ts';
import { consumeDaemonAttachNotices } from '../../runtime/daemon-attach-notices.ts';

// ---------------------------------------------------------------------------
// STEP 7 — memory-consolidation receipts arriving through the attach-time queue
// render as one-line notices like every other receipt.
// ---------------------------------------------------------------------------

function receipt(partial: Partial<MemoryConsolidationRunReceipt>): MemoryConsolidationRunReceipt {
  return {
    runId: 'run-1',
    ranAt: new Date().toISOString(),
    trigger: 'idle',
    idle: true,
    scanned: 42,
    merged: [],
    archived: [],
    decayed: [],
    proposed: [],
    usageSignalAvailable: false,
    note: '',
    ...partial,
  } as MemoryConsolidationRunReceipt;
}

describe('formatConsolidationReceipt (STEP 7)', () => {
  test('a run that changed something is one honest line', () => {
    const text = formatConsolidationReceipt(receipt({
      merged: [{}, {}] as never,
      archived: [{}] as never,
      decayed: [{}, {}, {}] as never,
    }));
    expect(text).toBe('Memory consolidation: 2 merged, 1 archived, 3 decayed (scanned 42).');
  });

  test('a quiet run (nothing merged/archived/decayed/proposed) yields null — no notice', () => {
    expect(formatConsolidationReceipt(receipt({}))).toBeNull();
  });

  test('a run with proposals points at the real command and tab (the TUI\'s only pointer to WHAT was proposed)', () => {
    const text = formatConsolidationReceipt(receipt({ proposed: [{}, {}] as never }));
    expect(text).toBe('Memory consolidation: 2 proposed (scanned 42). Review the 2 proposed changes with /memory (Proposals tab).');
  });

  test('a single proposal uses singular "change", still naming /memory and its Proposals tab', () => {
    const text = formatConsolidationReceipt(receipt({ merged: [{}] as never, proposed: [{}] as never }));
    expect(text).toBe('Memory consolidation: 1 merged, 1 proposed (scanned 42). Review the 1 proposed change with /memory (Proposals tab).');
  });
});

describe('consolidation receipt through the attach-time queue (STEP 7)', () => {
  test('a seeded consolidation receipt renders as a one-line attach notice, once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-consolidation-'));
    try {
      const storePath = join(dir, 'announcements.json');
      // The scheduler's onReceipt records the formatted line into the file-backed
      // attach-time queue.
      const writer = new FeatureAnnouncementStore(storePath);
      const text = formatConsolidationReceipt(receipt({ merged: [{}] as never, runId: 'run-xyz' }))!;
      writer.record('run-xyz', text);

      // On attach, a surface drains the SAME queue (a fresh store at the same
      // path) — the consolidation line comes out as a one-line notice, exactly
      // like a crash/update/migration receipt does.
      const reader = new FeatureAnnouncementStore(storePath);
      const notices = consumeDaemonAttachNotices({
        configManager: { getControlPlaneConfigDir: () => dir } as never,
        collectReceipts: () => [],
        announcementStore: reader,
      });
      expect(notices).toContain('Memory consolidation: 1 merged (scanned 42).');

      // Exactly once: a second attach with nothing new shows nothing.
      const second = consumeDaemonAttachNotices({
        configManager: { getControlPlaneConfigDir: () => dir } as never,
        collectReceipts: () => [],
        announcementStore: new FeatureAnnouncementStore(storePath),
      });
      expect(second).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
