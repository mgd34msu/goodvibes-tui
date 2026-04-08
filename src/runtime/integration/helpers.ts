import { getPanelManager } from '../../panels/panel-manager.ts';
import type { ConfigManager } from '../../config/index.ts';
import { getRemoteRunnerRegistry } from '../remote/runner-registry.ts';
import { getRemoteSupervisor } from '../remote/supervisor.ts';
import type { RuntimeStore } from '../store/index.ts';
import type { RuntimeEventBus, RuntimeEventDomain, RuntimeEventEnvelope, AnyRuntimeEvent } from '../events/index.ts';
import { buildProviderAccountSnapshot } from '../provider-accounts/registry.ts';
import { getLocalUserAuthManager } from '../local-auth.ts';
import { getSettingsControlPlaneSnapshot } from '../settings/control-plane.ts';
import { checkRecoveryFile, readLastSessionPointer } from '../session-persistence.ts';
import { listPersistedWorktreeMeta, summarizeWorktreeOwnership } from '../worktree/registry.ts';

export interface IntegrationHelpersContext {
  readonly runtimeStore: RuntimeStore;
  readonly runtimeBus: RuntimeEventBus;
  readonly configManager?: ConfigManager;
  readonly getConversationTitle?: () => string | undefined;
}

interface PanelSnapshot {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly open: boolean;
}

let currentContext: IntegrationHelpersContext | null = null;

const EVENT_DOMAINS: readonly RuntimeEventDomain[] = [
  'session',
  'turn',
  'tools',
  'permissions',
  'tasks',
  'agents',
  'workflows',
  'orchestration',
  'communication',
  'planner',
  'plugins',
  'mcp',
  'transport',
  'compaction',
  'ui',
  'ops',
];

export function setIntegrationHelpersContext(context: IntegrationHelpersContext): void {
  currentContext = context;
}

export function clearIntegrationHelpersContext(): void {
  currentContext = null;
}

function getRequiredContext(): IntegrationHelpersContext {
  if (!currentContext) throw new Error('Integration helpers context is not initialized');
  return currentContext;
}

function getOptionalContext(): IntegrationHelpersContext | null {
  return currentContext;
}

