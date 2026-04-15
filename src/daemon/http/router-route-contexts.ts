import type { ConfigManager } from '../../config/manager.ts';
import type { ChannelPluginRegistry, ChannelPolicyManager, RouteBindingManager, SurfaceRegistry } from '../../channels/index.ts';
import type { KnowledgeGraphqlService, KnowledgeService } from '../../knowledge/index.ts';
import type { ArtifactStore } from '@pellux/goodvibes-sdk/platform/artifacts/index';
import type { MediaProviderRegistry } from '../../media/index.ts';
import type { MultimodalService } from '../../multimodal/index.ts';
import type { VoiceService } from '@pellux/goodvibes-sdk/platform/voice/index';
import type { WebSearchService } from '../../web-search/index.ts';
import type { IntegrationHelperService } from '../../runtime/integration/helpers.ts';
import type { ApprovalBroker } from '../../control-plane/index.ts';
import type { PlatformServiceManager } from '../service-manager.ts';
import type { JsonRecord } from '../helpers.ts';
import type { WatcherRegistry } from '../../watchers/index.ts';
import type { DaemonChannelRouteContext } from '@pellux/goodvibes-sdk/platform/daemon/http/channel-route-types';
import type { DaemonIntegrationRouteContext } from '@pellux/goodvibes-sdk/platform/daemon/http/integration-route-types';
import type { DaemonKnowledgeRouteContext } from '@pellux/goodvibes-sdk/platform/daemon/http/knowledge-route-types';
import type { DaemonMediaRouteContext } from '@pellux/goodvibes-sdk/platform/daemon/http/media-route-types';
import type { DaemonSystemRouteContext, WatcherRecord } from '@pellux/goodvibes-sdk/platform/daemon/http/system-route-types';

