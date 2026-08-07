/**
 * Runtime module barrel for the TUI.
 *
 * SDK 0.33 intentionally removed private deep imports and the runtime root
 * god-barrel. This file keeps the TUI on public SDK seams while preserving the
 * local import surface used by the app.
 */

// No runtime namespace objects are imported as values here: an eager
// `export const X = ns.X` compiles to a top-level property read off a lazy
// namespace object, and Bun's single-file compiler orders module bodies
// nondeterministically — on some builds the read lands before the defining
// module and the compiled binary dies at load with a ReferenceError. Every
// value below is a grouped live re-export from the SDK's registered runtime
// subpaths instead (exactly how the operations block below fixed the first
// bite of this class); the toolchain post-build-smoke scans compiled
// artifacts for the eager pattern and fails the build if one returns.
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  bootstrap as Bootstrap,
  operations as Operations,
  security as Security,
  shell as Shell,
  transport as Transport,
} from '@pellux/goodvibes-sdk/platform/runtime';

// Local runtime entry points.
export { bootstrapRuntime } from './bootstrap.ts';
export type { RuntimeContext, BootstrapOptions } from './context.ts';
export type { BootstrapContext } from './bootstrap.ts';
export { createUiRuntimeServices } from './ui-services.ts';
export type { UiRuntimeServices } from './ui-services.ts';

// Public SDK runtime seams. createFeatureFlagManager comes straight from the
// SDK state seam below: gate states derive from domain settings keys
// (deriveFeatureStates), so the old TUI wrapper that filtered unknown ids out
// of persisted `featureFlags` overrides has nothing left to filter.
export * from '@pellux/goodvibes-sdk/platform/runtime/state';
export * from '@pellux/goodvibes-sdk/platform/runtime/store';
export * from '@pellux/goodvibes-sdk/platform/runtime/ui';
export * from '@pellux/goodvibes-sdk/platform/runtime/observability';
export * from '@pellux/goodvibes-sdk/platform/runtime/settings';
export * from '@pellux/goodvibes-sdk/platform/runtime/sandbox';
export * from './sandbox-public-gaps.ts';
export {
  CONTROL_PLANE_CLIENT_KINDS,
  CONTROL_PLANE_TRANSPORT_KINDS,
  ROUTE_SURFACE_KINDS,
  SURFACE_KINDS,
  registeredEventTypes,
  validateKnownEvent as validateEvent,
} from '@pellux/goodvibes-sdk/events';
export type {
  AgentEvent,
  CommunicationEvent,
  CompactionEvent,
  DeliveryEvent,
  McpEvent,
  OpsEvent,
  OpsInterventionReason,
  OrchestrationEvent,
  PermissionEvent,
  PlannerEvent,
  PluginEvent,
  ProviderEvent,
  RouteEvent,
  SessionEvent,
  TaskEvent,
  ToolEvent,
  TransportEvent,
  TurnEvent,
  WorkflowEvent,
} from '@pellux/goodvibes-sdk/events';

// Bootstrap compatibility aliases — grouped live re-exports (see the header
// comment for why these must not be eager namespace reads).
export {
  scheduleBackgroundMcpDiscovery,
  startBackgroundProviderDiscovery,
  startBackgroundProviderDiscovery as startBackgroundProviderRegistration,
  loadRuntimeSystemPrompt,
  loadRuntimeSystemPrompt as loadBootstrapSystemPrompt,
  restoreRuntimeModel,
  restoreRuntimeModel as restoreSavedModel,
  synchronizeConfiguredServices,
  synchronizeConfiguredServices as syncConfiguredServices,
  registerBootstrapRuntimeEvents,
  registerHostRuntimeEvents,
  startHostServices,
  startHostServices as startExternalServices,
  registerBootstrapHookBridge,
  createDeferredStartupCoordinator,
  shutdownRuntime,
  saveSession,
  fireSessionStart,
  createDirectTransportServices,
  createOperatorClientServices,
  createPeerClientDependencies,
  createRuntimeFoundationClients,
  createOperatorClient,
  createPeerClient,
  createRuntimeProviderApi,
  createRuntimeKnowledgeApi,
  createRuntimeHookApi,
  createRuntimeMcpApi,
  createRuntimeOpsApi,
} from '@pellux/goodvibes-sdk/platform/runtime/bootstrap';

