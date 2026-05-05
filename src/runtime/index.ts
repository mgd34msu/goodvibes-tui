/**
 * Runtime module barrel for the TUI.
 *
 * SDK 0.33 intentionally removed private deep imports and the runtime root
 * god-barrel. This file keeps the TUI on public SDK seams while preserving the
 * local import surface used by the app.
 */

import {
  bootstrap,
  operations,
  security,
  shell,
  transport,
} from '@pellux/goodvibes-sdk/platform/runtime';
import {
  createFeatureFlagManager as createSdkFeatureFlagManager,
  FEATURE_FLAG_MAP,
} from '@pellux/goodvibes-sdk/platform/runtime/state';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  bootstrap as Bootstrap,
  operations as Operations,
  security as Security,
  shell as Shell,
  transport as Transport,
} from '@pellux/goodvibes-sdk/platform/runtime';
import type { FeatureFlagManager, FlagConfig } from '@pellux/goodvibes-sdk/platform/runtime/state';

// Local runtime entry points.
export { bootstrapRuntime } from './bootstrap.ts';
export type { RuntimeContext, BootstrapOptions } from './context.ts';
export type { BootstrapContext } from './bootstrap.ts';
export { createUiRuntimeServices } from './ui-services.ts';
export type { UiRuntimeServices } from './ui-services.ts';

export function createFeatureFlagManager(): FeatureFlagManager {
  const manager = createSdkFeatureFlagManager();
  const originalLoadFromConfig = manager.loadFromConfig.bind(manager);

  manager.loadFromConfig = (config: FlagConfig): void => {
    originalLoadFromConfig({
      flags: Object.fromEntries(
        Object.entries(config.flags).filter(([id]) => FEATURE_FLAG_MAP.has(id)),
      ) as FlagConfig['flags'],
    });
  };

  return manager;
}

// Public SDK runtime seams.
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

// Bootstrap compatibility aliases.
export const scheduleBackgroundMcpDiscovery = bootstrap.scheduleBackgroundMcpDiscovery;
export const startBackgroundProviderDiscovery = bootstrap.startBackgroundProviderDiscovery;
export const startBackgroundProviderRegistration = bootstrap.startBackgroundProviderDiscovery;
export const loadRuntimeSystemPrompt = bootstrap.loadRuntimeSystemPrompt;
export const loadBootstrapSystemPrompt = bootstrap.loadRuntimeSystemPrompt;
export const restoreRuntimeModel = bootstrap.restoreRuntimeModel;
export const restoreSavedModel = bootstrap.restoreRuntimeModel;
export const synchronizeConfiguredServices = bootstrap.synchronizeConfiguredServices;
export const syncConfiguredServices = bootstrap.synchronizeConfiguredServices;
export const registerBootstrapRuntimeEvents = bootstrap.registerBootstrapRuntimeEvents;
export const registerHostRuntimeEvents = bootstrap.registerHostRuntimeEvents;
export const startHostServices = bootstrap.startHostServices;
export const startExternalServices = bootstrap.startHostServices;
export const registerBootstrapHookBridge = bootstrap.registerBootstrapHookBridge;
export const createDeferredStartupCoordinator = bootstrap.createDeferredStartupCoordinator;
export const shutdownRuntime = bootstrap.shutdownRuntime;
export const saveSession = bootstrap.saveSession;
export const fireSessionStart = bootstrap.fireSessionStart;
export const createDirectTransportServices = bootstrap.createDirectTransportServices;
export const createOperatorClientServices = bootstrap.createOperatorClientServices;
export const createPeerClientDependencies = bootstrap.createPeerClientDependencies;
export const createRuntimeFoundationClients = bootstrap.createRuntimeFoundationClients;
export const createOperatorClient = bootstrap.createOperatorClient;
export const createPeerClient = bootstrap.createPeerClient;
export const createRuntimeProviderApi = bootstrap.createRuntimeProviderApi;
export const createRuntimeKnowledgeApi = bootstrap.createRuntimeKnowledgeApi;
export const createRuntimeHookApi = bootstrap.createRuntimeHookApi;
export const createRuntimeMcpApi = bootstrap.createRuntimeMcpApi;
export const createRuntimeOpsApi = bootstrap.createRuntimeOpsApi;

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

