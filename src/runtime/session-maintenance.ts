import type { ConfigManager } from '../config/manager.ts';
import type { SessionDomainState } from './store/domains/session.ts';

export type GuidanceMode = 'off' | 'minimal' | 'guided';
export type SessionMaintenanceLevel =
  | 'stable'
  | 'watch'
  | 'suggest-compact'
  | 'compacting'
  | 'needs-repair'
  | 'unknown';

export interface SessionMaintenanceStatus {
  readonly level: SessionMaintenanceLevel;
  readonly guidanceMode: GuidanceMode;
  readonly usagePct: number;
  readonly remainingTokens: number;
  readonly thresholdPct: number;
  readonly autoCompactEnabled: boolean;
  readonly compactRecommended: boolean;
  readonly sessionMemoryCount: number;
  readonly compactionCount: number;
  readonly lastCompactedAt?: number;
  readonly summary: string;
  readonly reasons: readonly string[];
  readonly nextSteps: readonly string[];
}

export interface SessionMaintenanceInput {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly currentTokens: number;
  readonly contextWindow: number;
  readonly messageCount?: number;
  readonly sessionMemoryCount?: number;
  readonly session?: Partial<SessionDomainState>;
}

export function getGuidanceMode(configManager: Pick<ConfigManager, 'get'>): GuidanceMode {
  return (configManager.get('behavior.guidanceMode') as GuidanceMode | undefined) ?? 'minimal';
}

function compactStateIsActive(state: SessionDomainState['compactionState'] | undefined): boolean {
  return state === 'checking_threshold'
    || state === 'microcompact'
    || state === 'collapse'
    || state === 'autocompact'
    || state === 'reactive_compact'
    || state === 'boundary_commit';
}

function formatAge(ts: number | undefined): string {
  if (!ts) return 'never';
  const ageMs = Date.now() - ts;
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function evaluateSessionMaintenance(input: SessionMaintenanceInput): SessionMaintenanceStatus {
  const guidanceMode = getGuidanceMode(input.configManager);
  const thresholdPct = Math.max(0, Number(input.configManager.get('behavior.autoCompactThreshold') ?? 0));
  const autoCompactEnabled = thresholdPct > 0;
  const currentTokens = Math.max(0, input.currentTokens);
  const contextWindow = Math.max(0, input.contextWindow);
  const usagePct = contextWindow > 0 ? Math.min(100, Math.round((currentTokens / contextWindow) * 100)) : 0;
  const remainingTokens = Math.max(0, contextWindow - currentTokens);
  const sessionMemoryCount = Math.max(0, input.sessionMemoryCount ?? 0);
  const compactionCount = Math.max(0, input.session?.lineage?.filter((entry) => entry.branchReason === 'compaction').length ?? 0);
  const lastCompactedAt = input.session?.lastCompactedAt;
  const messageCount = Math.max(0, input.messageCount ?? 0);
  const warningsEnabled = Boolean(input.configManager.get('behavior.staleContextWarnings'));
  const staleByMessageGrowth =
    (input.session?.compactionMessageCount ?? 0) > 0
      ? messageCount - (input.session?.compactionMessageCount ?? 0) >= 12
      : messageCount >= 24;

  if (contextWindow <= 0) {
    return {
      level: 'unknown',
      guidanceMode,
      usagePct,
      remainingTokens,
      thresholdPct,
      autoCompactEnabled,
      compactRecommended: false,
      sessionMemoryCount,
      compactionCount,
      lastCompactedAt,
      summary: 'Context window unavailable.',
      reasons: ['Current model does not expose a known context limit yet.'],
      nextSteps: guidanceMode === 'off' ? [] : ['/provider', '/context'],
    };
  }

  const reasons: string[] = [];
  const nextSteps: string[] = [];
  let level: SessionMaintenanceLevel = 'stable';

  if (input.session?.compactionState === 'failed') {
    level = 'needs-repair';
    reasons.push('Compaction failed and the session may need manual recovery.');
    nextSteps.push('/compact', '/health review');
  } else if (compactStateIsActive(input.session?.compactionState)) {
    level = 'compacting';
    reasons.push('Compaction is currently running.');
  } else if ((autoCompactEnabled && usagePct >= thresholdPct) || usagePct >= 80 || remainingTokens <= 15_000) {
    level = 'suggest-compact';
    reasons.push(`Context pressure is high at ${usagePct}% usage.`);
    if (remainingTokens <= 15_000) {
      reasons.push(`Only ${remainingTokens.toLocaleString()} tokens remain before the safety buffer is exhausted.`);
    }
    nextSteps.push('/compact', '/panel tokens');
  } else if ((warningsEnabled && usagePct >= Math.max(70, autoCompactEnabled ? thresholdPct - 10 : 70)) || staleByMessageGrowth) {
    level = 'watch';
    reasons.push(staleByMessageGrowth
      ? `Conversation has grown ${messageCount.toLocaleString()} messages since the last maintenance checkpoint.`
      : `Context usage is climbing toward the ${thresholdPct}% auto-compact threshold.`);
    nextSteps.push('/panel tokens');
    if (guidanceMode === 'guided') nextSteps.push('/context');
  } else {
    reasons.push('Context pressure is currently within the stable operating band.');
  }

  if (sessionMemoryCount > 0) {
    reasons.push(`${sessionMemoryCount} pinned session memor${sessionMemoryCount === 1 ? 'y is' : 'ies are'} preserved during compaction.`);
  }
  if (compactionCount > 0) {
    reasons.push(`Last compaction ran ${formatAge(lastCompactedAt)}.`);
  }
  if (!autoCompactEnabled) {
    reasons.push('Auto-compaction is disabled; maintenance stays fully manual.');
    if (guidanceMode !== 'off') nextSteps.push('/settings');
  }

  const compactRecommended = level === 'suggest-compact' || level === 'needs-repair';
  const summary =
    level === 'needs-repair'
      ? 'Compaction needs operator repair.'
      : level === 'compacting'
        ? 'Compaction in progress.'
        : level === 'suggest-compact'
          ? `Compact now to recover context headroom (${usagePct}% used).`
          : level === 'watch'
            ? `Watch context growth (${usagePct}% used, threshold ${thresholdPct}%).`
            : 'Session maintenance is stable.';

  return {
    level,
    guidanceMode,
    usagePct,
    remainingTokens,
    thresholdPct,
    autoCompactEnabled,
    compactRecommended,
    sessionMemoryCount,
    compactionCount,
    lastCompactedAt,
    summary,
    reasons,
    nextSteps: [...new Set(nextSteps)],
  };
}

export function formatSessionMaintenanceLines(
  status: SessionMaintenanceStatus,
  detail: 'minimal' | 'guided' = 'minimal',
): string[] {
  const lines = [
    `Maintenance: ${status.summary}`,
  ];
  if (detail === 'guided') {
    for (const reason of status.reasons) lines.push(`  ${reason}`);
  } else if (status.reasons[0]) {
    lines.push(`  ${status.reasons[0]}`);
  }
  const nextSteps = status.nextSteps.length > 0
    ? status.nextSteps
    : detail === 'guided'
      ? ['/context']
      : [];
  if ((detail === 'guided' || status.guidanceMode !== 'off') && nextSteps.length > 0) {
    lines.push(`  Next: ${nextSteps.join('  |  ')}`);
  }
  return lines;
}