export type BackgroundRuntimeTaskHandle = Bootstrap.BackgroundRuntimeTaskHandle;
export type BackgroundMcpDiscoveryOptions = Bootstrap.BackgroundMcpDiscoveryOptions;
export type BackgroundProviderDiscoveryOptions = Bootstrap.BackgroundProviderDiscoveryOptions;
export type HostSystemMessageSink = Bootstrap.HostSystemMessageSink;
export type RuntimeSelectionState = Bootstrap.RuntimeSelectionState;
export type RuntimeModelSelectionState = Bootstrap.RuntimeModelSelectionState;
export type BootstrapRuntimeEventBridgeOptions = Bootstrap.BootstrapRuntimeEventBridgeOptions;
export type HostRuntimeEventBridgeOptions = Bootstrap.HostRuntimeEventBridgeOptions;
export type HostRuntimeMessageRouter = Bootstrap.HostRuntimeMessageRouter;
export type HostServiceMode = Bootstrap.HostServiceMode;
export type HostServicesConfig = Bootstrap.HostServicesConfig;
export type HostServicesHandle = Bootstrap.HostServicesHandle;
export type ExternalServicesHandle = Bootstrap.HostServicesHandle;
export type HostServiceStatus = Bootstrap.HostServiceStatus;
export type HookBridgeRegistrationOptions = Bootstrap.HookBridgeRegistrationOptions;
export type DeferredStartupCoordinator = Bootstrap.DeferredStartupCoordinator;
export type DeferredStartupTask = Bootstrap.DeferredStartupTask;
export type DirectTransportServicesOptions = Bootstrap.DirectTransportServicesOptions;
export type DirectTransportServices = Bootstrap.DirectTransportServices;
export type OperatorClientServicesOptions = Bootstrap.OperatorClientServicesOptions;
export type OperatorClientServices = Bootstrap.OperatorClientServices;
export type OperatorClientReadModels = Bootstrap.OperatorClientReadModels;
export type RuntimeFoundationClients = Bootstrap.RuntimeFoundationClients;
export type RuntimeFoundationClientsOptions = Bootstrap.RuntimeFoundationClientsOptions;
export type OperatorClient = Bootstrap.OperatorClient;
export type PeerClient = Bootstrap.PeerClient;
export type OpsApi = Bootstrap.OpsApi;

// Transport compatibility aliases — grouped live re-exports.
export {
  createDirectTransport,
  createDirectTransportFromServices,
  createRuntimeDirectTransport,
  createDirectClientTransport,
  createHttpTransport,
  createClientTransport,
  buildUrl,
  createTransportPaths,
  normalizeBaseUrl,
  createFetch,
  createHttpJsonTransport,
  createJsonInit,
  createJsonRequestInit,
  readJsonBody,
  requestJsonRaw,
  requestJsonRaw as requestJson,
  createRealtimeTransport,
  invokeContractRoute,
  openContractRouteStream,
  requireContractRoute,
  isAbortError,
  openServerSentEventStream,
  createOperatorRemoteClient,
  createPeerRemoteClient,
  buildEventSourceUrl,
  buildWebSocketUrl,
  createEventSourceConnector,
  createRemoteDomainEvents,
  createRemoteRuntimeEvents,
  createRemoteUiRuntimeEvents,
  createWebSocketConnector,
  applyOutboundTlsToFetchInit,
  createNetworkFetch,
  GlobalNetworkTransportInstaller,
  inspectOutboundTls,
} from '@pellux/goodvibes-sdk/platform/runtime/transport';
// Re-exported here because bootstrap.ts — the one place an exit can await
// anything — sits on the 800-line per-file gate, so it reaches this through the
// import block it already has rather than a second import line.
export { leaveHostedSessionOnExit } from './client/hosted-exit.ts';

