import type { PanelManager } from '../../panels/panel-manager.ts';
import type { ConfigManager } from '../../config/index.ts';
import type { ServiceRegistry } from '../../config/service-registry.ts';
import type { SubscriptionManager } from '../../config/subscriptions.ts';
import type { SecretsManager } from '../../config/secrets.ts';
import type { AutomationManager } from '../../automation/index.ts';
import type { ApprovalBroker, SharedSessionBroker } from '../../control-plane/index.ts';
import type { DistributedRuntimeManager } from '../remote/distributed-runtime.ts';
import type { RemoteRunnerRegistry } from '../remote/runner-registry.ts';
import type { RemoteSupervisor } from '../remote/supervisor.ts';
import type { ProviderRegistry } from '../../providers/registry.ts';
import type { RuntimeStore } from '../store/index.ts';
import type { RuntimeEventBus, RuntimeEventDomain, RuntimeEventEnvelope, AnyRuntimeEvent } from '../events/index.ts';
import { buildProviderAccountSnapshot } from '../provider-accounts/registry.ts';
import type { UserAuthManager } from '../../security/user-auth.ts';
import { getSettingsControlPlaneSnapshot } from '../settings/control-plane.ts';
import { checkRecoveryFile, readLastSessionPointer } from '../session-persistence.ts';
import { listPersistedWorktreeMeta, summarizeWorktreeOwnership } from '../worktree/registry.ts';
import { inspectInboundTls, inspectOutboundTls } from '../network/index.ts';

export interface IntegrationHelpersContext {
  readonly runtimeStore: RuntimeStore;
  readonly runtimeBus: RuntimeEventBus;
  readonly configManager?: ConfigManager;
  readonly getConversationTitle?: () => string | undefined;
  readonly automationManager: AutomationManager;
  readonly approvalBroker: ApprovalBroker;
  readonly sessionBroker: SharedSessionBroker;
  readonly distributedRuntime: DistributedRuntimeManager;
  readonly remoteRunnerRegistry: RemoteRunnerRegistry;
  readonly remoteSupervisor: RemoteSupervisor;
  readonly panelManager: PanelManager;
  readonly localUserAuthManager: UserAuthManager;
  readonly providerRegistry: ProviderRegistry;
  readonly serviceRegistry: ServiceRegistry;
  readonly subscriptionManager: SubscriptionManager;
  readonly secretsManager: SecretsManager;
}

export interface PanelSnapshot {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly open: boolean;
}

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

export class IntegrationHelperService {
  constructor(private readonly context: IntegrationHelpersContext) {}

  getRuntimeStore(): RuntimeStore {
    return this.context.runtimeStore;
  }

  getContext(): IntegrationHelpersContext {
    return this.context;
  }

