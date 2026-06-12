/**
 * Session maintenance types and local evaluator.
 *
 * The canonical evaluator is the SDK version exported from @/runtime/index.ts
 * (via operations.evaluateSessionMaintenance), which reads from configManager.
 *
 * This module provides:
 *  - The shared type surface used across TUI panels.
 *  - A thin local evaluator kept in sync with the SDK signature so panel code
 *    that passes configManager has a coherent call site.
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

/**
 * Evaluate session maintenance from config-driven thresholds.
 *
 * behavior.autoCompactThreshold (percent integer, SDK schema range [10, 100], default 80):
 *  - [10, 100] → threshold at that percent; autoCompactEnabled = true.
 *  - 0 (defensive fallback for null/missing config only; not a valid schema value).
 *
 * NOTE: The SDK's evaluateSessionMaintenance (from @/runtime/index.ts) is the
 * canonical implementation used in production.  This local version exists so
 * panel tests can import types without crossing the SDK boundary.
 */
export function evaluateSessionMaintenance(input: PanelSessionMaintenanceInput): PanelSessionMaintenanceStatus {
  const guidanceMode: PanelGuidanceMode = (input.configManager.get('behavior.guidanceMode') as PanelGuidanceMode | undefined) ?? 'minimal';
  const rawThreshold = Number(input.configManager.get('behavior.autoCompactThreshold') ?? 0);
  const thresholdPct = Math.max(0, Number.isFinite(rawThreshold) ? rawThreshold : 0);
  const autoCompactEnabled = thresholdPct > 0;

  const usagePct = input.contextWindow > 0 ? Math.min(100, Math.round((Math.max(0, input.currentTokens) / input.contextWindow) * 100)) : 0;
  const remainingTokens = Math.max(0, input.contextWindow - input.currentTokens);
  const sessionMemoryCount = Math.max(0, input.sessionMemoryCount ?? 0);
  const compactionCount = Math.max(0, input.session?.lineage?.filter((entry) => entry.branchReason === 'compaction').length ?? 0);
  const lastCompactedAt = input.session?.lastCompactedAt;
  const messageCount = Math.max(0, input.messageCount ?? 0);
  const staleByMessageGrowth = (input.session?.compactionMessageCount ?? 0) > 0
    ? messageCount - (input.session?.compactionMessageCount ?? 0) >= 12
    : messageCount >= 24;

  if (input.contextWindow <= 0) {
    return {
      level: 'unknown',
      summary: 'Context window unavailable.',
      reasons: ['Current model does not expose a known context limit yet.'],
      nextSteps: ['/provider', '/context'],
      guidanceMode,
      usagePct,
      remainingTokens,
      thresholdPct,
      autoCompactEnabled,
      sessionMemoryCount,
      compactionCount,
      lastCompactedAt,
      compactRecommended: false,
    };
  }

  if (input.session?.compactionState === 'failed') {
    return {
      level: 'needs-repair',
      summary: 'Compaction needs operator repair.',
      reasons: ['Compaction failed and the session may need manual recovery.'],
      nextSteps: ['/compact', '/health review'],
      guidanceMode,
      usagePct,
      remainingTokens,
      thresholdPct,
      autoCompactEnabled,
      sessionMemoryCount,
      compactionCount,
      lastCompactedAt,
      compactRecommended: true,
    };
  }

  const reasons: string[] = [];
  const nextSteps: string[] = [];
  let summary = 'Session maintenance is stable.';
  let compactRecommended = false;
  let level: PanelSessionMaintenanceLevel = 'stable';

  const atThreshold = autoCompactEnabled ? usagePct >= thresholdPct : usagePct >= 80;
  if (atThreshold || remainingTokens <= 15_000) {
    level = 'suggest-compact';
    summary = `Compact now to recover context headroom (${usagePct}% used).`;
    reasons.push(`Context pressure is high at ${usagePct}% usage.`);
    nextSteps.push('/compact', '/panel tokens');
    compactRecommended = true;
  } else if (usagePct >= Math.max(70, autoCompactEnabled ? thresholdPct - 10 : 70) || staleByMessageGrowth) {
    level = 'watch';
    summary = staleByMessageGrowth
      ? `Conversation has grown ${messageCount.toLocaleString()} messages since the last maintenance checkpoint.`
      : `Watch context growth (${usagePct}% used, threshold ${thresholdPct}%).`;
    reasons.push(staleByMessageGrowth
      ? `Conversation has grown ${messageCount.toLocaleString()} messages since the last maintenance checkpoint.`
      : `Context usage is climbing toward the ${thresholdPct > 0 ? `${thresholdPct}% auto-compact threshold` : 'maintenance band'}.`);
    nextSteps.push('/panel tokens');
  } else {
    reasons.push('Context pressure is currently within the stable operating band.');
  }

  if (sessionMemoryCount > 0) {
    reasons.push(`${sessionMemoryCount} pinned session memor${sessionMemoryCount === 1 ? 'y is' : 'ies are'} preserved during compaction.`);
  }
  if (compactionCount > 0) {
    reasons.push(`Last compaction ran ${lastCompactedAt ? new Date(lastCompactedAt).toISOString() : 'recently'}.`);
  }
  if (!autoCompactEnabled) {
    reasons.push('Auto-compaction is disabled; maintenance stays fully manual.');
  }

  return {
    level,
    summary,
    reasons,
    nextSteps,
    guidanceMode,
    usagePct,
    remainingTokens,
    thresholdPct,
    autoCompactEnabled,
    sessionMemoryCount,
    compactionCount,
    lastCompactedAt,
    compactRecommended,
  };
}
