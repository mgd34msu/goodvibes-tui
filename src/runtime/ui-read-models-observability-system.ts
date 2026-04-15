import { buildEcosystemRecommendations, type EcosystemRecommendation } from './ecosystem/recommendations.ts';
import type { RuntimeServices } from './services.ts';
import type { UiReadModel } from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-base';
import { combineSubscriptions, createStoreBackedReadModel } from './ui-read-model-helpers.ts';
import type {
  ContinuitySnapshot as IntegrationContinuitySnapshot,
  SettingsSnapshot as IntegrationSettingsSnapshot,
  WorktreeSnapshot as IntegrationWorktreeSnapshot,
} from './integration/helpers.ts';
import type { SessionReturnContextSummary } from './session-return-context.ts';
import type { ManagedWorktreeMeta } from './worktree/registry.ts';
import type { PluginStatus } from '../plugins/manager.ts';

export interface UiIntelligenceSnapshot {
  readonly diagnosticsStatus: string;
  readonly symbolSearchStatus: string;
  readonly completionsStatus: string;
  readonly hoverStatus: string;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly totalRequests: number;
  readonly avgLatencyMs: number;
  readonly hover: {
    readonly active: boolean;
    readonly filePath?: string;
  };
  readonly diagnostics: ReadonlyMap<string, readonly import('@pellux/goodvibes-sdk/platform/runtime/store/domains/intelligence').LspDiagnostic[]>;
}

export interface UiMarketplaceSnapshot {
  readonly startupIssues: readonly string[];
  readonly recommendations: readonly EcosystemRecommendation[];
}

export interface UiCockpitSnapshot {
  readonly runningTasks: number;
  readonly blockedTasks: number;
  readonly failedTasks: number;
  readonly activeGraphs: number;
  readonly guardTrips: number;
  readonly blockedMessages: number;
  readonly pendingPermissions: number;
  readonly deniedPermissions: number;
  readonly preflightStatus: string;
  readonly preflightIssueCount: number;
  readonly lintFindingCount: number;
  readonly tokenBlockedCount: number;
  readonly tokenRotationOverdueCount: number;
  readonly tokenScopeViolationCount: number;
  readonly tokenRotationWarningCount: number;
  readonly incidentCount: number;
  readonly latestIncident: ReturnType<import('./forensics/index.ts').ForensicsRegistry['latest']>;
  readonly elevatedMcp: number;
  readonly unhealthyMcp: number;
  readonly erroredPlugins: number;
  readonly failingIntegrations: number;
  readonly taskCount: number;
  readonly agentCount: number;
  readonly totalGraphs: number;
  readonly communicationCount: number;
  readonly mcpServerCount: number;
  readonly pluginCount: number;
}

export interface UiHealthSnapshot {
  readonly degradedDomains: readonly string[];
  readonly providerProblems: readonly string[];
  readonly degradedMcpServers: readonly string[];
  readonly quarantinedMcpServers: readonly string[];
  readonly integrationProblems: readonly string[];
  readonly daemonTransportState: string;
  readonly acpTransportState: string;
  readonly recoveryState: string;
}

export interface UiSystemObservabilityReadModels {
  readonly intelligence: UiReadModel<UiIntelligenceSnapshot>;
  readonly marketplace: UiReadModel<UiMarketplaceSnapshot>;
  readonly cockpit: UiReadModel<UiCockpitSnapshot>;
  readonly health: UiReadModel<UiHealthSnapshot>;
}