export type DirectTransport = Transport.DirectTransport;
export type DirectClientTransport<TOperator = unknown, TPeer = unknown> = Transport.DirectClientTransport<TOperator, TPeer>;
export type HttpTransport = Transport.HttpTransport;
export type HttpTransportOptions = Transport.HttpTransportOptions;
export type HttpTransportSnapshot = Transport.HttpTransportSnapshot;
export type ClientTransport<TKind extends string = string, TOperator = unknown, TPeer = unknown> = Transport.ClientTransport<TKind, TOperator, TPeer>;
export type TransportPaths = Transport.TransportPaths;
export type RealtimeTransport = Transport.RealtimeTransport;
export type RealtimeTransportOptions = Transport.RealtimeTransportOptions;
export type RealtimeTransportSnapshot = Transport.RealtimeTransportSnapshot;
export type HttpJsonRequestOptions = Transport.HttpJsonRequestOptions;
export type HttpJsonTransport = Transport.HttpJsonTransport;
export type HttpJsonTransportOptions = Transport.HttpJsonTransportOptions;
export type JsonObject = Transport.JsonObject;
export type JsonValue = Transport.JsonValue;
export type ResolvedContractRequest = Transport.ResolvedContractRequest;
export type TransportJsonError = Transport.TransportJsonError;
export type ContractInvokeOptions = Transport.ContractInvokeOptions;
export type ContractRouteDefinition = Transport.ContractRouteDefinition;
export type ContractRouteLike = Transport.ContractRouteLike;
export type ContractStreamOptions = Transport.ContractStreamOptions;
export type ServerSentEventHandlers = Transport.ServerSentEventHandlers;
export type ServerSentEventOptions = Transport.ServerSentEventOptions;
export type OperatorRemoteClient = Transport.OperatorRemoteClient;
export type OperatorRemoteClientInvokeOptions = Transport.OperatorRemoteClientInvokeOptions;
export type OperatorRemoteClientStreamOptions = Transport.OperatorRemoteClientStreamOptions;
export type PeerRemoteClient = Transport.PeerRemoteClient;
export type PeerRemoteClientInvokeOptions = Transport.PeerRemoteClientInvokeOptions;
export type DomainEventConnector<TDomain extends string = string, TEvent extends { readonly type: string } = { readonly type: string }> = Transport.DomainEventConnector<TDomain, TEvent>;
export type RemoteDomainEventsOptions = Transport.RemoteDomainEventsOptions;
export type RemoteDomainEvents<TDomain extends string = string, TEvent extends { readonly type: string } = { readonly type: string }> = Transport.RemoteDomainEvents<TDomain, TEvent>;
export type RemoteRuntimeEventsOptions = Transport.RemoteRuntimeEventsOptions;
export type RemoteRuntimeEvents = Transport.RemoteRuntimeEvents;
export type SerializedRuntimeEnvelope = Transport.SerializedRuntimeEnvelope;

