import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { evaluateSessionMaintenance } from '@/runtime/index.ts';
import type {
  UiContinuitySnapshot,
  UiIntelligenceSnapshot,
  UiLocalAuthSnapshot,
  UiRemoteSnapshot,
  UiSecuritySnapshot,
  UiSessionSnapshot,
  UiSettingsSnapshot,
  UiWorktreeSnapshot,
} from '../runtime/ui-read-models.ts';

export interface HealthDomainSummary {
  readonly name: string;
  readonly level: 'good' | 'warn' | 'bad' | 'info';
  readonly summary: string;
  readonly next: string;
  readonly details: readonly string[];
  readonly nextSteps: readonly string[];
}

export interface ProviderHealthDomainInputs {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly auth: UiLocalAuthSnapshot;
  readonly settings: UiSettingsSnapshot;
  readonly remote: UiRemoteSnapshot;
  readonly security: UiSecuritySnapshot;
  readonly intelligence: UiIntelligenceSnapshot;
  readonly continuity: UiContinuitySnapshot;
  readonly worktrees: UiWorktreeSnapshot;
  readonly session: UiSessionSnapshot;
}

export function buildProviderHealthDomainSummaries(
  input: ProviderHealthDomainInputs,
): HealthDomainSummary[] {
  const summaries: HealthDomainSummary[] = [];
  const {
    configManager,
    auth,
    settings,
    remote,
    security,
    intelligence,
    continuity,
    worktrees,
    session,
  } = input;

  summaries.push({
    name: 'auth',
    level: auth.bootstrapCredentialPresent || auth.userCount <= 1 ? 'warn' : 'good',
    summary: auth.bootstrapCredentialPresent
      ? 'bootstrap credential file still present'
      : `${auth.userCount} users / ${auth.sessionCount} sessions`,
    next: auth.bootstrapCredentialPresent ? '/auth local clear-bootstrap-file' : '/auth local review',
    details: [
      auth.bootstrapCredentialPresent ? 'bootstrap credential file should be cleared after rotation' : `${auth.userCount} local auth users configured`,
      auth.userCount <= 1 ? 'only one local auth user configured' : `${auth.sessionCount} active local auth sessions`,
    ].filter(Boolean),
    nextSteps: auth.bootstrapCredentialPresent
      ? ['/auth local review', '/auth local rotate-password <user> <password>', '/auth local clear-bootstrap-file']
      : ['/auth local review'],
  });

  const settingIssueCount = settings.conflictCount + settings.recentFailureCount + (settings.hasStagedManagedBundle ? 1 : 0);
  summaries.push({
    name: 'settings',
    level: !settings.available ? 'info' : settingIssueCount > 0 ? 'warn' : 'good',
    summary: !settings.available
      ? 'settings control plane unavailable'
      : settingIssueCount > 0
        ? `${settings.conflictCount} conflicts / ${settings.recentFailureCount} failures${settings.hasStagedManagedBundle ? ' / staged bundle' : ''}`
        : 'settings control plane clean',
    next: settingIssueCount > 0 ? '/settings-sync panel' : '/settings-sync show <key>',
    details: [
      settings.conflictCount > 0 ? `${settings.conflictCount} unresolved import conflict(s)` : '',
      settings.recentFailureCount > 0 ? `${settings.recentFailureCount} recent sync or managed failure(s)` : '',
      settings.hasStagedManagedBundle ? 'staged managed bundle awaits apply or rollback' : '',
      settings.managedLockCount > 0 ? `${settings.managedLockCount} managed lock(s) enforced` : '',
    ].filter(Boolean),
    nextSteps: settingIssueCount > 0
      ? ['/settings-sync panel', '/settings-sync show <key>', '/managed staged']
      : ['/settings-sync show <key>'],
  });

  summaries.push({
    name: 'remote',
    level: remote.supervisor.degradedConnections > 0 ? 'warn' : remote.supervisor.sessions.length > 0 ? 'good' : 'info',
    summary: remote.supervisor.sessions.length === 0
      ? 'no remote sessions tracked'
      : `${remote.supervisor.sessions.length} sessions / ${remote.supervisor.degradedConnections} degraded`,
    next: remote.supervisor.degradedConnections > 0 ? '/remote recover <runnerId>' : '/remote supervisor',
    details: remote.supervisor.sessions.length === 0
      ? ['no remote sessions have been attached yet']
      : remote.supervisor.sessions
          .filter((entry) =>
            entry.transportState === 'degraded'
            || entry.transportState === 'reconnecting'
            || entry.transportState === 'terminal_failure'
            || entry.heartbeat.status !== 'fresh'
            || Boolean(entry.lastError))
          .slice(0, 3)
          .map((entry) => `${entry.runnerId}: transport=${entry.transportState} heartbeat=${entry.heartbeat.status}${entry.lastError ? ` error=${entry.lastError}` : ''}`),
    nextSteps: remote.supervisor.degradedConnections > 0
      ? ['/remote supervisor', '/remote recover <runnerId>', '/remote capabilities']
      : ['/remote supervisor'],
  });

  const degradedServers = security.mcpServers.filter((server) =>
    !server.connected
    || server.schemaFreshness !== 'fresh'
    || Boolean(server.quarantineReason)
    || server.trustMode === 'allow-all');
  const connectedServerCount = security.mcpServers.filter((server) => server.connected).length;
  summaries.push({
    name: 'mcp',
    level: degradedServers.length > 0 ? 'warn' : security.mcpServers.length > 0 ? 'good' : 'info',
    summary: security.mcpServers.length === 0
      ? 'no MCP servers configured'
      : `${connectedServerCount}/${security.mcpServers.length} connected, ${degradedServers.length} need review`,
    next: degradedServers.length > 0 ? '/mcp repair' : '/mcp review',
    details: degradedServers.length === 0
      ? (security.mcpServers.length === 0 ? ['no MCP servers registered'] : ['all MCP servers are healthy'])
      : degradedServers
          .slice(0, 3)
          .map((server) => `${server.name}: trust=${server.trustMode} schema=${server.schemaFreshness}${server.quarantineReason ? ` quarantine=${server.quarantineReason}` : ''}`),
    nextSteps: degradedServers.length > 0
      ? ['/mcp review', '/mcp auth-review', '/mcp repair']
      : ['/mcp review'],
  });

  const intelligenceIssues = [
    intelligence.diagnosticsStatus,
    intelligence.symbolSearchStatus,
    intelligence.completionsStatus,
    intelligence.hoverStatus,
  ].filter((status) => status !== 'ready').length;
  summaries.push({
    name: 'intelligence',
    level: intelligenceIssues > 0 ? 'warn' : 'good',
    summary: intelligenceIssues > 0
      ? `${intelligenceIssues} readiness surface(s) degraded`
      : `ready (${intelligence.totalRequests} req / ${Math.round(intelligence.avgLatencyMs)}ms avg)`,
    next: intelligenceIssues > 0 ? '/intelligence repair' : '/intelligence review',
    details: [
      intelligence.diagnosticsStatus !== 'ready' ? `diagnostics=${intelligence.diagnosticsStatus}` : '',
      intelligence.symbolSearchStatus !== 'ready' ? `symbols=${intelligence.symbolSearchStatus}` : '',
      intelligence.completionsStatus !== 'ready' ? `completions=${intelligence.completionsStatus}` : '',
      intelligence.hoverStatus !== 'ready' ? `hover=${intelligence.hoverStatus}` : '',
    ].filter(Boolean),
    nextSteps: intelligenceIssues > 0
      ? ['/intelligence diagnostics', '/intelligence repair', '/health intelligence']
      : ['/intelligence review'],
  });

  const maintenance = evaluateSessionMaintenance({
    configManager,
    currentTokens: session.estimatedContextTokens,
    contextWindow: session.contextWindow,
    messageCount: session.messageCount,
    session: session.session,
  });
  summaries.push({
    name: 'maintenance',
    level: maintenance.level === 'needs-repair'
      ? 'bad'
      : maintenance.level === 'suggest-compact' || maintenance.level === 'watch'
        ? 'warn'
        : 'good',
    summary: maintenance.summary,
    next: maintenance.nextSteps[0] ?? '/guidance review',
    details: maintenance.reasons.slice(0, 3),
    nextSteps: maintenance.nextSteps,
  });

  summaries.push({
    name: 'continuity',
    level: continuity.recoveryFilePresent ? 'warn' : continuity.lastSessionPointer ? 'good' : 'info',
    summary: continuity.recoveryFilePresent
      ? `recovery file present for ${continuity.sessionId || '(unknown session)'}`
      : continuity.lastSessionPointer ? `last session pointer ${continuity.lastSessionPointer}` : 'no last-session pointer',
    next: continuity.recoveryFilePresent ? '/session resume <id>' : '/session list',
    details: [
      continuity.returnContext ? `last activity: ${continuity.returnContext.activityLabel}` : '',
      continuity.returnContext ? `resume posture: ${continuity.returnContext.statusLabel}` : '',
      !continuity.lastSessionPointer ? 'no persisted last-session pointer recorded' : '',
    ].filter(Boolean),
    nextSteps: continuity.recoveryFilePresent
      ? ['/session list', '/session resume <id>', '/health continuity']
      : ['/session list'],
  });

  const worktreeSummary = worktrees.summary;
  const worktreeIssues = worktreeSummary.discard + worktreeSummary.pendingCleanup + worktreeSummary.paused;
  summaries.push({
    name: 'worktrees',
    level: worktreeIssues > 0 ? 'warn' : worktreeSummary.total > 0 ? 'good' : 'info',
    summary: worktreeSummary.total === 0
      ? 'no persisted worktrees'
      : `${worktreeSummary.total} tracked / ${worktreeIssues} need review`,
    next: worktreeIssues > 0 ? '/worktree recover <session|task> <id>' : '/worktree review',
    details: [
      worktreeSummary.paused > 0 ? `${worktreeSummary.paused} paused worktree(s)` : '',
      worktreeSummary.pendingCleanup > 0 ? `${worktreeSummary.pendingCleanup} cleanup pending` : '',
      worktreeSummary.discard > 0 ? `${worktreeSummary.discard} marked discard` : '',
    ].filter(Boolean),
    nextSteps: worktreeIssues > 0
      ? ['/worktree review', '/worktree recover <session|task> <id>']
      : ['/worktree review'],
  });

  return summaries;
}
