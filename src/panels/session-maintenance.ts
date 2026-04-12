export type PanelGuidanceMode = 'off' | 'minimal' | 'guided';
export type PanelSessionMaintenanceLevel = 'stable' | 'watch' | 'suggest-compact' | 'compacting' | 'needs-repair' | 'unknown';

export interface PanelSessionMaintenanceLineageEntry {
  readonly branchReason?: string;
}

export interface PanelSessionMaintenanceSession {
  readonly lineage?: readonly PanelSessionMaintenanceLineageEntry[];
  readonly lastCompactedAt?: number;
  readonly compactionMessageCount?: number;
}

export interface PanelSessionMaintenanceInput {
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
  readonly thresholdPct: number;
  readonly autoCompactEnabled: boolean;
  readonly sessionMemoryCount: number;
  readonly compactionCount: number;
  readonly lastCompactedAt?: number;
  readonly compactRecommended: boolean;
}

export function evaluateSessionMaintenance(input: PanelSessionMaintenanceInput): PanelSessionMaintenanceStatus {
  const guidanceMode: PanelGuidanceMode = 'minimal';
  const thresholdPct = 80;
  const autoCompactEnabled = false;
  const usagePct = input.contextWindow > 0 ? Math.min(100, Math.round((Math.max(0, input.currentTokens) / input.contextWindow) * 100)) : 0;
  const remainingTokens = Math.max(0, input.contextWindow - input.currentTokens);
  const sessionMemoryCount = Math.max(0, input.sessionMemoryCount ?? 0);
  const compactionCount = Math.max(0, input.session?.lineage?.filter((entry) => entry.branchReason === 'compaction').length ?? 0);
  const lastCompactedAt = input.session?.lastCompactedAt;
  const messageCount = Math.max(0, input.messageCount ?? 0);
  const staleByMessageGrowth = compactionCount > 0
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

  const reasons: string[] = [];
  const nextSteps: string[] = [];
  let summary = 'Session maintenance is stable.';
  let compactRecommended = false;
  let level: PanelSessionMaintenanceLevel = 'stable';

  if (usagePct >= 90) {
    level = 'needs-repair';
    summary = `Compact now to recover context headroom (${usagePct}% used).`;
    reasons.push(`Context pressure is high at ${usagePct}% usage.`);
    nextSteps.push('/compact', '/panel tokens');
    compactRecommended = true;
  } else if (usagePct >= thresholdPct || remainingTokens <= 15_000) {
    level = 'suggest-compact';
    summary = `Watch context growth (${usagePct}% used).`;
    reasons.push(`Context pressure is climbing at ${usagePct}% usage.`);
    nextSteps.push('/panel tokens');
    compactRecommended = true;
  } else if (usagePct >= 70 || staleByMessageGrowth) {
    level = 'watch';
    summary = staleByMessageGrowth
      ? `Conversation has grown ${messageCount.toLocaleString()} messages since the last maintenance checkpoint.`
      : `Watch context growth (${usagePct}% used, threshold ${thresholdPct}%).`;
    reasons.push(staleByMessageGrowth
      ? `Conversation has grown ${messageCount.toLocaleString()} messages since the last maintenance checkpoint.`
      : `Context usage is climbing toward the ${thresholdPct}% maintenance threshold.`);
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
    reasons.push('Auto-compact is currently disabled; use /compact when you need to recover headroom.');
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
