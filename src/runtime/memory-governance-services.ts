// ---------------------------------------------------------------------------
// memory-governance-services.ts — the daemon-composition tail that constructs
// and starts the SDK's MemoryGovernor with the TUI fork's REAL cache adapters.
//
// Mirrors the SDK's own createRuntimeServices: the CacheRegistry, PauseController
// and the admission-gate holder are built EARLY in services.ts (so the
// scheduler gates and the knowledge background jobs can consult the pause
// controller before the governor exists); this helper is the TAIL step that
// hands them to wireDaemonMemoryGovernance with the fork's knowledge stores +
// shared session broker as the real, reclaiming cache adapters, and starts the
// governor. It is default ON — the governor is a safety feature the owner
// confirmed starts by default (wireDaemonMemoryGovernance starts it unless a
// caller opts out), so every daemon composition defends its own footprint.
//
// Kept as a one-function extraction (like wireIdlePowerAndLiveTurn) so the
// composition-parity test can pin the wiring from a single file.
// ---------------------------------------------------------------------------

import {
  wireDaemonMemoryGovernance,
  type CacheRegistry,
  type PauseController,
  type MemoryGovernor,
} from '@pellux/goodvibes-sdk/platform/runtime/memory';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { RuntimeEventBus } from '@/runtime/index.ts';

export interface MemoryGovernanceServicesDeps {
  readonly configManager: ConfigManager;
  readonly runtimeBus: RuntimeEventBus;
  /** Built early in services.ts so scheduler gates can consult it before the governor. */
  readonly cacheRegistry: CacheRegistry;
  readonly pauseController: PauseController;
  /** The deferrable background jobs the governor pauses under pressure. */
  readonly jobIds: readonly string[];
  /** Where the tripwire receipt is written so a supervisor sees the exit reason. */
  readonly receiptPath: string;
  /** The fork's three knowledge stores: real retained-entry counts + a real job-run trim. */
  readonly knowledgeStores: ReadonlyArray<{ retainedEntryCount(): number; pruneJobRuns(keep: number): number }>;
  /** The shared session broker: real retained-record count + a real GC/truncate trim. */
  readonly sessionBroker: { retainedRecordCount(): number; trimRetained(level: 'floor' | 'flush'): void };
  /** Graceful tripwire shutdown flush (async store snapshots), run before a tripwire exit. */
  readonly onTripwireShutdown?: (() => Promise<void> | void) | undefined;
}

export interface MemoryGovernanceServices {
  readonly memoryGovernor: MemoryGovernor;
}

/**
 * Construct + start the MemoryGovernor with the standard KNOWN cache adapters
 * (knowledge-store + session-union), reading the memory.* config domain. The
 * governor starts by default — it is a safety feature.
 */
export function wireMemoryGovernance(deps: MemoryGovernanceServicesDeps): MemoryGovernanceServices {
  const { configManager } = deps;
  const { memoryGovernor } = wireDaemonMemoryGovernance({
    config: {
      budgetMb: configManager.get('memory.budgetMb'),
      elevatedPct: configManager.get('memory.tier.elevatedPct'),
      highPct: configManager.get('memory.tier.highPct'),
      criticalPct: configManager.get('memory.tier.criticalPct'),
      tripwireRateMbPerSec: configManager.get('memory.tripwire.rateMbPerSec'),
      tripwireSustainSec: configManager.get('memory.tripwire.sustainSec'),
      hardLimitPct: configManager.get('memory.hardLimitPct'),
    },
    runtimeBus: deps.runtimeBus,
    cacheRegistry: deps.cacheRegistry,
    pauseController: deps.pauseController,
    jobIds: deps.jobIds,
    receiptPath: deps.receiptPath,
    // REAL cache adapters: genuine counts + trims that reclaim (knowledge
    // job-run history pruning; session broker GC + bucket truncation).
    knowledgeStores: deps.knowledgeStores,
    sessionBroker: deps.sessionBroker,
    onTripwireShutdown: deps.onTripwireShutdown,
  });
  return { memoryGovernor };
}