function getPanelSnapshots(): PanelSnapshot[] {
  const manager = getPanelManager();
  const openIds = new Set([
    ...manager.getTopPane().panels.map((panel) => panel.id),
    ...manager.getBottomPane().panels.map((panel) => panel.id),
  ]);
  return manager
    .getRegisteredTypes()
    .map((registration) => ({
      id: registration.id,
      name: registration.name,
      category: registration.category,
      description: registration.description,
      open: openIds.has(registration.id),
    }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

export function buildIntegrationHelperReview(): {
  readonly apiFamilies: readonly string[];
  readonly routes: readonly string[];
  readonly sessions: number;
  readonly tasks: number;
  readonly pendingApprovals: number;
  readonly remoteContracts: number;
  readonly panels: number;
} {
  const context = getOptionalContext();
  const state = context?.runtimeStore.getState();
  const panelSnapshots = getPanelSnapshots();
  return {
    apiFamilies: [
      'session lifecycle',
      'approvals',
      'tasks and agents',
      'remote state',
      'health and diagnostics',
      'panel targeting',
      'event subscriptions',
    ],
    routes: [
      'GET /api/review',
      'GET /api/session',
      'GET /api/tasks',
      'GET /api/approvals',
      'GET /api/remote',
      'GET /api/health',
      'GET /api/accounts',
      'GET /api/settings',
      'GET /api/local-auth',
      'GET /api/continuity',
      'GET /api/worktrees',
      'GET /api/intelligence',
      'GET /api/panels',
      'POST /api/panels/open',
      'GET /api/events?domains=session,tasks',
    ],
    sessions: state?.session.id ? 1 : 0,
    tasks: state?.tasks.tasks.size ?? 0,
    pendingApprovals: state?.permissions.awaitingDecision ? 1 : 0,
    remoteContracts: getRemoteRunnerRegistry().listContracts().length,
    panels: panelSnapshots.length,
  };
}

export function getIntegrationSessionSnapshot(): Record<string, unknown> {
  const { runtimeStore, getConversationTitle } = getRequiredContext();
  const state = runtimeStore.getState();
  return {
    id: state.session.id,
    title: getConversationTitle?.() ?? '',
    status: state.session.status,
    recoveryState: state.session.recoveryState,
    projectRoot: state.session.projectRoot,
    isResumed: state.session.isResumed,
    resumedFromId: state.session.resumedFromId,
    compactionState: state.session.compactionState,
    lastCompactedAt: state.session.lastCompactedAt,
    lineage: state.session.lineage,
  };
}

export function getIntegrationTaskSnapshot(): Record<string, unknown> {
  const { runtimeStore } = getRequiredContext();
  const state = runtimeStore.getState();
  return {
    queued: state.tasks.queuedIds.length,
    running: state.tasks.runningIds.length,
    blocked: state.tasks.blockedIds.length,
    totals: {
      created: state.tasks.totalCreated,
      completed: state.tasks.totalCompleted,
      failed: state.tasks.totalFailed,
      cancelled: state.tasks.totalCancelled,
    },
    tasks: [...state.tasks.tasks.values()].map((task) => ({
      id: task.id,
      kind: task.kind,
      title: task.title,
      status: task.status,
      owner: task.owner,
      parentTaskId: task.parentTaskId,
      queuedAt: task.queuedAt,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      error: task.error,
    })),
  };
}

export function getIntegrationApprovalSnapshot(): Record<string, unknown> {
  const { runtimeStore } = getRequiredContext();
  const state = runtimeStore.getState();
  return {
    awaitingDecision: state.permissions.awaitingDecision,
    mode: state.permissions.mode,
    lastDecision: state.permissions.lastDecision,
    approvalCount: state.permissions.approvalCount,
    denialCount: state.permissions.denialCount,
    cachedChecks: state.permissions.cachedChecks,
    totalChecks: state.permissions.totalChecks,
  };
}

export function getIntegrationRemoteSnapshot(): Record<string, unknown> {
  const { runtimeStore } = getRequiredContext();
  const state = runtimeStore.getState();
  const remoteRegistry = getRemoteRunnerRegistry();
  const supervisor = getRemoteSupervisor().getSnapshot(runtimeStore);
  const contracts = remoteRegistry.listContracts();
  const pools = remoteRegistry.listPools();
  const artifacts = remoteRegistry.listArtifacts();
  return {
    daemon: {
      transportState: state.daemon.transportState,
      isRunning: state.daemon.isRunning,
      reconnectAttempts: state.daemon.reconnectAttempts,
      runningJobCount: state.daemon.runningJobCount,
      lastError: state.daemon.lastError,
    },
    acp: {
      transportState: state.acp.managerTransportState,
      activeConnectionIds: state.acp.activeConnectionIds,
      totalSpawned: state.acp.totalSpawned,
      totalFailed: state.acp.totalFailed,
      lastError: [...state.acp.connections.values()].find((connection) => connection.lastError)?.lastError,
    },
    registry: {
      pools: pools.length,
      contracts: contracts.length,
      artifacts: artifacts.length,
      poolEntries: pools.map((pool) => ({
        id: pool.id,
        label: pool.label,
        trustClass: pool.trustClass,
        preferredTemplate: pool.preferredTemplate,
        maxRunners: pool.maxRunners,
        runnerIds: pool.runnerIds,
      })),
      contractEntries: contracts.map((contract) => ({
        id: contract.id,
        runnerId: contract.runnerId,
        label: contract.label,
        template: contract.template,
        poolId: contract.poolId,
        taskId: contract.taskId,
        sourceTransport: contract.sourceTransport,
        trustClass: contract.trustClass,
        executionProtocol: contract.capabilityCeiling.executionProtocol,
        reviewMode: contract.capabilityCeiling.reviewMode,
        communicationLane: contract.capabilityCeiling.communicationLane,
        transportState: contract.transport.state,
        lastError: contract.transport.lastError,
      })),
      artifactEntries: artifacts.map((artifact) => ({
        id: artifact.id,
        runnerId: artifact.runnerId,
        createdAt: artifact.createdAt,
        status: artifact.task.status,
        summary: artifact.task.summary,
        error: artifact.task.error,
      })),
    },
    supervisor: {
      sessions: supervisor.sessions.length,
      degraded: supervisor.degradedConnections,
      capturedAt: supervisor.capturedAt,
      entries: supervisor.sessions.map((entry) => ({
        runnerId: entry.runnerId,
        label: entry.label,
        transportState: entry.transportState,
        heartbeat: entry.heartbeat.status,
        taskId: entry.taskId,
      })),
    },
  };
}

export function getIntegrationHealthSnapshot(): Record<string, unknown> {
  const { runtimeStore } = getRequiredContext();
  const state = runtimeStore.getState();
  const degradedDomains: string[] = [];
  const providerProblems = [...state.providerHealth.providers.values()]
    .filter((provider) => provider.status !== 'healthy' && provider.status !== 'unknown')
    .map((provider) => provider.providerId);
  const degradedMcpServers = [...state.mcp.servers.values()]
    .filter((server) => server.status === 'degraded' || server.status === 'auth_required' || server.schemaFreshness === 'quarantined')
    .map((server) => server.name);
  const quarantinedServers = [...state.mcp.servers.values()]
    .filter((server) => server.schemaFreshness === 'quarantined')
    .map((server) => server.name);
  if (providerProblems.length > 0) degradedDomains.push('providerHealth');
  if (degradedMcpServers.length > 0) degradedDomains.push('mcp');
  if (state.integrations.problemIds.length > 0) degradedDomains.push('integrations');
  if (state.daemon.transportState === 'degraded' || state.daemon.transportState === 'terminal_failure') degradedDomains.push('daemon');
  if (state.acp.managerTransportState === 'degraded' || state.acp.managerTransportState === 'terminal_failure') degradedDomains.push('acp');
  if (state.session.recoveryState === 'failed') degradedDomains.push('session');
  return {
    overall: degradedDomains.length > 0 ? 'degraded' : 'healthy',
    degradedDomains,
    providerProblems,
    mcpProblems: {
      degraded: degradedMcpServers,
      quarantined: quarantinedServers,
    },
    integrationProblems: state.integrations.problemIds,
  };
}

export async function getIntegrationAccountsSnapshot(): Promise<Record<string, unknown>> {
  const snapshot = await buildProviderAccountSnapshot();
  return {
    capturedAt: snapshot.capturedAt,
    configuredCount: snapshot.configuredCount,
    issueCount: snapshot.issueCount,
    providers: snapshot.providers.map((provider) => ({
      providerId: provider.providerId,
      active: provider.active,
      activeRoute: provider.activeRoute,
      preferredRoute: provider.preferredRoute,
      authFreshness: provider.authFreshness,
      availableRoutes: provider.availableRoutes,
      modelCount: provider.modelCount,
      configured: provider.configured,
      oauthReady: provider.oauthReady,
      pendingLogin: provider.pendingLogin,
      expiresAt: provider.expiresAt,
      fallbackRoute: provider.fallbackRoute,
      fallbackRisk: provider.fallbackRisk,
      activeRouteReason: provider.activeRouteReason,
      issues: provider.issues,
      recommendedActions: provider.recommendedActions,
      usageWindows: provider.usageWindows,
    })),
  };
}

export function getIntegrationSettingsSnapshot(): Record<string, unknown> {
  const context = getRequiredContext();
  if (!context.configManager) {
    return { available: false, reason: 'configManager unavailable' };
  }
  const snapshot = getSettingsControlPlaneSnapshot(context.configManager);
  return {
    available: true,
    liveKeyCount: snapshot.liveKeyCount,
    profileCount: snapshot.profileCount,
    managedLockCount: snapshot.managedLockCount,
    resolvedCounts: snapshot.resolvedCounts,
    conflicts: snapshot.conflicts,
    recentFailures: snapshot.recentFailures,
    stagedManagedBundle: snapshot.stagedManagedBundle,
    rollbackHistory: snapshot.rollbackHistory,
  };
}

export function getIntegrationLocalAuthSnapshot(): Record<string, unknown> {
  const snapshot = getLocalUserAuthManager().inspect();
  return {
    userStorePath: snapshot.userStorePath,
    bootstrapCredentialPath: snapshot.bootstrapCredentialPath,
    bootstrapCredentialPresent: snapshot.bootstrapCredentialPresent,
    userCount: snapshot.userCount,
    sessionCount: snapshot.sessionCount,
    users: snapshot.users,
    sessions: snapshot.sessions,
  };
}

export function getIntegrationContinuitySnapshot(): Record<string, unknown> {
  const context = getRequiredContext();
  const state = context.runtimeStore.getState();
  const recovery = checkRecoveryFile();
  return {
    sessionId: state.session.id,
    status: state.session.status,
    recoveryState: state.session.recoveryState,
    lastSessionPointer: readLastSessionPointer(),
    recoveryFilePresent: Boolean(recovery),
    recoveryFile: recovery ?? null,
  };
}

export function getIntegrationWorktreeSnapshot(): Record<string, unknown> {
  const records = listPersistedWorktreeMeta();
  return {
    summary: summarizeWorktreeOwnership(records),
    records,
  };
}

export function getIntegrationIntelligenceSnapshot(): Record<string, unknown> {
  const { runtimeStore } = getRequiredContext();
  const intelligence = runtimeStore.getState().intelligence;
  return {
    diagnosticsStatus: intelligence.diagnosticsStatus,
    symbolSearchStatus: intelligence.symbolSearchStatus,
    completionsStatus: intelligence.completionsStatus,
    hoverStatus: intelligence.hoverStatus,
    errorCount: intelligence.errorCount,
    warningCount: intelligence.warningCount,
    totalRequests: intelligence.totalRequests,
    avgLatencyMs: intelligence.avgLatencyMs,
  };
}

export function listIntegrationPanels(): PanelSnapshot[] {
  return getPanelSnapshots();
}

export function openIntegrationPanel(id: string, pane?: 'top' | 'bottom'): boolean {
  const manager = getPanelManager();
  const known = manager.getRegisteredTypes().some((registration) => registration.id === id);
  if (!known) return false;
  manager.open(id, pane);
  manager.show();
  return true;
}

export function createIntegrationEventStream(request: Request, domains: readonly RuntimeEventDomain[]): Response {
  const { runtimeBus } = getRequiredContext();
  const selectedDomains = domains.length > 0 ? domains : EVENT_DOMAINS;
  const encoder = new TextEncoder();
  let teardown = (): void => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const unsubs = selectedDomains.map((domain) => runtimeBus.onDomain(domain, (envelope) => {
        controller.enqueue(encoder.encode(`event: ${domain}\ndata: ${JSON.stringify(serializeEnvelope(envelope))}\n\n`));
      }));
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(': heartbeat\n\n'));
      }, 15_000);
      teardown = () => {
        clearInterval(heartbeat);
        for (const unsub of unsubs) unsub();
      };
      request.signal.addEventListener('abort', () => {
        teardown();
        controller.close();
      }, { once: true });
      controller.enqueue(encoder.encode(`event: ready\ndata: ${JSON.stringify({ domains: selectedDomains })}\n\n`));
    },
    cancel() {
      teardown();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

function serializeEnvelope(envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>): Record<string, unknown> {
  return {
    type: envelope.type,
    timestamp: envelope.ts,
    traceId: envelope.traceId,
    sessionId: envelope.sessionId,
    source: envelope.source,
    payload: envelope.payload,
  };
}