export function buildChannelRouteContext(input: {
  readonly channelPlugins: ChannelPluginRegistry;
  readonly channelPolicy: ChannelPolicyManager;
  readonly parseJsonBody: (request: Request) => Promise<JsonRecord | Response>;
  readonly parseOptionalJsonBody: (request: Request) => Promise<JsonRecord | null | Response>;
  readonly requireAdmin: (request: Request) => Response | null;
  readonly surfaceRegistry: SurfaceRegistry;
}): DaemonChannelRouteContext {
  return {
    channelPlugins: {
      listAccounts: (surface) => input.channelPlugins.listAccounts(
        surface as Parameters<ChannelPluginRegistry['listAccounts']>[0],
      ),
      getAccount: (surface, accountId) => input.channelPlugins.getAccount(
        surface as Parameters<ChannelPluginRegistry['getAccount']>[0],
        accountId,
      ),
      getSetupSchema: (surface, accountId) => input.channelPlugins.getSetupSchema(
        surface as Parameters<ChannelPluginRegistry['getSetupSchema']>[0],
        accountId,
      ),
      doctor: (surface, accountId) => input.channelPlugins.doctor(
        surface as Parameters<ChannelPluginRegistry['doctor']>[0],
        accountId,
      ),
      listRepairActions: (surface, accountId) => input.channelPlugins.listRepairActions(
        surface as Parameters<ChannelPluginRegistry['listRepairActions']>[0],
        accountId,
      ),
      getLifecycleState: (surface, accountId) => input.channelPlugins.getLifecycleState(
        surface as Parameters<ChannelPluginRegistry['getLifecycleState']>[0],
        accountId,
      ),
      migrateLifecycle: (surface, accountId, body) => input.channelPlugins.migrateLifecycle(
        surface as Parameters<ChannelPluginRegistry['migrateLifecycle']>[0],
        accountId,
        body as Parameters<ChannelPluginRegistry['migrateLifecycle']>[2],
      ),
      runAccountAction: (surface, action, accountId, body) => input.channelPlugins.runAccountAction(
        surface as Parameters<ChannelPluginRegistry['runAccountAction']>[0],
        action as Parameters<ChannelPluginRegistry['runAccountAction']>[1],
        accountId,
        body as Parameters<ChannelPluginRegistry['runAccountAction']>[3],
      ),
      listCapabilities: (surface) => input.channelPlugins.listCapabilities(
        surface as Parameters<ChannelPluginRegistry['listCapabilities']>[0],
      ),
      listTools: (surface) => input.channelPlugins.listTools(
        surface as Parameters<ChannelPluginRegistry['listTools']>[0],
      ),
      listAgentTools: (surface) => input.channelPlugins.listAgentTools(
        surface as Parameters<ChannelPluginRegistry['listAgentTools']>[0],
      ),
      runTool: (surface, toolId, body) => input.channelPlugins.runTool(
        surface as Parameters<ChannelPluginRegistry['runTool']>[0],
        toolId,
        body as Parameters<ChannelPluginRegistry['runTool']>[2],
      ),
      listOperatorActions: (surface) => input.channelPlugins.listOperatorActions(
        surface as Parameters<ChannelPluginRegistry['listOperatorActions']>[0],
      ),
      runOperatorAction: (surface, actionId, body) => input.channelPlugins.runOperatorAction(
        surface as Parameters<ChannelPluginRegistry['runOperatorAction']>[0],
        actionId,
        body as Parameters<ChannelPluginRegistry['runOperatorAction']>[2],
      ),
      resolveTarget: (surface, target) => input.channelPlugins.resolveTarget(
        surface as Parameters<ChannelPluginRegistry['resolveTarget']>[0],
        target as Parameters<ChannelPluginRegistry['resolveTarget']>[1],
      ),
      authorizeActorAction: (surface, authz) => input.channelPlugins.authorizeActorAction(
        surface as Parameters<ChannelPluginRegistry['authorizeActorAction']>[0],
        authz as Parameters<ChannelPluginRegistry['authorizeActorAction']>[1],
      ),
      resolveAllowlist: (surface, allowlist) => input.channelPlugins.resolveAllowlist(
        surface as Parameters<ChannelPluginRegistry['resolveAllowlist']>[0],
        allowlist as Parameters<ChannelPluginRegistry['resolveAllowlist']>[1],
      ),
      editAllowlist: (surface, allowlist) => input.channelPlugins.editAllowlist(
        surface as Parameters<ChannelPluginRegistry['editAllowlist']>[0],
        allowlist as Parameters<ChannelPluginRegistry['editAllowlist']>[1],
      ),
      listStatus: () => input.channelPlugins.listStatus(),
      queryDirectory: (surface, query) => input.channelPlugins.queryDirectory(
        surface as Parameters<ChannelPluginRegistry['queryDirectory']>[0],
        query as Parameters<ChannelPluginRegistry['queryDirectory']>[1],
      ),
    },
    channelPolicy: {
      listPolicies: () => input.channelPolicy.listPolicies(),
      upsertPolicy: (surface, policy) => input.channelPolicy.upsertPolicy(
        surface as Parameters<ChannelPolicyManager['upsertPolicy']>[0],
        policy as Parameters<ChannelPolicyManager['upsertPolicy']>[1],
      ),
      listAudit: (limit) => input.channelPolicy.listAudit(limit),
    },
    parseJsonBody: input.parseJsonBody,
    parseOptionalJsonBody: input.parseOptionalJsonBody,
    requireAdmin: input.requireAdmin,
    surfaceRegistry: input.surfaceRegistry,
  };
}