  buildReview(): {
    readonly apiFamilies: readonly string[];
    readonly routes: readonly string[];
    readonly sessions: number;
    readonly tasks: number;
    readonly pendingApprovals: number;
    readonly remoteContracts: number;
    readonly panels: number;
  } {
    const state = this.context.runtimeStore.getState();
    const panelSnapshots = this.listPanels();
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
        'GET /api/automation',
        'GET /api/sessions',
        'GET /api/deliveries',
        'GET /api/control-plane',
        'GET /api/control-plane/clients',
        'GET /api/control-plane/events?domains=session,tasks',
        'GET /api/control-plane/web',
        'GET /api/routes',
        'GET /api/routes/bindings',
        'POST /api/routes/bindings',
        'GET /api/surfaces',
        'GET /api/channels/accounts',
        'GET /api/channels/accounts/:surface',
        'GET /api/channels/accounts/:surface/:accountId',
        'POST /api/channels/accounts/:surface/actions/:action',
        'POST /api/channels/accounts/:surface/:accountId/actions/:action',
        'GET /api/channels/capabilities',
        'GET /api/channels/capabilities/:surface',
        'GET /api/channels/tools',
        'GET /api/channels/tools/:surface',
        'GET /api/channels/agent-tools',
        'GET /api/channels/agent-tools/:surface',
        'POST /api/channels/tools/:surface/:toolId',
        'GET /api/channels/actions',
        'GET /api/channels/actions/:surface',
        'POST /api/channels/actions/:surface/:actionId',
        'POST /api/channels/targets/:surface/resolve',
        'POST /api/channels/authorize/:surface',
        'GET /api/watchers',
        'GET /api/service/status',
        'POST /api/service/install',
        'POST /api/service/uninstall',
        'GET /api/approvals',
        'GET /api/remote',
        'GET /api/health',
        'GET /api/accounts',
        'GET /api/providers',
        'GET /api/providers/:providerId',
        'GET /api/providers/:providerId/usage',
        'GET /api/settings',
        'GET /api/local-auth',
        'GET /api/continuity',
        'GET /api/worktrees',
        'GET /api/intelligence',
        'GET /api/panels',
        'POST /api/panels/open',
        'GET /api/events?domains=session,tasks',
      ],
      sessions: state.session.id ? 1 : 0,
      tasks: state.tasks.tasks.size,
      pendingApprovals: state.permissions.awaitingDecision ? 1 : 0,
      remoteContracts: this.context.remoteRunnerRegistry.listContracts().length,
      panels: panelSnapshots.length,
    };
  }

  getSessionSnapshot(): Record<string, unknown> {
    const state = this.context.runtimeStore.getState();
    return {
      id: state.session.id,
      title: this.context.getConversationTitle?.() ?? '',
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

  getTaskSnapshot(): Record<string, unknown> {
    const state = this.context.runtimeStore.getState();
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

  getAutomationSnapshot(): Record<string, unknown> {
    const jobs = this.context.automationManager.listJobs();
    const runs = this.context.automationManager.listRuns().slice(0, 50);
    return {
      totals: {
        jobs: jobs.length,
        enabled: jobs.filter((job) => job.enabled).length,
        paused: jobs.filter((job) => !job.enabled).length,
        runs: runs.length,
      },
      jobs: jobs.map((job) => ({
        id: job.id,
        name: job.name,
        enabled: job.enabled,
        status: job.status,
        schedule: job.schedule,
        nextRunAt: job.nextRunAt,
        lastRunAt: job.lastRunAt,
        runCount: job.runCount,
        failureCount: job.failureCount,
      })),
      recentRuns: runs.map((run) => ({
        id: run.id,
        jobId: run.jobId,
        status: run.status,
        trigger: run.triggeredBy.kind,
        queuedAt: run.queuedAt,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        agentId: run.agentId,
        error: run.error,
      })),
    };
  }

  getRouteSnapshot(): Record<string, unknown> {
    const state = this.context.runtimeStore.getState();
    return {
      totalBindings: state.routes.bindingIds.length,
      activeBindings: state.routes.activeBindingIds.length,
      recentBindings: state.routes.recentBindingIds.length,
      bindings: [...state.routes.bindings.values()].map((binding) => ({
        id: binding.id,
        kind: binding.kind,
        surfaceKind: binding.surfaceKind,
        surfaceId: binding.surfaceId,
        externalId: binding.externalId,
        threadId: binding.threadId,
        channelId: binding.channelId,
        sessionId: binding.sessionId,
        jobId: binding.jobId,
        runId: binding.runId,
        lastSeenAt: binding.lastSeenAt,
      })),
    };
  }

  getApprovalSnapshot(): Record<string, unknown> {
    const state = this.context.runtimeStore.getState();
    const approvals = this.context.approvalBroker.listApprovals(50);
    return {
      awaitingDecision: state.permissions.awaitingDecision,
      mode: state.permissions.mode,
      lastDecision: state.permissions.lastDecision,
      approvalCount: state.permissions.approvalCount,
      denialCount: state.permissions.denialCount,
      cachedChecks: state.permissions.cachedChecks,
      totalChecks: state.permissions.totalChecks,
      approvals,
    };
  }

  getSessionBrokerSnapshot(): Record<string, unknown> {
    const sessions = this.context.sessionBroker.listSessions(50);
    return {
      totals: {
        sessions: sessions.length,
        active: sessions.filter((session) => session.status === 'active').length,
        closed: sessions.filter((session) => session.status === 'closed').length,
      },
      sessions,
    };
  }

  getDeliverySnapshot(): Record<string, unknown> {
    const state = this.context.runtimeStore.getState();
    const attempts = [...state.deliveries.deliveryAttempts.values()]
      .sort((a, b) => (b.startedAt ?? b.endedAt ?? 0) - (a.startedAt ?? a.endedAt ?? 0))
      .slice(0, 100);
    return {
      totals: {
        queued: state.deliveries.totalQueued,
        started: state.deliveries.totalStarted,
        succeeded: state.deliveries.totalSucceeded,
        failed: state.deliveries.totalFailed,
        deadLettered: state.deliveries.totalDeadLettered,
      },
      attempts,
    };
  }

  getRemoteSnapshot(): Record<string, unknown> {
    const state = this.context.runtimeStore.getState();
    const remoteRegistry = this.context.remoteRunnerRegistry;
    const supervisor = this.context.remoteSupervisor.getSnapshot(this.context.runtimeStore);
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
      distributed: this.context.distributedRuntime.getSnapshot(),
    };
  }

  getHealthSnapshot(): Record<string, unknown> {
    const state = this.context.runtimeStore.getState();
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
      ...(this.context.configManager ? {
        network: {
          controlPlane: inspectInboundTls(this.context.configManager, 'controlPlane'),
          httpListener: inspectInboundTls(this.context.configManager, 'httpListener'),
          outbound: inspectOutboundTls(this.context.configManager),
        },
      } : {}),
    };
  }

  async getAccountsSnapshot(): Promise<Record<string, unknown>> {
    const snapshot = await buildProviderAccountSnapshot({
      providerRegistry: this.context.providerRegistry,
      serviceRegistry: this.context.serviceRegistry,
      subscriptionManager: this.context.subscriptionManager,
      secretsManager: this.context.secretsManager,
    });
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

  getSettingsSnapshot(): Record<string, unknown> {
    if (!this.context.configManager) {
      return { available: false, reason: 'configManager unavailable' };
    }
    const snapshot = getSettingsControlPlaneSnapshot(this.context.configManager);
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

  getLocalAuthSnapshot(): Record<string, unknown> {
    const snapshot = this.context.localUserAuthManager.inspect();
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

  getContinuitySnapshot(): Record<string, unknown> {
    const state = this.context.runtimeStore.getState();
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

  getWorktreeSnapshot(): Record<string, unknown> {
    const records = listPersistedWorktreeMeta();
    return {
      summary: summarizeWorktreeOwnership(records),
      records,
    };
  }

  getIntelligenceSnapshot(): Record<string, unknown> {
    const intelligence = this.context.runtimeStore.getState().intelligence;
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

  listPanels(): PanelSnapshot[] {
    const manager = this.context.panelManager;
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

  openPanel(id: string, pane?: 'top' | 'bottom'): boolean {
    const manager = this.context.panelManager;
    const known = manager.getRegisteredTypes().some((registration) => registration.id === id);
    if (!known) return false;
    manager.open(id, pane);
    manager.show();
    return true;
  }

  createEventStream(request: Request, domains: readonly RuntimeEventDomain[]): Response {
    const selectedDomains = domains.length > 0 ? domains : EVENT_DOMAINS;
    const encoder = new TextEncoder();
    let teardown = (): void => {};

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const unsubs = selectedDomains.map((domain) => this.context.runtimeBus.onDomain(domain, (envelope) => {
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
      cancel: () => {
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
}