// Transport compatibility aliases.
export const createDirectTransport = transport.createDirectTransport;
export const createDirectTransportFromServices = transport.createDirectTransportFromServices;
export const createRuntimeDirectTransport = transport.createRuntimeDirectTransport;
export const createDirectClientTransport = transport.createDirectClientTransport;
export const createHttpTransport = transport.createHttpTransport;
export const createClientTransport = transport.createClientTransport;
export const buildUrl = transport.buildUrl;
export const createTransportPaths = transport.createTransportPaths;
export const normalizeBaseUrl = transport.normalizeBaseUrl;
export const createFetch = transport.createFetch;
export const createHttpJsonTransport = transport.createHttpJsonTransport;
export const createJsonInit = transport.createJsonInit;
export const createJsonRequestInit = transport.createJsonRequestInit;
export const readJsonBody = transport.readJsonBody;
export const requestJsonRaw = transport.requestJsonRaw;
export const requestJson = transport.requestJsonRaw;
export const createRealtimeTransport = transport.createRealtimeTransport;
export const invokeContractRoute = transport.invokeContractRoute;
export const openContractRouteStream = transport.openContractRouteStream;
export const requireContractRoute = transport.requireContractRoute;
export const isAbortError = transport.isAbortError;
export const openServerSentEventStream = transport.openServerSentEventStream;
export const createOperatorRemoteClient = transport.createOperatorRemoteClient;
export const createPeerRemoteClient = transport.createPeerRemoteClient;
export const buildEventSourceUrl = transport.buildEventSourceUrl;
export const buildWebSocketUrl = transport.buildWebSocketUrl;
export const createEventSourceConnector = transport.createEventSourceConnector;
export const createRemoteDomainEvents = transport.createRemoteDomainEvents;
export const createRemoteRuntimeEvents = transport.createRemoteRuntimeEvents;
export const createRemoteUiRuntimeEvents = transport.createRemoteUiRuntimeEvents;
export const createWebSocketConnector = transport.createWebSocketConnector;
export const applyOutboundTlsToFetchInit = transport.applyOutboundTlsToFetchInit;
export const createNetworkFetch = transport.createNetworkFetch;
export const GlobalNetworkTransportInstaller = transport.GlobalNetworkTransportInstaller;
export const inspectOutboundTls = transport.inspectOutboundTls;

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

