/**
 * Behavioral composition check for the memory governance layer: the TUI's
 * forked createRuntimeServices constructs a live MemoryGovernor (default ON),
 * registers the REAL cache adapters (knowledge-store + session-union), and
 * registers the three deferrable background jobs as pausable — so ops.memory.get
 * serves a genuine snapshot and the governor can actually shed footprint and
 * pause work. Complements the source-level pins in composition-parity.test.ts
 * with a runtime assertion against the constructed services object.
 */
import { describe, expect, test } from 'bun:test';
import { getTestRuntimeServices, disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

describe('memory governance is live on a TUI-composed runtime', () => {
  test('the governor is present and serves a real snapshot', () => {
    const services = getTestRuntimeServices();
    expect(services.memoryGovernor).toBeDefined();
    const snapshot = services.memoryGovernor.snapshot();
    expect(['normal', 'elevated', 'high', 'critical']).toContain(snapshot.tier);
    expect(snapshot.budgetMb).toBeGreaterThan(0);
    expect(snapshot.thresholds.elevatedPct).toBeLessThan(snapshot.thresholds.highPct);
    expect(snapshot.thresholds.highPct).toBeLessThan(snapshot.thresholds.criticalPct);
  });

  test('the REAL cache adapters are registered (knowledge-store + session-union)', () => {
    const services = getTestRuntimeServices();
    const ids = services.cacheRegistry.registeredIds();
    expect(ids).toContain('knowledge-store');
    expect(ids).toContain('session-union');
    // The governor snapshot reflects the same registered caches.
    const snapshotCacheIds = services.memoryGovernor.snapshot().caches.map((c) => c.id);
    expect(snapshotCacheIds).toContain('knowledge-store');
    expect(snapshotCacheIds).toContain('session-union');
  });

  test('the three deferrable background jobs are registered as pausable', () => {
    const services = getTestRuntimeServices();
    const jobIds = services.pauseController.states().map((s) => s.id);
    for (const id of ['knowledge-self-improvement', 'memory-consolidation', 'code-index-reindex']) {
      expect(jobIds).toContain(id);
    }
    // None paused at rest (the governor pauses them only under pressure).
    expect(services.memoryGovernor.snapshot().pausedJobs).toEqual([]);
  });
});