export function buildSystemRouteContext(input: {
  readonly approvalBroker: ApprovalBroker;
  readonly configManager: ConfigManager;
  readonly integrationHelpers: IntegrationHelperService | null;
  readonly inspectInboundTls: (surface: 'controlPlane' | 'httpListener') => unknown;
  readonly inspectOutboundTls: () => unknown;
  readonly isValidConfigKey: (key: string) => boolean;
  readonly parseJsonBody: (request: Request) => Promise<JsonRecord | Response>;
  readonly parseOptionalJsonBody: (request: Request) => Promise<JsonRecord | null | Response>;
  readonly platformServiceManager: PlatformServiceManager;
  readonly recordApiResponse: (
    request: Request,
    path: string,
    response: Response,
    clientKind?: DaemonSystemRouteContext['recordApiResponse'] extends (
      req: Request,
      path: string,
      response: Response,
      clientKind?: infer T,
    ) => Response
      ? T
      : never,
  ) => Response;
  readonly requireAdmin: (request: Request) => Response | null;
  readonly requireAuthenticatedSession: (request: Request) => { username: string; roles: readonly string[] } | null;
  readonly routeBindings: RouteBindingManager;
  readonly watcherRegistry: WatcherRegistry;
}): DaemonSystemRouteContext {
  const castWatcherRecord = (value: unknown): WatcherRecord | null => value as WatcherRecord | null;

  return {
    approvalBroker: input.approvalBroker,
    configManager: input.configManager,
    integrationHelpers: input.integrationHelpers,
    inspectInboundTls: input.inspectInboundTls,
    inspectOutboundTls: input.inspectOutboundTls,
    isValidConfigKey: input.isValidConfigKey,
    parseJsonBody: input.parseJsonBody,
    parseOptionalJsonBody: input.parseOptionalJsonBody,
    platformServiceManager: {
      status: () => input.platformServiceManager.status() as unknown as Record<string, unknown>,
      install: () => input.platformServiceManager.install(),
      start: () => input.platformServiceManager.start(),
      stop: () => input.platformServiceManager.stop(),
      restart: () => input.platformServiceManager.restart(),
      uninstall: () => input.platformServiceManager.uninstall(),
    },
    recordApiResponse: input.recordApiResponse,
    requireAdmin: input.requireAdmin,
    requireAuthenticatedSession: input.requireAuthenticatedSession,
    routeBindings: {
      listBindings: () => input.routeBindings.listBindings(),
      upsertBinding: (binding) => input.routeBindings.upsertBinding(
        binding as Parameters<RouteBindingManager['upsertBinding']>[0],
      ),
      patchBinding: (bindingId, patch) => input.routeBindings.patchBinding(
        bindingId,
        patch as Parameters<RouteBindingManager['patchBinding']>[1],
      ),
      removeBinding: (bindingId) => input.routeBindings.removeBinding(bindingId),
    },
    watcherRegistry: {
      list: () => input.watcherRegistry.list(),
      removeWatcher: (watcherId) => input.watcherRegistry.removeWatcher(watcherId),
      registerWatcher: (watcher) => input.watcherRegistry.registerWatcher(
        watcher as Parameters<WatcherRegistry['registerWatcher']>[0],
      ) as WatcherRecord,
      getWatcher: (watcherId) => castWatcherRecord(input.watcherRegistry.getWatcher(watcherId)),
      startWatcher: (watcherId) => castWatcherRecord(input.watcherRegistry.startWatcher(watcherId)),
      stopWatcher: (watcherId, reason) => castWatcherRecord(input.watcherRegistry.stopWatcher(watcherId, reason)),
      runWatcherNow: async (watcherId) => castWatcherRecord(await input.watcherRegistry.runWatcherNow(watcherId)),
    },
  };
}