// Operations compatibility aliases.
export const AcpTaskAdapter = operations.AcpTaskAdapter;
export const OpsControlPlane = operations.OpsControlPlane;
export const OpsIllegalActionError = operations.OpsIllegalActionError;
export const OpsTargetNotFoundError = operations.OpsTargetNotFoundError;
export const ToolContractVerifier = operations.ToolContractVerifier;
export const McpLifecycleManager = operations.McpLifecycleManager;
export const McpPermissionManager = operations.McpPermissionManager;
export const McpSchemaFreshnessTracker = operations.McpSchemaFreshnessTracker;
export const buildMcpAttackPathReview = operations.buildMcpAttackPathReview;
export const createMcpLifecycleManager = operations.createMcpLifecycleManager;
export const DEFAULT_RECONNECT_CONFIG = operations.DEFAULT_RECONNECT_CONFIG;
export const ALL_CAPABILITIES = operations.ALL_CAPABILITIES;
export const PLUGIN_CAPABILITIES = operations.PLUGIN_CAPABILITIES;
export const HIGH_RISK_CAPABILITIES = operations.HIGH_RISK_CAPABILITIES;
export const PluginLifecycleManager = operations.PluginLifecycleManager;
export const PluginQuarantineEngine = operations.PluginQuarantineEngine;
export const PluginTrustStore = operations.PluginTrustStore;
export const SAFE_CAPABILITIES = operations.SAFE_CAPABILITIES;
export const filterCapabilitiesByTrust = operations.filterCapabilitiesByTrust;
export const hasCapability = operations.hasCapability;
export const isHighRiskCapability = operations.isHighRiskCapability;
export const isPluginOperational = operations.isPluginOperational;
export const isPluginReloadable = operations.isPluginReloadable;
export const isPluginTerminal = operations.isPluginTerminal;
export const resolveCapabilityManifest = operations.resolveCapabilityManifest;
export const validateManifestV2 = operations.validateManifestV2;
export const validatePluginSignature = operations.validatePluginSignature;
export const LOW_QUALITY_THRESHOLD = operations.LOW_QUALITY_THRESHOLD;
export const computeQualityScore = operations.computeQualityScore;
export const createCompactionManager = operations.createCompactionManager;
export const describeScore = operations.describeScore;
export const escalateStrategy = operations.escalateStrategy;
export const isTerminalCompactionState = operations.isTerminalCompactionState;
export const reachableFromCompactionState = operations.reachableFromCompactionState;
export const compactionFailurePlaybook = operations.compactionFailurePlaybook;
export const exportRecoveryPlaybook = operations.exportRecoveryPlaybook;
export const permissionDeadlockPlaybook = operations.permissionDeadlockPlaybook;
export const pluginDegradationPlaybook = operations.pluginDegradationPlaybook;
export const reconnectFailurePlaybook = operations.reconnectFailurePlaybook;
export const sessionUnrecoverablePlaybook = operations.sessionUnrecoverablePlaybook;
export const stuckTurnPlaybook = operations.stuckTurnPlaybook;
export const createSessionUnrecoverablePlaybook = operations.createSessionUnrecoverablePlaybook;
export const createStuckTurnPlaybook = operations.createStuckTurnPlaybook;
export const evaluateOrchestrationSpawn = operations.evaluateOrchestrationSpawn;
export const TRANSPORT_COMPATIBILITY_MATRIX = operations.TRANSPORT_COMPATIBILITY_MATRIX;
export const applyTransition = operations.applyTransition;
export const canTransition = operations.canTransition;
export const isOperational = operations.isOperational;
export const isReloadable = operations.isReloadable;
export const isTerminal = operations.isTerminal;
export const reachableFrom = operations.reachableFrom;
export const evaluateSessionMaintenance = operations.evaluateSessionMaintenance;
export const formatSessionMaintenanceLines = operations.formatSessionMaintenanceLines;
export const getGuidanceMode = operations.getGuidanceMode;
export const DEFAULT_RETENTION_CONFIG = operations.DEFAULT_RETENTION_CONFIG;
export const RetentionPolicy = operations.RetentionPolicy;
export const SnapshotPruner = operations.SnapshotPruner;
export const buildPersistedSessionContext = operations.buildPersistedSessionContext;
export const buildLocalReturnContextSummary = operations.buildLocalReturnContextSummary;
export const formatReturnContextForDisplay = operations.formatReturnContextForDisplay;
export const getReturnContextMode = operations.getReturnContextMode;
export const maybeAssistReturnContextSummary = operations.maybeAssistReturnContextSummary;
export const persistConversation = operations.persistConversation;
export const generateUserSessionId = operations.generateUserSessionId;
export const loadLastConversation = operations.loadLastConversation;
export const loadRecoveryConversation = operations.loadRecoveryConversation;
export const writeRecoveryFile = operations.writeRecoveryFile;
export const deleteRecoveryFile = operations.deleteRecoveryFile;
export const checkRecoveryFile = operations.checkRecoveryFile;
export const getRecoveryFilePath = operations.getRecoveryFilePath;
export const getLastSessionPointerPath = operations.getLastSessionPointerPath;
export const writeLastSessionPointer = operations.writeLastSessionPointer;
export const readLastSessionPointer = operations.readLastSessionPointer;
export const exportRemoteArtifactForAgent = operations.exportRemoteArtifactForAgent;
export const importRemoteArtifact = operations.importRemoteArtifact;
export const RemoteRunnerRegistry = operations.RemoteRunnerRegistry;
export const RemoteSupervisor = operations.RemoteSupervisor;
export const DistributedRuntimeManager = operations.DistributedRuntimeManager;
export const getDistributedNodeHostContract = operations.getDistributedNodeHostContract;
export const CURRENT_PROTOCOL_VERSION = operations.CURRENT_PROTOCOL_VERSION;
export const VersionMismatchError = operations.VersionMismatchError;
export const negotiateProtocolVersion = operations.negotiateProtocolVersion;
export const createTaskManager = operations.createTaskManager;
export const PhasedToolExecutor = operations.PhasedToolExecutor;
export const budgetPhase = operations.budgetPhase;
export const permissionPhase = operations.permissionPhase;

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
export type RemoteRunnerRegistry = Operations.RemoteRunnerRegistry;
export type RemoteSupervisor = Operations.RemoteSupervisor;
export type DistributedRuntimeManager = Operations.DistributedRuntimeManager;
export type OpsControlPlane = Operations.OpsControlPlane;
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