// Operations compatibility aliases. Grouped as a single live ESM re-export
// from the SDK's own `platform/runtime/operations` subpath rather than eager
// `export const X = operations.X` module-scope reads off the `operations`
// namespace object: those reads evaluated the namespace getter while the
// compiled single-file bundle could still be mid-cycle, and the binding they
// reached for was not defined yet — source execution hid this, the compiled
// binary died on it at load. A grouped `export { ... } from '<subpath>'` is a
// live binding resolved by the module system, not a module-scope value read,
// so it is cycle-safe.
export {
  AcpTaskAdapter,
  OpsControlPlane,
  OpsIllegalActionError,
  OpsTargetNotFoundError,
  ToolContractVerifier,
  McpLifecycleManager,
  McpPermissionManager,
  McpSchemaFreshnessTracker,
  buildMcpAttackPathReview,
  createMcpLifecycleManager,
  DEFAULT_RECONNECT_CONFIG,
  ALL_CAPABILITIES,
  PLUGIN_CAPABILITIES,
  HIGH_RISK_CAPABILITIES,
  PluginLifecycleManager,
  PluginQuarantineEngine,
  PluginTrustStore,
  SAFE_CAPABILITIES,
  filterCapabilitiesByTrust,
  hasCapability,
  isHighRiskCapability,
  isPluginOperational,
  isPluginReloadable,
  isPluginTerminal,
  resolveCapabilityManifest,
  validateManifestV2,
  validatePluginSignature,
  LOW_QUALITY_THRESHOLD,
  computeQualityScore,
  createCompactionManager,
  describeScore,
  escalateStrategy,
  isTerminalCompactionState,
  reachableFromCompactionState,
  compactionFailurePlaybook,
  exportRecoveryPlaybook,
  permissionDeadlockPlaybook,
  pluginDegradationPlaybook,
  reconnectFailurePlaybook,
  sessionUnrecoverablePlaybook,
  stuckTurnPlaybook,
  createSessionUnrecoverablePlaybook,
  createStuckTurnPlaybook,
  evaluateOrchestrationSpawn,
  TRANSPORT_COMPATIBILITY_MATRIX,
  applyTransition,
  canTransition,
  isOperational,
  isReloadable,
  isTerminal,
  reachableFrom,
  evaluateSessionMaintenance,
  formatSessionMaintenanceLines,
  getGuidanceMode,
  buildPersistedSessionContext,
  buildLocalReturnContextSummary,
  formatReturnContextForDisplay,
  getReturnContextMode,
  maybeAssistReturnContextSummary,
  persistConversation,
  generateUserSessionId,
  loadLastConversation,
  loadRecoveryConversation,
  writeRecoveryFile,
  deleteRecoveryFile,
  checkRecoveryFile,
  getRecoveryFilePath,
  getRecoveryDir,
  getLastSessionPointerPath,
  writeLastSessionPointer,
  readLastSessionPointer,
  createSessionSurface,
  consumeRecovery,
  removeRecoveryPoint,
  checkRecoveryForSession,
  exportRemoteArtifactForAgent,
  importRemoteArtifact,
  RemoteRunnerRegistry,
  RemoteSupervisor,
  DistributedRuntimeManager,
  getDistributedNodeHostContract,
  CURRENT_PROTOCOL_VERSION,
  VersionMismatchError,
  negotiateProtocolVersion,
  createTaskManager,
  PhasedToolExecutor,
  budgetPhase,
  permissionPhase,
} from '@pellux/goodvibes-sdk/platform/runtime/operations';
// Snapshot-retention symbols (SnapshotPruner, RetentionPolicy,
// DEFAULT_RETENTION_CONFIG) are intentionally NOT re-exported here. No app code
// consumes them — only the retention unit test does, and it now imports them
// straight from the SDK `operations` namespace. Re-exporting them created a
// second top-level binding named `SnapshotPruner` that collided with the SDK's
// own `class SnapshotPruner`, forcing the bundler to rename ours to
// `SnapshotPruner2` and emit a fragile `SnapshotPruner2 = operations.SnapshotPruner`
// module-init assignment. `bun build --compile` occasionally drops that renamed
// `var` declaration on the darwin-arm64 target, so the compiled binary died at
// startup with `ReferenceError: SnapshotPruner2 is not defined`. Dropping the
// re-export removes the collision (and the same latent hazard for the other two).
// Instance-type companions for the operations class aliases are no longer
// declared here: `export { X } from '<subpath>'` forwards a class's value AND
// its implicit instance type together, so a separate local
// `export type X = InstanceType<typeof operations.X>` for the same name is
// now a redundant declaration that TypeScript rejects as a conflict
// (TS2484). This applies to every class name in the grouped re-export above
// (AcpTaskAdapter, OpsControlPlane, OpsIllegalActionError,
// OpsTargetNotFoundError, ToolContractVerifier, McpLifecycleManager,
// McpPermissionManager, McpSchemaFreshnessTracker, PluginLifecycleManager,
// PluginQuarantineEngine, PluginTrustStore, RemoteRunnerRegistry,
// RemoteSupervisor, DistributedRuntimeManager) — their instance types are
// forwarded automatically and are not redeclared below.
// The declare-once storage handle (platform/runtime/session-surface.ts) plus
// the two prompted-recovery primitives that only accept it. Every session
// path in this app derives from one surface built in runtime/services.ts.
export type SessionSurface = Operations.SessionSurface;
// Probe for a NAMED session's live snapshot (per-session supersession — see
// session-recovery.ts's header) without retiring anything. Backs the
// --continue / --resume pre-resume check in cli/tui-startup.ts.
export type RecoveryFileInfo = Operations.RecoveryFileInfo;