export function buildKnowledgeRouteContext(input: {
  readonly configManager: ConfigManager;
  readonly inspectGraphqlAccess: DaemonKnowledgeRouteContext['inspectGraphqlAccess'];
  readonly normalizeAtSchedule: DaemonKnowledgeRouteContext['normalizeAtSchedule'];
  readonly normalizeEverySchedule: DaemonKnowledgeRouteContext['normalizeEverySchedule'];
  readonly normalizeCronSchedule: DaemonKnowledgeRouteContext['normalizeCronSchedule'];
  readonly parseJsonBody: (request: Request) => Promise<JsonRecord | Response>;
  readonly parseOptionalJsonBody: (request: Request) => Promise<JsonRecord | null | Response>;
  readonly parseJsonText: (raw: string) => JsonRecord | Response;
  readonly requireAdmin: (request: Request) => Response | null;
  readonly resolveAuthenticatedPrincipal: (request: Request) => ReturnType<DaemonKnowledgeRouteContext['resolveAuthenticatedPrincipal']>;
  readonly knowledgeService: KnowledgeService;
  readonly knowledgeGraphqlService: KnowledgeGraphqlService;
}): DaemonKnowledgeRouteContext {
  return {
    configManager: input.configManager,
    inspectGraphqlAccess: input.inspectGraphqlAccess,
    normalizeAtSchedule: input.normalizeAtSchedule,
    normalizeEverySchedule: input.normalizeEverySchedule,
    normalizeCronSchedule: input.normalizeCronSchedule,
    parseJsonBody: input.parseJsonBody,
    parseOptionalJsonBody: input.parseOptionalJsonBody,
    parseJsonText: input.parseJsonText,
    requireAdmin: input.requireAdmin,
    resolveAuthenticatedPrincipal: input.resolveAuthenticatedPrincipal,
    knowledgeService: {
      getStatus: () => input.knowledgeService.getStatus(),
      listSources: (limit) => input.knowledgeService.listSources(limit),
      listNodes: (limit) => input.knowledgeService.listNodes(limit),
      listIssues: (limit) => input.knowledgeService.listIssues(limit),
      getItem: (id) => input.knowledgeService.getItem(id),
      listConnectors: () => input.knowledgeService.listConnectors(),
      getConnector: (id) => input.knowledgeService.getConnector(id),
      doctorConnector: (id) => input.knowledgeService.doctorConnector(id),
      listProjectionTargets: (limit) => input.knowledgeService.listProjectionTargets(limit),
      listExtractions: (limit, sourceId) => input.knowledgeService.listExtractions(limit, sourceId),
      listUsageRecords: (limit, filter) => input.knowledgeService.listUsageRecords(
        limit,
        filter as Parameters<KnowledgeService['listUsageRecords']>[1],
      ),
      listConsolidationCandidates: (limit, filter) => input.knowledgeService.listConsolidationCandidates(
        limit,
        filter as Parameters<KnowledgeService['listConsolidationCandidates']>[1],
      ),
      getConsolidationCandidate: (id) => input.knowledgeService.getConsolidationCandidate(id),
      listConsolidationReports: (limit) => input.knowledgeService.listConsolidationReports(limit),
      getConsolidationReport: (id) => input.knowledgeService.getConsolidationReport(id),
      getExtraction: (id) => input.knowledgeService.getExtraction(id),
      getSourceExtraction: (id) => input.knowledgeService.getSourceExtraction(id),
      listJobs: () => input.knowledgeService.listJobs(),
      getJob: (jobId) => input.knowledgeService.getJob(jobId),
      listJobRuns: (limit, jobId) => input.knowledgeService.listJobRuns(limit, jobId),
      listSchedules: (limit) => input.knowledgeService.listSchedules(limit),
      getSchedule: (id) => input.knowledgeService.getSchedule(id),
      ingestUrl: (body) => input.knowledgeService.ingestUrl(
        body as Parameters<KnowledgeService['ingestUrl']>[0],
      ),
      ingestArtifact: (body) => input.knowledgeService.ingestArtifact(
        body as Parameters<KnowledgeService['ingestArtifact']>[0],
      ),
      importBookmarksFromFile: (body) => input.knowledgeService.importBookmarksFromFile(
        body as Parameters<KnowledgeService['importBookmarksFromFile']>[0],
      ),
      importUrlsFromFile: (body) => input.knowledgeService.importUrlsFromFile(
        body as Parameters<KnowledgeService['importUrlsFromFile']>[0],
      ),
      ingestConnectorInput: (body) => input.knowledgeService.ingestConnectorInput(
        body as Parameters<KnowledgeService['ingestConnectorInput']>[0],
      ),
      search: (query, limit) => input.knowledgeService.search(query, limit),
      buildPacket: (task, writeScope, limit, options) => input.knowledgeService.buildPacket(
        task,
        writeScope,
        limit,
        options as Parameters<KnowledgeService['buildPacket']>[3],
      ),
      decideConsolidationCandidate: (id, decision, body) => input.knowledgeService.decideConsolidationCandidate(
        id,
        decision,
        body as Parameters<KnowledgeService['decideConsolidationCandidate']>[2],
      ),
      runJob: (jobId, body) => input.knowledgeService.runJob(
        jobId,
        body as Parameters<KnowledgeService['runJob']>[1],
      ),
      lint: () => input.knowledgeService.lint(),
      reindex: () => input.knowledgeService.reindex(),
      saveSchedule: (schedule) => input.knowledgeService.saveSchedule(
        schedule as Parameters<KnowledgeService['saveSchedule']>[0],
      ),
      deleteSchedule: (id) => input.knowledgeService.deleteSchedule(id),
      setScheduleEnabled: (id, enabled) => input.knowledgeService.setScheduleEnabled(id, enabled),
      renderProjection: (projection) => input.knowledgeService.renderProjection(
        projection as Parameters<KnowledgeService['renderProjection']>[0],
      ),
      materializeProjection: (projection) => input.knowledgeService.materializeProjection(
        projection as Parameters<KnowledgeService['materializeProjection']>[0],
      ),
    },
    knowledgeGraphqlService: input.knowledgeGraphqlService,
  };
}

