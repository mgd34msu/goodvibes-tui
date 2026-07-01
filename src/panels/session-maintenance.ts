/**
 * Session maintenance types.
 *
 * The canonical evaluator is the SDK version exported from @/runtime/index.ts
 * (via operations.evaluateSessionMaintenance), which reads from configManager.
 * Import the evaluator from there — this module provides only the shared
 * Panel* type surface used across TUI panels and tests; it intentionally does
 * not re-implement the evaluator.
 */
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';

export type PanelGuidanceMode = 'off' | 'minimal' | 'guided';
export type PanelSessionMaintenanceLevel = 'stable' | 'watch' | 'suggest-compact' | 'compacting' | 'needs-repair' | 'unknown';

export interface PanelSessionMaintenanceLineageEntry {
  readonly branchReason?: string;
}

export interface PanelSessionMaintenanceSession {
  readonly lineage?: readonly PanelSessionMaintenanceLineageEntry[];
  readonly lastCompactedAt?: number;
  readonly compactionMessageCount?: number;
  readonly compactionState?: string;
}

export interface PanelSessionMaintenanceInput {
  /** ConfigManager used to read behavior.autoCompactThreshold and related keys. */
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly currentTokens: number;
  readonly contextWindow: number;
  readonly messageCount?: number;
  readonly sessionMemoryCount?: number;
  readonly session?: PanelSessionMaintenanceSession | null;
}

export interface PanelSessionMaintenanceStatus {
  readonly level: PanelSessionMaintenanceLevel;
  readonly summary: string;
  readonly reasons: readonly string[];
  readonly nextSteps: readonly string[];
  readonly guidanceMode: PanelGuidanceMode;
  readonly usagePct: number;
  readonly remainingTokens: number;
  /**
   * Compact threshold as a percent integer.
   * SDK schema range is [10, 100]; default is 80.
   */
  readonly thresholdPct: number;
  /**
   * True when autoCompactThreshold is in its valid range (>0).
   * With SDK default (80), auto-compact is active unless explicitly lowered below 10.
   */
  readonly autoCompactEnabled: boolean;
  readonly sessionMemoryCount: number;
  readonly compactionCount: number;
  readonly lastCompactedAt?: number;
  readonly compactRecommended: boolean;
}