export type RemoteSessionBundle = Operations.RemoteSessionBundle;
export type ContractVerifierOptions = Operations.ContractVerifierOptions;
export type McpAttackPathFinding = Operations.McpAttackPathFinding;
export type McpAttackPathFindingKind = Operations.McpAttackPathFindingKind;
export type McpAttackPathReview = Operations.McpAttackPathReview;
export type McpCapabilityClass = Operations.McpCapabilityClass;
export type McpCoherenceAssessment = Operations.McpCoherenceAssessment;
export type McpCoherenceVerdict = Operations.McpCoherenceVerdict;
export type McpDecisionRecord = Operations.McpDecisionRecord;
export type McpEventHandler = Operations.McpEventHandler;
export type McpLifecycleManagerOptions = Operations.McpLifecycleManagerOptions;
export type McpPermission = Operations.McpPermission;
export type McpReconnectConfig = Operations.McpReconnectConfig;
export type McpRiskLevel = Operations.McpRiskLevel;
export type McpSchemaRecord = Operations.McpSchemaRecord;
export type McpSecuritySnapshot = Operations.McpSecuritySnapshot;
export type McpServerEntry = Operations.McpServerEntry;
export type McpServerPermissions = Operations.McpServerPermissions;
export type McpServerRole = Operations.McpServerRole;
export type McpServerState = Operations.McpServerState;
export type McpToolPermission = Operations.McpToolPermission;
export type McpTrustLevel = Operations.McpTrustLevel;
export type McpTrustMode = Operations.McpTrustMode;
export type McpTrustProfile = Operations.McpTrustProfile;
export type QuarantineReason = Operations.QuarantineReason;
export type QuarantineRecord = Operations.QuarantineRecord;
export type SchemaFreshness = Operations.SchemaFreshness;
export type PluginCapability = Operations.PluginCapability;
export type PluginCapabilityManifest = Operations.PluginCapabilityManifest;
export type PluginManifestV2 = Operations.PluginManifestV2;
export type PluginTrustTier = Operations.PluginTrustTier;
export type CompactionQualityScore = Operations.CompactionQualityScore;
export type CompactionStrategy = Operations.CompactionStrategy;
export type StrategyInput = Operations.StrategyInput;
export type StrategyOutput = Operations.StrategyOutput;
export type DistributedRuntimeSnapshotStore = Operations.DistributedRuntimeSnapshotStore;
// RemoteRunnerRegistry, RemoteSupervisor, DistributedRuntimeManager, and
// OpsControlPlane are classes forwarded by the grouped value re-export above
// (`export { X } from '<subpath>'` carries both the value and its implicit
// instance type), so redeclaring their types here would conflict (TS2484).
export type RuntimeTransitionResult = Operations.RuntimeTransitionResult;
export type RetentionClass = Operations.RetentionClass;
export type RetentionClassConfig = Operations.RetentionClassConfig;
export type RetentionConfig = Operations.RetentionConfig;
export type CheckpointRecord = Operations.CheckpointRecord;
export type PruneOptions = Operations.PruneOptions;
export type PruneResult = Operations.PruneResult;
export type PerClassPruneResult = Operations.PerClassPruneResult;
export type Pruner = Operations.Pruner;
export type RetentionStats = Operations.RetentionStats;
export type SessionReturnContextSummary = Operations.SessionReturnContextSummary;
export type SessionSnapshot = Operations.SessionSnapshot;
export type RemoteSupervisorSnapshot = Operations.RemoteSupervisorSnapshot;
export type DistributedPeerKind = Operations.DistributedPeerKind;
export type DistributedPairRequestStatus = Operations.DistributedPairRequestStatus;
export type DistributedPeerStatus = Operations.DistributedPeerStatus;
export type DistributedWorkPriority = Operations.DistributedWorkPriority;
export type DistributedWorkStatus = Operations.DistributedWorkStatus;
export type DistributedWorkType = Operations.DistributedWorkType;
export type DistributedSessionBridge = Operations.DistributedSessionBridge;
export type DistributedApprovalBridge = Operations.DistributedApprovalBridge;
export type DistributedAutomationBridge = Operations.DistributedAutomationBridge;
export type DistributedRuntimePairRequest = Operations.DistributedRuntimePairRequest;
export type DistributedPeerTokenRecord = Operations.DistributedPeerTokenRecord;
export type DistributedPeerRecord = Operations.DistributedPeerRecord;
export type DistributedPendingWork = Operations.DistributedPendingWork;
export type DistributedRuntimeAuditRecord = Operations.DistributedRuntimeAuditRecord;
export type DistributedPeerAuth = Operations.DistributedPeerAuth;
export type DistributedNodeHostContract = Operations.DistributedNodeHostContract;
export type TaskManager = Operations.TaskManager;
export type TaskHooks = Operations.TaskHooks;
export type ToolRuntimeContext = Operations.ToolRuntimeContext;
export type RuntimeStoreAccess = Operations.RuntimeStoreAccess;
export type ToolExecutionPhase = Operations.ToolExecutionPhase;
export type PhaseResult = Operations.PhaseResult;
export type ToolExecutionRecord = Operations.ToolExecutionRecord;