export function buildMediaRouteContext(input: {
  readonly artifactStore: ArtifactStore;
  readonly configManager: ConfigManager;
  readonly mediaProviders: MediaProviderRegistry;
  readonly multimodalService: MultimodalService;
  readonly parseJsonBody: (request: Request) => Promise<JsonRecord | Response>;
  readonly requireAdmin: (request: Request) => Response | null;
  readonly voiceService: VoiceService;
  readonly webSearchService: WebSearchService;
}): DaemonMediaRouteContext {
  return {
    artifactStore: input.artifactStore,
    configManager: input.configManager,
    mediaProviders: {
      status: () => input.mediaProviders.status(),
      findProvider: (capability, providerId) => input.mediaProviders.findProvider(
        capability,
        providerId,
      ) as {
        analyze?: (body: Record<string, unknown>) => Promise<unknown>;
        transform?: (body: Record<string, unknown>) => Promise<unknown>;
        generate?: (body: Record<string, unknown>) => Promise<unknown>;
      } | null,
    },
    multimodalService: {
      getStatus: () => input.multimodalService.getStatus(),
      listProviders: () => input.multimodalService.listProviders(),
      analyze: (body) => input.multimodalService.analyze(
        body as Parameters<MultimodalService['analyze']>[0],
      ),
      buildPacket: (analysis, detail, budgetLimit) => input.multimodalService.buildPacket(
        analysis as Parameters<MultimodalService['buildPacket']>[0],
        detail as Parameters<MultimodalService['buildPacket']>[1],
        budgetLimit,
      ),
      writeBackAnalysis: (analysis, body) => input.multimodalService.writeBackAnalysis(
        analysis as Parameters<MultimodalService['writeBackAnalysis']>[0],
        body as Parameters<MultimodalService['writeBackAnalysis']>[1],
      ),
    },
    parseJsonBody: input.parseJsonBody,
    requireAdmin: input.requireAdmin,
    voiceService: {
      getStatus: (enabled) => input.voiceService.getStatus(enabled),
      listVoices: (providerId) => input.voiceService.listVoices(providerId),
      synthesize: (providerId, body) => input.voiceService.synthesize(
        providerId,
        body as unknown as Parameters<VoiceService['synthesize']>[1],
      ),
      transcribe: (providerId, body) => input.voiceService.transcribe(
        providerId,
        body as unknown as Parameters<VoiceService['transcribe']>[1],
      ),
      openRealtimeSession: (providerId, body) => input.voiceService.openRealtimeSession(
        providerId,
        body as unknown as Parameters<VoiceService['openRealtimeSession']>[1],
      ),
    },
    webSearchService: {
      getStatus: () => input.webSearchService.getStatus(),
      search: (body) => input.webSearchService.search(
        body as unknown as Parameters<WebSearchService['search']>[0],
      ),
    },
  };
}

export function buildIntegrationRouteContext(input: DaemonIntegrationRouteContext): DaemonIntegrationRouteContext {
  return input;
}
