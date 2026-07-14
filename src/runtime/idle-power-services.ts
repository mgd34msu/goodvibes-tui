// ---------------------------------------------------------------------------
// idle-power-services.ts — the idle-time / sleep-ownership / live-turn slice of
// the runtime composition, extracted from services.ts (file-size hygiene).
//
// Mirrors the SDK's own createRuntimeServices wiring: idle-time memory
// consolidation (learning.consolidation.*), host sleep ownership (power.*), and
// the per-session live-turn control holder that backs the
// sessions.toolCalls.cancel / sessions.queuedMessages.* wire verbs. Consolidation
// receipts ride the SAME attach-time queue every other receipt uses — a run that
// changed something records a one-line notice into the file-backed
// feature-announcement store, drained on the next surface attach; a quiet run
// records nothing.
// ---------------------------------------------------------------------------

import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { MemoryRegistry } from '@pellux/goodvibes-sdk/platform/state';
import { MemoryConsolidationScheduler } from '@pellux/goodvibes-sdk/platform/state';
import { SessionLiveTurnControlsHolder } from '@pellux/goodvibes-sdk/platform/control-plane';
import { PowerManager, wireRuntimePower } from '@pellux/goodvibes-sdk/platform/power';
import { FeatureAnnouncementStore, featureAnnouncementsPath } from '@pellux/goodvibes-sdk/platform/runtime/feature-announcements';
import type { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/state';
import { formatConsolidationReceipt } from '../core/consolidation-receipt.ts';

export interface IdlePowerServicesDeps {
  readonly configManager: ConfigManager;
  readonly memoryRegistry: MemoryRegistry;
  readonly runtimeBus: RuntimeEventBus;
  /** True when no session is busy — the consolidation scheduler's idle gate. */
  readonly isIdle: () => boolean;
  /** Sleep-edge checkpoint + a wake catch-up tick (store snapshots). */
  readonly snapshotTick: () => void;
  /** Wake catch-up: fire the automation heartbeat. */
  readonly heartbeat: () => Promise<void>;
  /** Injectable platform seam (tests); defaults to the OS pick inside wireRuntimePower. */
  readonly powerSeam?: Parameters<typeof wireRuntimePower>[0]['seam'];
}

export interface IdlePowerServices {
  readonly memoryConsolidationScheduler: MemoryConsolidationScheduler;
  readonly powerManager: PowerManager;
  readonly sessionLiveTurnControls: SessionLiveTurnControlsHolder;
}

/** Construct (and start) the idle-consolidation scheduler, power manager, and live-turn holder. */
export function wireIdlePowerAndLiveTurn(deps: IdlePowerServicesDeps): IdlePowerServices {
  const consolidationReceiptStore = new FeatureAnnouncementStore(featureAnnouncementsPath(deps.configManager));
  const memoryConsolidationScheduler = new MemoryConsolidationScheduler({
    memoryRegistry: deps.memoryRegistry,
    configSource: deps.configManager,
    isIdle: deps.isIdle,
    onReceipt: (receipt) => {
      const text = formatConsolidationReceipt(receipt);
      if (text) consolidationReceiptStore.record(receipt.runId, text);
    },
  });
  memoryConsolidationScheduler.start();
  const sessionLiveTurnControls = new SessionLiveTurnControlsHolder();
  const powerManager = wireRuntimePower({
    readConfig: (key) => deps.configManager.get(key as Parameters<typeof deps.configManager.get>[0]),
    writeConfig: (key, value) => deps.configManager.setDynamic(key as Parameters<typeof deps.configManager.setDynamic>[0], value),
    // Live config subscription: an external edit to power.keepAwake (a settings-
    // modal toggle, a hand-edited settings file) applies LIVE to the in-process
    // manager — acquires/releases the inhibitor and lights the chip with no
    // restart. This is the config-apply path for the EMBEDDED topology + the
    // local chip; the external daemon is reached separately over the verb.
    subscribeConfig: (key, cb) => (deps.configManager.subscribe as unknown as (k: string, c: (v: unknown) => void) => () => void)(key, (newValue) => cb(newValue)),
    runtimeBus: deps.runtimeBus,
    sleepCheckpoint: deps.snapshotTick,
    wakeCatchUp: [() => memoryConsolidationScheduler.tick(), deps.snapshotTick, deps.heartbeat],
    seam: deps.powerSeam,
  });
  return { memoryConsolidationScheduler, powerManager, sessionLiveTurnControls };
}