// Runtime shell compatibility aliases — grouped live re-exports.
// WorktreeRegistry is a class: the value re-export carries its instance type,
// so the old separate `export type WorktreeRegistry` alias is gone (TS2484).
export {
  createShellPathService,
  createShellPlanRuntime,
  createShellRemoteCommandService,
  createBootstrapCommandShellServices,
  resolveSurfaceDirectory,
  classifySystemMessageKind,
  classifySystemMessagePriority,
  defaultSystemMessageTarget,
  resolveSystemMessageDelivery,
  buildProviderAccountSnapshot,
  loadEcosystemCatalog,
  searchEcosystemCatalog,
  exportEcosystemCatalogBundle,
  importEcosystemCatalogBundle,
  inspectEcosystemCatalogBundle,
  inspectInstalledEcosystemEntry,
  installEcosystemCatalogEntry,
  listEcosystemInstallBackups,
  listInstalledEcosystemEntries,
  removeEcosystemCatalogEntry,
  reviewEcosystemCatalogEntry,
  rollbackInstalledEcosystemEntry,
  uninstallEcosystemCatalogEntry,
  updateInstalledEcosystemEntry,
  upsertEcosystemCatalogEntry,
  summarizeWorktreeOwnership,
  WorktreeRegistry,
  listPersistedWorktreeMeta,
  getPersistedWorktreeMeta,
  reviewWorktreeAttachments,
} from '@pellux/goodvibes-sdk/platform/runtime/shell';

export type MutableRuntimeState = Shell.MutableRuntimeState;
export type ProviderAccountRecord = Shell.ProviderAccountRecord;
export type ProviderAccountSnapshot = Shell.ProviderAccountSnapshot;
export type ProviderAuthFreshness = Shell.ProviderAuthFreshness;
export type ProviderAuthRoute = Shell.ProviderAuthRoute;
export type ShellPathService = Shell.ShellPathService;
export type BootstrapCommandShellServices = Shell.BootstrapCommandShellServices;
export type CommandExtensionShellServices = Shell.CommandExtensionShellServices;
export type CommandOpsShellServices = Shell.CommandOpsShellServices;
export type CommandPlatformShellServices = Shell.CommandPlatformShellServices;
export type CommandWorkspaceShellServices = Shell.CommandWorkspaceShellServices;
export type RemoteCommandService = Shell.RemoteCommandService;
export type PlanRuntimeService = Shell.PlanRuntimeService;
export type WorktreeStatusRecord = Shell.WorktreeStatusRecord;
export type ManagedWorktreeMeta = Shell.ManagedWorktreeMeta;
export type ShellAgentManagerService = Shell.ShellAgentManagerService;
export type ShellAcpManagerService = Shell.ShellAcpManagerService;
export type ShellAutomationManagerService = Shell.ShellAutomationManagerService;
export type ShellAutomationManagerRuntimeService = Shell.ShellAutomationManagerRuntimeService;
export type ShellModeManagerService = Shell.ShellModeManagerService;
export type ShellPlanManagerService = Shell.ShellPlanManagerService;
export type ShellSessionOrchestrationService = Shell.ShellSessionOrchestrationService;
export type SystemMessageKind = Shell.SystemMessageKind;
export type SystemMessageTarget = Shell.SystemMessageTarget;
export type EcosystemCatalogPathOptions = Shell.EcosystemCatalogPathOptions;
export type EcosystemCatalogBundle = Shell.EcosystemCatalogBundle;
export type EcosystemCatalogEntry = Shell.EcosystemCatalogEntry;
export type EcosystemEntryKind = Shell.EcosystemEntryKind;

