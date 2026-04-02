/**
 * Barrel export for all runtime store domain types and initial state factories.
 */

export type {
  SessionRecoveryState,
  SessionStatus,
  SessionLineageEntry,
  SessionDomainState,
} from './session.ts';
export { createInitialSessionState } from './session.ts';

export type {
  ReasoningEffort,
  ProviderTier,
  ModelTokenLimits,
  FallbackChainEntry,
  ModelDomainState,
} from './model.ts';
export { createInitialModelState } from './model.ts';

export type {
  TurnState,
  ToolExecutionState,
  ActiveToolCall,
  TurnUsage,
  StreamProgress,
  ConversationDomainState,
} from './conversation.ts';
export { createInitialConversationState } from './conversation.ts';

export type {
  OverlayId,
  OverlayInstance,
  OverlayDomainState,
} from './overlays.ts';
export { createInitialOverlaysState } from './overlays.ts';

export type {
  PanelId,
  PanelPosition,
  PanelState,
  PanelDomainState,
} from './panels.ts';
export { createInitialPanelsState } from './panels.ts';

export type {
  PermissionMode,
  PermissionDecisionMachineState,
  PermissionDecisionOutcome,
  PermissionSourceLayer,
  PermissionDecisionReason,
  PermissionDecision,
  PermissionDomainState,
} from './permissions.ts';
export { createInitialPermissionsState } from './permissions.ts';

export type {
  TaskLifecycleState,
  TaskKind,
  TaskRetryPolicy,
  RuntimeTask,
  TaskDomainState,
} from './tasks.ts';
export { createInitialTasksState } from './tasks.ts';

export type {
  AgentLifecycleState,
  AgentRole,
  AgentWrfcRef,
  RuntimeAgent,
  AgentDomainState,
} from './agents.ts';
export { createInitialAgentsState } from './agents.ts';

export type {
  ProviderStatus,
  CompositeHealthStatus,
  ProviderCallStats,
  ProviderCacheMetrics,
  ProviderHealthRecord,
  ProviderHealthDomainState,
} from './provider-health.ts';
export { createInitialProviderHealthState } from './provider-health.ts';

export type {
  McpServerLifecycleState,
  McpRegisteredTool,
  McpServerRecord,
  McpDomainState,
} from './mcp.ts';
export { createInitialMcpState } from './mcp.ts';

export type {
  PluginLifecycleState,
  RuntimePlugin,
  PluginDomainState,
} from './plugins.ts';
export { createInitialPluginsState } from './plugins.ts';

export type {
  DaemonTransportState,
  DaemonProcessInfo,
  DaemonJob,
  DaemonDomainState,
} from './daemon.ts';
export { createInitialDaemonState } from './daemon.ts';

export type {
  AcpTransportState,
  AcpConnection,
  AcpDomainState,
} from './acp.ts';
export { createInitialAcpState } from './acp.ts';

export type {
  IntegrationStatus,
  IntegrationCategory,
  IntegrationRecord,
  IntegrationDomainState,
} from './integrations.ts';
export { createInitialIntegrationsState } from './integrations.ts';

export type {
  TelemetryEventRecord,
  SessionMetrics,
  TraceContext,
  TelemetryDomainState,
} from './telemetry.ts';
export { createInitialTelemetryState } from './telemetry.ts';

export type {
  GitFileStatus,
  GitFileRecord,
  GitCommitSummary,
  GitBranchInfo,
  GitDomainState,
} from './git.ts';
export { createInitialGitState } from './git.ts';

export type {
  IndexStatus,
  LanguageServerRecord,
  FileWatcherStatus,
  DiscoveryDomainState,
} from './discovery.ts';
export { createInitialDiscoveryState } from './discovery.ts';

export type {
  IntelligenceFeatureStatus,
  LspDiagnostic,
  WorkspaceSymbol,
  IntelligenceHoverState,
  IntelligenceDomainState,
} from './intelligence.ts';
export { createInitialIntelligenceState } from './intelligence.ts';

export type {
  RenderBudgetStatus,
  RenderCycleRecord,
  InputLatencySample,
  UiPerfDomainState,
} from './ui-perf.ts';
export { createInitialUiPerfState } from './ui-perf.ts';
