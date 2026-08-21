/**
 * runtime-services-types.ts, the public contract createRuntimeServices() takes
 * and returns.
 *
 * Split out of services.ts (the composition root that builds every one of
 * these fields) so the construction logic can stay under the repo's
 * architecture line-count gate without trimming 35 arbitrary lines to clear
 * the number. This module owns ONLY the shape of the input options and the
 * output surface, no runtime code, no wiring order, nothing that constructs
 * anything. services.ts re-exports both types from here, so no import site
 * anywhere else in the app had to change.
 */

import type { FocusTracker } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import type { ApprovalBroker, GatewayMethodCatalog, SessionLiveTurnControlsHolder, SharedSessionBroker } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { StepUpService } from '@pellux/goodvibes-sdk/daemon';
import type { PairingTokenManager } from '@pellux/goodvibes-sdk/platform/pairing';
import type {
  ConversationRewindHostClient,
  DaemonConfigClient,
  DaemonCredentialsClient,
  DaemonVerbCaller,
  DevicesClient,
  WireSessionDispatch,
} from '@pellux/goodvibes-sdk/platform/runtime/client';
import type { ClientBuildGuard } from './client/build-floors.ts';
import type { FleetUnionReadModel } from './client/fleet-union.ts';
import type { ApprovalRaiser } from '@pellux/goodvibes-sdk/platform/runtime/client-services';
import type { PermissionPromptDecision, PermissionPromptRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import type { ConfigManager, ServiceRegistry, SubscriptionManager, ToolLLM } from '@pellux/goodvibes-sdk/platform/config';
import type { SecretsManager } from '../config/secrets.ts';
import type { AutomationDeliveryManager, AutomationManager } from '@pellux/goodvibes-sdk/platform/automation';
import type { ChannelDeliveryRouter, ChannelPolicyManager, ChannelPluginRegistry, RouteBindingManager, SurfaceRegistry } from '@pellux/goodvibes-sdk/platform/channels';
import type { PowerManager } from '@pellux/goodvibes-sdk/platform/power';
import type { wireIdlePowerAndLiveTurn } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import type { WatcherRegistry } from '@pellux/goodvibes-sdk/platform/watchers';
import type { ArtifactStore } from '@pellux/goodvibes-sdk/platform/artifacts';
import type { HomeGraphService, KnowledgeService, ProjectPlanningService } from '@pellux/goodvibes-sdk/platform/knowledge';
import type { MediaProviderRegistry } from '@pellux/goodvibes-sdk/platform/media';
import type { MultimodalService } from '@pellux/goodvibes-sdk/platform/multimodal';
import type { AgentMessageBus, AgentOrchestrator, ArchetypeLoader, WrfcController } from '@pellux/goodvibes-sdk/platform/agents';
import type { AgentManager, ContextAccountingHolder, OverflowHandler, ProcessManager, WorkflowServices } from '@pellux/goodvibes-sdk/platform/tools';
import type { FileUndoManager, MemoryConsolidationScheduler, MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore, ModeManager, ProjectIndex, CodeIndexStore, CodeIndexReindexScheduler } from '@pellux/goodvibes-sdk/platform/state';
import type { StoreSnapshotScheduler } from '@pellux/goodvibes-sdk/platform/state/store-snapshots';
import type { UserPermissionRuleStore } from '@pellux/goodvibes-sdk/platform/permissions';
import type { buildExecPromptAnswerHandler } from '@pellux/goodvibes-sdk/platform/runtime/permissions/exec-prompt-wiring';
import type { buildLocalhostFetchApproval } from '@pellux/goodvibes-sdk/platform/runtime/permissions/localhost-fetch-approval';
import type { NotificationDispatcher } from './notification-dispatch.ts';
import type { createDurabilityServices } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import type { MemorySpineClient } from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';
import type { WorkspaceCheckpointManager } from '@pellux/goodvibes-sdk/platform/workspace';
import type { DomainDispatch, RuntimeStore } from './store/index.ts';
import type { RuntimeEventBus, DistributedRuntimeManager, RemoteRunnerRegistry, RemoteSupervisor, IntegrationHelperService, IdempotencyStore, ComponentHealthMonitor, WorktreeRegistry, SandboxSessionRegistry, ShellPathService, FeatureFlagManager, PolicyRuntimeState, SessionSurface } from '@/runtime/index.ts';
import type { VoiceProviderRegistry, VoiceService } from '@pellux/goodvibes-sdk/platform/voice';
import type { CacheRegistry, PauseController, MemoryGovernor } from '@pellux/goodvibes-sdk/platform/runtime/memory';
import type { WebSearchProviderRegistry, WebSearchService } from '@pellux/goodvibes-sdk/platform/web-search';
import type { PanelManager } from '../panels/panel-manager.ts';
import type { HookActivityTracker } from '@pellux/goodvibes-sdk/platform/hooks';
import type { HookDispatcher, HookWorkbench } from '@pellux/goodvibes-sdk/platform/hooks';
import type { PluginManager } from '@pellux/goodvibes-sdk/platform/plugins';
import type { BookmarkManager } from '@pellux/goodvibes-sdk/platform/bookmarks';
import type { ProfileManager } from '@pellux/goodvibes-sdk/platform/profiles';
import type { SessionManager, CrossSessionTaskRegistry, SessionChangeTracker } from '@pellux/goodvibes-sdk/platform/sessions';
import type { ApiTokenAuditor, UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import type { WebhookNotifier } from '@pellux/goodvibes-sdk/platform/integrations';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import type { BenchmarkStore, CacheHitTracker, FavoritesStore, ModelLimitsService, ProviderCapabilityRegistry, ProviderOptimizer, ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { KeybindingsManager } from '../input/keybindings.ts';
import type { AdaptivePlanner, DeterministicReplayEngine, ExecutionPlanManager, SessionLineageTracker, SessionMemoryStore } from '@pellux/goodvibes-sdk/platform/core';
import type { ArchivableProcessRegistry } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import type { OrchestrationEngine, WorkstreamCommandService } from '@pellux/goodvibes-sdk/platform/orchestration';
import type { WorkPlanStore } from '@pellux/goodvibes-sdk/platform/workflow';
import type { WorkspaceTrustManager } from '@pellux/goodvibes-sdk/platform/runtime/operations';

export interface RuntimeServicesOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly configManager: ConfigManager;
  readonly localUserAuthManager?: UserAuthManager;
  readonly featureFlags?: FeatureFlagManager;
  readonly getConversationTitle?: () => string | undefined;
  readonly workingDir: string;
  readonly homeDirectory: string;
  /**
   * The daemon's state root when the host was told one (`--daemon-home`,
   * `GOODVIBES_DAEMON_HOME`); absent ⇒ `<homeDirectory>/.goodvibes/daemon`.
   * Threaded into `SecretsManager` so the override MOVES the daemon-scoped
   * credential store; without it a daemon told to run out of a temp tree still
   * read the real home's daemon secrets, so an "isolated" test daemon held the
   * owner's live credentials. One name for one thing, `resolveGoodVibesHomeOwnership`
   * is the single reader that produces it.
   */
  readonly daemonHomeDirectory?: string | undefined;
  /** Host power seam opt-in. Fork mirrors the SDK: non-spawning unavailable-seam
   * default (idle-power-services.ts); this product always passes createHostPowerSeam(), since it never has a co-located daemon to own its own inhibitor. */
  readonly powerSeam?: Parameters<typeof wireIdlePowerAndLiveTurn>[0]['powerSeam'];
  /** Live session id, read per crash-residue sweep so the running session is exempt, see durability-services.ts. */
  readonly currentSessionId?: (() => string | null) | undefined;
  /**
   * Wake-word boot provisioning opt-in. Same shape as `powerSeam`: the real
   * entrypoints (daemon/cli.ts, bootstrap-core.ts) ask for it, the one-shot CLI
   * commands do not, and a test composing this graph gets neither a network fetch
   * nor an hourly sweep it did not ask for. See voice-setup-services.ts.
   */
  readonly provisionWakeModelsAtBoot?: boolean | undefined;
}

export interface RuntimeServices {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  /** The surface segment this runtime's stores live under (platform runtime 2.0.8 requires it, a blank segment resolved to the unscoped control-plane orphan). */
  readonly surfaceRoot: string;
  /** The declare-once session-storage handle every session reader and writer threads through, see session-storage-services.ts. */
  readonly surface: SessionSurface;
  readonly shellPaths: ShellPathService;
  readonly configManager: ConfigManager;
  readonly featureFlags: FeatureFlagManager;
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly runtimeDispatch: DomainDispatch;
  readonly panelManager: PanelManager;
  readonly keybindingsManager: KeybindingsManager;
  readonly routeBindings: RouteBindingManager;
  readonly surfaceRegistry: SurfaceRegistry;
  readonly channelPlugins: ChannelPluginRegistry;
  /** The one router this surface delivers through, AutomationDeliveryManager's own, not a second copy of it. */
  readonly channelDeliveryRouter: ChannelDeliveryRouter;
  readonly watcherRegistry: WatcherRegistry;
  /**
   * This surface's own record of the asks IT raised, what the approval card
   * and the panel render. Not authoritative: `requestApproval` below raises the
   * same ask on the daemon, whose record every other surface reads.
   */
  readonly approvalBroker: ApprovalBroker;
  /** Raise an ask: `approvals.raise` on the daemon plus the prompt at this terminal. */
  readonly requestApproval: ApprovalRaiser;
  /** The one resolution of "which daemon", shared by every client seam. */
  readonly daemonVerbs: DaemonVerbCaller;
  /**
   * Inbound dispatch for sessions this surface hosts, over the adopted daemon's
   * session inputs. Inert until bootstrap.ts activates it; bound to the SAME
   * continuation runner the local broker uses.
   */
  readonly wireSessionDispatch: WireSessionDispatch;
  /**
   * The daemon's build floor on this terminal. bootstrap.ts feeds it every
   * floor the adopted daemon announces and attaches the notice sink; the
   * continuation runner consults it before spawning, so a build the daemon has
   * declared too old stops taking shared-session work instead of executing it
   * under superseded rules. See client/build-floors.ts.
   */
  readonly clientBuildGuard: ClientBuildGuard;
  /**
   * This surface offering its live conversation to the daemon, so a rewind
   * driven from anywhere can reach the messages, which only this process
   * holds. Started on adoption; released on disposal.
   */
  readonly conversationRewindHost: ConversationRewindHostClient;
  /** Daemon-owned settings, read and written over `config.get` / `config.set`. */
  readonly daemonConfig: DaemonConfigClient;
  /** Daemon-scoped credential writes: `credentials.set`/`delete` on the daemon, one verified sequence. */
  readonly daemonCredentials: DaemonCredentialsClient;
  /** The terminal prompt, late-bound, the UI layer patches the real one in after boot. */
  readonly localPromptRef: { requestPermission: (request: PermissionPromptRequest) => Promise<PermissionPromptDecision> };
  /** The live session id an ask belongs to; written by the bootstrap tail. */
  readonly liveSessionIdRef: { value: string | null };
  /** Loopback-fetch approval that rides the approval broker; shared by the tool registry and orchestrator so every surface asks the same way. */
  readonly localhostFetchApproval: ReturnType<typeof buildLocalhostFetchApproval>;
  /** Terminal prompt-answer handler that rides the approval broker; shared by the tool registry and orchestrator so an interactive command's prompt gets an ask/card on every surface. */
  readonly execPromptAnswerHandler: ReturnType<typeof buildExecPromptAnswerHandler>;
  /** Routes curated runtime-domain events into the panel_only notification feed (the panel's live producer). */
  readonly notificationDispatcher: NotificationDispatcher;
  /** Durable user-origin permission rules (remembered approvals); permissions.rules.* surface. Mirrors the SDK composition. */
  readonly userPermissionRuleStore: UserPermissionRuleStore;
  /**
   * An EMPTY verb catalog. This product answers no verbs, it is a client. The
   * field exists because the SDK's `startExternalServices` takes a daemon-grade
   * `RuntimeServices` even in the adopt-only mode this surface runs in, and
   * because plugin loading is handed one. Nothing is ever served off it: with
   * `adoptOnly` no `DaemonServer` is constructed, so a descriptor registered
   * here has no listener behind it. Plugin registrations that need to be
   * ANSWERED belong daemon-side, see docs/decisions for the plugin split.
   */
  readonly gatewayMethods: GatewayMethodCatalog;
  /** Step-up (re-auth) for this surface's own privileged actions. */
  readonly stepUpService: StepUpService;
  /** This installation's pairing tokens, the bearer a phone or browser presents. */
  readonly pairingTokens: PairingTokenManager;
  /** Paired-phone posture over `devices.*` verbs; the `phone` tool calls through it. */
  readonly devices: DevicesClient;
  readonly sessionBroker: SharedSessionBroker;
  readonly deliveryManager: AutomationDeliveryManager;
  readonly automationManager: AutomationManager;
  readonly artifactStore: ArtifactStore;
  readonly knowledgeService: KnowledgeService;
  readonly agentKnowledgeService: KnowledgeService;
  readonly homeGraphService: HomeGraphService;
  readonly projectPlanningService: ProjectPlanningService;
  readonly projectPlanningProjectId: string;
  readonly workPlanStore: WorkPlanStore;
  readonly memoryStore: MemoryStore;
  readonly memoryRegistry: MemoryRegistry;
  /** Host-vs-client memory access: local until bootstrap.ts activates it for an adopted 'external' daemon (mirrors sessionSpine). */
  readonly memorySpine: MemorySpineClient;
  readonly serviceRegistry: ServiceRegistry;
  readonly secretsManager: SecretsManager;
  readonly subscriptionManager: SubscriptionManager;
  readonly localUserAuthManager: UserAuthManager;
  readonly profileManager: ProfileManager;
  readonly bookmarkManager: BookmarkManager;
  readonly sessionManager: SessionManager;
  readonly sessionOrchestration: CrossSessionTaskRegistry;
  readonly hookDispatcher: HookDispatcher;
  readonly hookActivityTracker: HookActivityTracker;
  readonly hookWorkbench: HookWorkbench;
  readonly pluginManager: PluginManager;
  readonly workflow: WorkflowServices;
  readonly voiceProviders: VoiceProviderRegistry;
  readonly voiceService: VoiceService;
  readonly webSearchProviders: WebSearchProviderRegistry;
  readonly webSearchService: WebSearchService;
  readonly mediaProviders: MediaProviderRegistry;
  readonly multimodalService: MultimodalService;
  readonly memoryEmbeddingRegistry: MemoryEmbeddingProviderRegistry;
  readonly channelPolicy: ChannelPolicyManager;
  readonly mcpRegistry: McpRegistry;
  readonly tokenAuditor: ApiTokenAuditor;
  readonly componentHealthMonitor: ComponentHealthMonitor;
  readonly worktreeRegistry: WorktreeRegistry;
  readonly sandboxSessionRegistry: SandboxSessionRegistry;
  readonly webhookNotifier: WebhookNotifier;
  /** Terminal focus tracker, fed by input/handler-feed.ts, read by the alert notifiers in core/. */
  readonly focusTracker: FocusTracker;
  readonly replayEngine: DeterministicReplayEngine;
  readonly providerOptimizer: ProviderOptimizer;
  readonly providerCapabilityRegistry: ProviderCapabilityRegistry;
  readonly cacheHitTracker: CacheHitTracker;
  readonly favoritesStore: FavoritesStore;
  readonly benchmarkStore: BenchmarkStore;
  readonly modelLimitsService: ModelLimitsService;
  readonly providerRegistry: ProviderRegistry;
  readonly toolLLM: ToolLLM;
  readonly distributedRuntime: DistributedRuntimeManager;
  readonly remoteRunnerRegistry: RemoteRunnerRegistry;
  readonly remoteSupervisor: RemoteSupervisor;
  readonly sessionMemoryStore: SessionMemoryStore;
  readonly sessionLineageTracker: SessionLineageTracker;
  readonly sessionChangeTracker: SessionChangeTracker;
  readonly planManager: ExecutionPlanManager;
  readonly adaptivePlanner: AdaptivePlanner;
  readonly idempotencyStore: IdempotencyStore;
  readonly overflowHandler: OverflowHandler;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly archetypeLoader: ArchetypeLoader;
  readonly agentManager: AgentManager;
  readonly agentMessageBus: AgentMessageBus;
  readonly agentOrchestrator: AgentOrchestrator;
  readonly contextAccountingHolder: ContextAccountingHolder; // bound at bootstrap.ts; see context-accounting-source.ts
  readonly wrfcController: WrfcController;
  readonly processManager: ProcessManager;
  /** The phase/work-item orchestration engine, see runtime/workstream-services.ts. */
  readonly orchestrationEngine: OrchestrationEngine;
  readonly workstreamCommands: WorkstreamCommandService;
  /** The repo source-tree code index, see runtime/code-index-services.ts. */
  readonly codeIndexStore: CodeIndexStore;
  readonly codeIndexReindexScheduler: CodeIndexReindexScheduler; // tool-site reindex
  /** Daily snapshots of every SQLite store this runtime writes, with bounded retention; unref'd timers (mirrors the SDK composition, hosts that tear down a runtime stop() it themselves). */
  readonly storeSnapshotScheduler: StoreSnapshotScheduler;
  readonly appendOnlyRetentionScheduler: ReturnType<typeof createDurabilityServices>['appendOnlyRetentionScheduler']; // periodic append-only sweep; unref'd timers, stop() on teardown
  /** Stops the recurring crash-residue sweep; idempotent, unref'd timer (hosts that tear a runtime down call it). */
  readonly stopDurabilityHousekeeping: () => void;
  /** Stops the wake-word recovery sweep and a pending boot provision; a no-op unless `provisionWakeModelsAtBoot` was set. */
  readonly stopWakeHousekeeping: () => void;
  readonly memoryConsolidationScheduler: MemoryConsolidationScheduler;
  readonly powerManager: PowerManager;
  /** The daemon's memory governor (default ON). Backs ops.memory.get and defends the daemon's footprint by tier. */
  readonly memoryGovernor: MemoryGovernor;
  /** Registry of every retained cache the governor can shrink (knowledge stores + shared session broker). */
  readonly cacheRegistry: CacheRegistry;
  /** Controller the governor uses to pause/resume the deferrable background jobs under pressure. */
  readonly pauseController: PauseController;
  readonly sessionLiveTurnControls: SessionLiveTurnControlsHolder;
  /** Unified live process registry (agents, WRFC chains, workflows, watchers, background processes) backing the Fleet panel; archive-aware, finished subtrees can be moved to the session archive view. */
  readonly processRegistry: ArchivableProcessRegistry;
  /**
   * What the Fleet panel reads: this surface's own registry rows UNION the
   * adopted daemon's, deduped by node id with the local (live, actionable) copy
   * winning. Interval-refreshed on the daemon half, see client/fleet-union.ts.
   */
  readonly fleetReadModel: FleetUnionReadModel;
  readonly modeManager: ModeManager;
  readonly fileUndoManager: FileUndoManager;
  readonly workspaceCheckpointManager: WorkspaceCheckpointManager;
  /** Per-workspace trust gate, restricts write/execute/delegate tools until the workspace is trusted. */
  readonly workspaceTrustManager: WorkspaceTrustManager;
  readonly integrationHelpers: IntegrationHelperService;
  /** Re-root path-bound stores (MemoryStore, ProjectIndex) to a new working directory, called by WorkspaceSwapManager after verification; stores needing a process restart just warn-log and keep serving the old path until the daemon restarts with the new --working-dir. */
  rerootStores(newWorkingDir: string): Promise<void>;
  /**
   * Cancel the agent runs this graph is hosting, returning how many.
   *
   * Required by the SDK's RuntimePollerOwners: by dispose() time the fleet
   * registry, orchestration engine, process registry and bus these runs report
   * through are already down, so a run still described as "running" is orphaned
   * rather than preserved.
   */
  cancelHostedAgentRuns(): number;
  dispose(): void; // Stop every poller this graph started; best-effort, total, idempotent. This surface owns its graph — see disposal-wiring.ts.
}