// Runtime security compatibility aliases — grouped live re-exports. The class
// re-exports (DivergenceDashboard, PolicyRegistry, …) carry their instance
// types, so the old separate type companions for those names are gone.
export {
  buildAuthInspectionSnapshot,
  inspectProviderAuth,
  DivergenceDashboard,
  DivergenceGateError,
  LayeredPolicyEvaluator,
  PermissionSimulator,
  PolicyRegistry,
  PolicyRuntimeState,
  buildDefaultPolicySimulationScenarios,
  buildPermissionRuleSuggestions,
  buildPolicyPreflightReview,
  createPermissionEvaluator,
  createPermissionSimulator,
  createUnsignedBundle,
  lintPolicyConfig,
  loadPolicyBundle,
  runPolicySimulationScenarios,
  buildDenialExplanation,
  canonicalize,
  classifyCommand,
  classifySegment,
  collectCommandNodes,
  evaluateCommandAST,
  evaluateSegmentNode,
  higherPriority,
  parseAST,
  parseCommandAST,
  tokenize,
  PolicySignatureError,
  canonicalise,
  runSafetyChecks,
  signBundle,
  verifyBundle,
  MAX_INPUT_LENGTH,
  MAX_TOKEN_COUNT,
} from '@pellux/goodvibes-sdk/platform/runtime/security';

export type AuthInspectionSnapshot = Security.AuthInspectionSnapshot;
export type ProviderAuthInspection = Security.ProviderAuthInspection;
export type DivergenceDashboardSnapshot = Security.DivergenceDashboardSnapshot;
export type DivergenceStats = Security.DivergenceStats;
export type PermissionsConfig = Security.PermissionsConfig;
export type PolicyBundlePayload = Security.PolicyBundlePayload;
export type PolicyBundleVersion = Security.PolicyBundleVersion;
export type PolicyDiffResult = Security.PolicyDiffResult;
export type PolicyLintFinding = Security.PolicyLintFinding;
export type PolicyPreflightReview = Security.PolicyPreflightReview;
export type PolicyRule = Security.PolicyRule;
export type PolicySimulationSummary = Security.PolicySimulationSummary;
export type PermissionAuditEntry = Security.PermissionAuditEntry;
export type CommandClassification = Security.CommandClassification;
export type CommandNode = Security.CommandNode;
export type CommandSegment = Security.CommandSegment;
export type CommandToken = Security.CommandToken;
export type PipeNode = Security.PipeNode;
export type SequenceNode = Security.SequenceNode;
export type SubshellNode = Security.SubshellNode;
export type BundleProvenance = Security.BundleProvenance;
export type DecisionReason = Security.DecisionReason;
export type DivergenceReport = Security.DivergenceReport;
export type EnforceGateResult = Security.EnforceGateResult;
export type SignedPolicyBundle<T = unknown> = Security.SignedPolicyBundle<T>;

export interface InspectableDomain {
  readonly name: string;
  getState(): Record<string, unknown>;
  getRevision(): number;
  getLastUpdatedAt(): number;
}

export type InboundTlsMode = 'off' | 'proxy' | 'direct';
export type InboundServerSurface = 'controlPlane' | 'httpListener';

export interface InboundTlsSnapshot {
  readonly surface: InboundServerSurface;
  readonly host: string;
  readonly port: number;
  readonly mode: InboundTlsMode;
  readonly scheme: 'http' | 'https';
  readonly trustProxy: boolean;
  readonly certFile?: string | undefined;
  readonly keyFile?: string | undefined;
  readonly usingDefaultPaths: boolean;
  readonly ready: boolean;
  readonly errors: readonly string[];
  readonly keyPermissions?: {
    readonly available: boolean;
    readonly safe?: boolean | undefined;
    readonly mode?: string | undefined;
  };
}