export function createSystemObservabilityReadModels(
  runtimeServices: RuntimeServices,
  options: import('./ui-read-models-observability-options.ts').UiObservabilityReadModelOptions = {},
): UiSystemObservabilityReadModels {
  const { runtimeStore } = runtimeServices;

  return {
    intelligence: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState().intelligence;
      return {
        diagnosticsStatus: state.diagnosticsStatus,
        symbolSearchStatus: state.symbolSearchStatus,
        completionsStatus: state.completionsStatus,
        hoverStatus: state.hoverStatus,
        errorCount: state.errorCount,
        warningCount: state.warningCount,
        totalRequests: state.totalRequests,
        avgLatencyMs: state.avgLatencyMs,
        hover: {
          active: state.hover.active,
          filePath: state.hover.filePath,
        },
        diagnostics: state.diagnostics,
      };
    }),
    marketplace: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState();
      const startupIssues: string[] = [];
      if (state.permissions.denialCount >= 3) {
        startupIssues.push(`${state.permissions.denialCount} permission denials suggest a policy-pack or trust posture review.`);
      }
      const authRequiredServers = [...state.mcp.servers.values()].filter((server) => server.status === 'auth_required');
      if (authRequiredServers.length > 0) {
        startupIssues.push(`${authRequiredServers.length} MCP server${authRequiredServers.length === 1 ? '' : 's'} need auth or reconnect repair.`);
      }
      const staleSchemas = [...state.mcp.servers.values()].filter((server) => server.schemaFreshness !== 'fresh');
      if (staleSchemas.length > 0) {
        startupIssues.push(`${staleSchemas.length} MCP server schema${staleSchemas.length === 1 ? ' is' : 's are'} stale or quarantined.`);
      }
      return {
        startupIssues,
        recommendations: buildEcosystemRecommendations(runtimeStore, {
          cwd: runtimeServices.shellPaths.workingDirectory,
          homeDir: runtimeServices.shellPaths.homeDirectory,
        }),
      };
    }),
    cockpit: {
      getSnapshot() {
        const state = runtimeStore.getState();
        const runningTasks = [...state.tasks.tasks.values()].filter((task) => task.status === 'running').length;
        const blockedTasks = [...state.tasks.tasks.values()].filter((task) => task.status === 'blocked').length;
        const failedTasks = [...state.tasks.tasks.values()].filter((task) => task.status === 'failed').length;
        const audit = runtimeServices.tokenAuditor.auditAll();
        const incidents = options.forensicsRegistry?.getAll() ?? [];
        const plugins = runtimeServices.pluginManager.list();
        const failingIntegrations = [...state.integrations.integrations.values()].filter((record) => record.status === 'error').length;
        const elevatedMcp = [...state.mcp.servers.values()].filter((server) => server.trustMode === 'allow-all').length;
        const unhealthyMcp = [...state.mcp.servers.values()].filter((server) => (
          server.status === 'degraded'
          || server.status === 'auth_required'
          || server.status === 'reconnecting'
          || server.status === 'disconnected'
        )).length;
        const preflight = runtimeServices.policyRuntimeState.getSnapshot().lastPreflightReview;
        const lintFindingCount = runtimeServices.policyRuntimeState.getSnapshot().lintFindings.length;
        return {
          runningTasks,
          blockedTasks,
          failedTasks,
          activeGraphs: state.orchestration.activeGraphIds.length,
          guardTrips: state.orchestration.recursionGuardTrips,
          blockedMessages: state.communication.totalBlocked,
          pendingPermissions: state.permissions.awaitingDecision ? 1 : 0,
          deniedPermissions: state.permissions.denialCount,
          preflightStatus: preflight?.status ?? 'n/a',
          preflightIssueCount: preflight?.issueCount ?? 0,
          lintFindingCount,
          tokenBlockedCount: audit.blocked.length,
          tokenRotationOverdueCount: audit.rotationOverdue.length,
          tokenScopeViolationCount: audit.scopeViolations.length,
          tokenRotationWarningCount: audit.rotationWarnings.length,
          incidentCount: incidents.length,
          latestIncident: options.forensicsRegistry?.latest(),
          elevatedMcp,
          unhealthyMcp,
          erroredPlugins: plugins.filter((plugin) => plugin.quarantined || !plugin.active).length,
          failingIntegrations,
          taskCount: state.tasks.tasks.size,
          agentCount: state.agents.agents.size,
          totalGraphs: state.orchestration.totalGraphs,
          communicationCount: state.communication.records.size,
          mcpServerCount: state.mcp.servers.size,
          pluginCount: plugins.length,
        };
      },
      subscribe(listener) {
        const unsubs: Array<() => void> = [runtimeStore.subscribe(listener)];
        if (options.forensicsRegistry) {
          unsubs.push(options.forensicsRegistry.subscribe(listener));
        }
        return combineSubscriptions(...unsubs);
      },
    },
    health: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState();
      const providerProblems = [...state.providerHealth.providers.values()]
        .filter((provider) => provider.status !== 'healthy' && provider.status !== 'unknown')
        .map((provider) => provider.providerId);
      const degradedMcpServers = [...state.mcp.servers.values()]
        .filter((server) => server.status === 'degraded' || server.status === 'auth_required' || server.schemaFreshness === 'quarantined')
        .map((server) => server.name);
      const quarantinedMcpServers = [...state.mcp.servers.values()]
        .filter((server) => server.schemaFreshness === 'quarantined')
        .map((server) => server.name);
      const degradedDomains: string[] = [];
      if (providerProblems.length > 0) degradedDomains.push('providerHealth');
      if (degradedMcpServers.length > 0) degradedDomains.push('mcp');
      if (state.integrations.problemIds.length > 0) degradedDomains.push('integrations');
      if (state.daemon.transportState === 'degraded' || state.daemon.transportState === 'terminal_failure') degradedDomains.push('daemon');
      if (state.acp.managerTransportState === 'degraded' || state.acp.managerTransportState === 'terminal_failure') degradedDomains.push('acp');
      if (state.session.recoveryState === 'failed') degradedDomains.push('session');
      return {
        degradedDomains,
        providerProblems,
        degradedMcpServers,
        quarantinedMcpServers,
        integrationProblems: state.integrations.problemIds,
        daemonTransportState: state.daemon.transportState,
        acpTransportState: state.acp.managerTransportState,
        recoveryState: state.session.recoveryState,
      };
    }),
  };
}