// Runtime shell compatibility aliases.
export const createShellPathService = shell.createShellPathService;
export const createShellPlanRuntime = shell.createShellPlanRuntime;
export const createShellRemoteCommandService = shell.createShellRemoteCommandService;
export const createBootstrapCommandShellServices = shell.createBootstrapCommandShellServices;
export const resolveSurfaceDirectory = shell.resolveSurfaceDirectory;
export const classifySystemMessageKind = shell.classifySystemMessageKind;
export const classifySystemMessagePriority = shell.classifySystemMessagePriority;
export const defaultSystemMessageTarget = shell.defaultSystemMessageTarget;
export const resolveSystemMessageDelivery = shell.resolveSystemMessageDelivery;
export const buildProviderAccountSnapshot = shell.buildProviderAccountSnapshot;
export const loadEcosystemCatalog = shell.loadEcosystemCatalog;
export const searchEcosystemCatalog = shell.searchEcosystemCatalog;
export const exportEcosystemCatalogBundle = shell.exportEcosystemCatalogBundle;
export const importEcosystemCatalogBundle = shell.importEcosystemCatalogBundle;
export const inspectEcosystemCatalogBundle = shell.inspectEcosystemCatalogBundle;
export const inspectInstalledEcosystemEntry = shell.inspectInstalledEcosystemEntry;
export const installEcosystemCatalogEntry = shell.installEcosystemCatalogEntry;
export const listEcosystemInstallBackups = shell.listEcosystemInstallBackups;
export const listInstalledEcosystemEntries = shell.listInstalledEcosystemEntries;
export const removeEcosystemCatalogEntry = shell.removeEcosystemCatalogEntry;
export const reviewEcosystemCatalogEntry = shell.reviewEcosystemCatalogEntry;
export const rollbackInstalledEcosystemEntry = shell.rollbackInstalledEcosystemEntry;
export const uninstallEcosystemCatalogEntry = shell.uninstallEcosystemCatalogEntry;
export const updateInstalledEcosystemEntry = shell.updateInstalledEcosystemEntry;
export const upsertEcosystemCatalogEntry = shell.upsertEcosystemCatalogEntry;
export const summarizeWorktreeOwnership = shell.summarizeWorktreeOwnership;
export const WorktreeRegistry = shell.WorktreeRegistry;
export const listPersistedWorktreeMeta = shell.listPersistedWorktreeMeta;
export const getPersistedWorktreeMeta = shell.getPersistedWorktreeMeta;
export const reviewWorktreeAttachments = shell.reviewWorktreeAttachments;

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
export type WorktreeRegistry = Shell.WorktreeRegistry;
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

// Runtime security compatibility aliases.
export const buildAuthInspectionSnapshot = security.buildAuthInspectionSnapshot;
export const inspectProviderAuth = security.inspectProviderAuth;
export const DivergenceDashboard = security.DivergenceDashboard;
export const DivergenceGateError = security.DivergenceGateError;
export const LayeredPolicyEvaluator = security.LayeredPolicyEvaluator;
export const PermissionSimulator = security.PermissionSimulator;
export const PolicyRegistry = security.PolicyRegistry;
export const PolicyRuntimeState = security.PolicyRuntimeState;
export const buildDefaultPolicySimulationScenarios = security.buildDefaultPolicySimulationScenarios;
export const buildPermissionRuleSuggestions = security.buildPermissionRuleSuggestions;
export const buildPolicyPreflightReview = security.buildPolicyPreflightReview;
export const createPermissionEvaluator = security.createPermissionEvaluator;
export const createPermissionSimulator = security.createPermissionSimulator;
export const createUnsignedBundle = security.createUnsignedBundle;
export const lintPolicyConfig = security.lintPolicyConfig;
export const loadPolicyBundle = security.loadPolicyBundle;
export const runPolicySimulationScenarios = security.runPolicySimulationScenarios;
export const buildDenialExplanation = security.buildDenialExplanation;
export const canonicalize = security.canonicalize;
export const classifyCommand = security.classifyCommand;
export const classifySegment = security.classifySegment;
export const collectCommandNodes = security.collectCommandNodes;
export const evaluateCommandAST = security.evaluateCommandAST;
export const evaluateSegmentNode = security.evaluateSegmentNode;
export const higherPriority = security.higherPriority;
export const parseAST = security.parseAST;
export const parseCommandAST = security.parseCommandAST;
export const tokenize = security.tokenize;
export const PolicySignatureError = security.PolicySignatureError;
export const canonicalise = security.canonicalise;
export const runSafetyChecks = security.runSafetyChecks;
export const signBundle = security.signBundle;
export const verifyBundle = security.verifyBundle;
export const MAX_INPUT_LENGTH = security.MAX_INPUT_LENGTH;
export const MAX_TOKEN_COUNT = security.MAX_TOKEN_COUNT;

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
export type PolicyRegistry = Security.PolicyRegistry;
export type PolicyRuntimeState = Security.PolicyRuntimeState;
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
export type SignedPolicyBundle = Security.SignedPolicyBundle;

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