interface InboundTlsConfigReader {
  get(path: string): unknown;
  getControlPlaneConfigDir(): string;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function resolveGoodVibesRoot(configManager: Pick<InboundTlsConfigReader, 'getControlPlaneConfigDir'>): string {
  return resolve(configManager.getControlPlaneConfigDir());
}

function resolvePathFromGoodVibesRoot(value: string | null | undefined, configManager: Pick<InboundTlsConfigReader, 'getControlPlaneConfigDir'>): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  if (trimmed.startsWith('/')) return trimmed;
  return resolve(resolveGoodVibesRoot(configManager), trimmed);
}

function getDefaultInboundCertPaths(configManager: Pick<InboundTlsConfigReader, 'getControlPlaneConfigDir'>): { readonly certFile: string; readonly keyFile: string } {
  const certDir = join(resolveGoodVibesRoot(configManager), 'certs');
  return {
    certFile: join(certDir, 'fullchain.pem'),
    keyFile: join(certDir, 'privkey.pem'),
  };
}

function inspectPrivateKeyPermissions(path: string): { readonly available: boolean; readonly safe?: boolean | undefined; readonly mode?: string | undefined } {
  try {
    const stats = statSync(path);
    if (process.platform === 'win32') return { available: true };
    const mode = stats.mode & 0o777;
    return {
      available: true,
      safe: (mode & 0o077) === 0,
      mode: mode.toString(8).padStart(4, '0'),
    };
  } catch {
    return { available: false };
  }
}

export function extractForwardedClientIp(req: Request, trustProxy: boolean): string | undefined {
  if (!trustProxy) return undefined;
  const forwardedFor = req.headers.get('x-forwarded-for');
  const firstForwarded = forwardedFor?.split(',')[0]?.trim();
  if (firstForwarded) return firstForwarded;
  return req.headers.get('x-real-ip')?.trim() || undefined;
}

export function inspectInboundTls(configManager: InboundTlsConfigReader, surface: InboundServerSurface): InboundTlsSnapshot {
  const prefix = surface === 'controlPlane' ? 'controlPlane' : 'httpListener';
  const defaultPort = surface === 'controlPlane' ? 3421 : 3422;
  const mode = (readString(configManager.get(`${prefix}.tls.mode`)) || 'off') as InboundTlsMode;
  const trustProxy = readBoolean(configManager.get(`${prefix}.trustProxy`));
  const host = readString(configManager.get(`${prefix}.host`)) || '127.0.0.1';
  const port = readNumber(configManager.get(`${prefix}.port`), defaultPort);
  const defaults = getDefaultInboundCertPaths(configManager);
  const explicitCert = resolvePathFromGoodVibesRoot(readString(configManager.get(`${prefix}.tls.certFile`)), configManager);
  const explicitKey = resolvePathFromGoodVibesRoot(readString(configManager.get(`${prefix}.tls.keyFile`)), configManager);
  const certFile = explicitCert ?? defaults.certFile;
  const keyFile = explicitKey ?? defaults.keyFile;
  const usingDefaultPaths = explicitCert === null && explicitKey === null;
  const errors: string[] = [];

  if (mode === 'direct') {
    if (!existsSync(certFile)) errors.push(`Certificate file not found: ${certFile}`);
    if (!existsSync(keyFile)) errors.push(`Private key file not found: ${keyFile}`);
  }

  const keyPermissions = mode === 'direct' ? inspectPrivateKeyPermissions(keyFile) : undefined;
  return {
    surface,
    host,
    port,
    mode,
    scheme: mode === 'off' ? 'http' : 'https',
    trustProxy,
    ...(mode === 'direct' ? { certFile, keyFile } : {}),
    usingDefaultPaths,
    ready: mode === 'off' || mode === 'proxy' || errors.length === 0,
    errors,
    ...(keyPermissions ? { keyPermissions } : {}),
  };
}
