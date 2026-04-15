/**
 * Runtime module barrel — re-exports all runtime subsystems.
 *
 * This is the primary entry point for consuming the runtime layer.
 * Import from '@/runtime' or '../runtime/index.ts' rather than
 * reaching into subdirectories directly.
 */

// Store
export { createRuntimeStore, createDomainDispatch } from './store/index.ts';
export type { RuntimeStore, DomainDispatch } from './store/index.ts';
export type { RuntimeState } from './store/state.ts';
export * from './store/selectors/index.ts';

// Events
export { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
export { createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/event-envelope';
export type { EventEnvelope, EventEnvelopeContext } from '@pellux/goodvibes-sdk/platform/runtime/event-envelope';
export type { RuntimeEventEnvelope, EnvelopeContext } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
export { RUNTIME_EVENT_DOMAINS, isRuntimeEventDomain } from '@pellux/goodvibes-sdk/platform/runtime/events/domain-map';
export type { AnyRuntimeEvent, RuntimeEventDomain } from '@pellux/goodvibes-sdk/platform/runtime/events/domain-map';
export { createRuntimeEventFeed, createRuntimeEventFeeds } from '@pellux/goodvibes-sdk/platform/runtime/event-feeds';
export type { RuntimeEventFeed, RuntimeEventFeeds } from '@pellux/goodvibes-sdk/platform/runtime/event-feeds';

// Emitters
export type { EmitterContext } from '@pellux/goodvibes-sdk/platform/runtime/emitters/index';

// Health
export { RuntimeHealthAggregator } from '@pellux/goodvibes-sdk/platform/runtime/health/aggregator';
export { CascadeEngine } from '@pellux/goodvibes-sdk/platform/runtime/health/cascade-engine';
export { CASCADE_RULES } from '@pellux/goodvibes-sdk/platform/runtime/health/cascade-rules';
export { createHealthSystem } from '@pellux/goodvibes-sdk/platform/runtime/health/index';
export type {
  HealthStatus,
  HealthDomain as RuntimeHealthDomain,
  DomainHealth,
  CompositeHealth,
  CascadeRule,
  CascadeEffect,
  CascadeResult,
  EvaluateResult,
  CascadeAppliedEvent,
} from '@pellux/goodvibes-sdk/platform/runtime/health/types';

// Notifications
export { NotificationRouter, createNotificationRouter } from '@pellux/goodvibes-sdk/platform/runtime/notifications/index';
export type { Notification, NotificationLevel, NotificationTarget, DomainVerbosity, RoutingDecision } from '@pellux/goodvibes-sdk/platform/runtime/notifications/types';

// UI surfaces
export { createModelPickerData, ModelPickerDataProvider } from '@pellux/goodvibes-sdk/platform/runtime/ui/model-picker/index';
export type { ModelPickerDataProviderOptions } from '@pellux/goodvibes-sdk/platform/runtime/ui/model-picker/index';
export { createProviderHealthData, ProviderHealthDataProvider } from '@pellux/goodvibes-sdk/platform/runtime/ui/provider-health/index';

// Retention
export {
  RetentionPolicy,
  SnapshotPruner,
  DEFAULT_RETENTION_CONFIG,
} from '@pellux/goodvibes-sdk/platform/runtime/retention/index';
export type {
  RetentionClass,
  RetentionClassConfig,
  RetentionConfig,
  CheckpointRecord,
  PruneOptions,
  PruneResult,
  PerClassPruneResult,
  Pruner,
  RetentionStats,
} from '@pellux/goodvibes-sdk/platform/runtime/retention/index';

// Bootstrap
export { bootstrapRuntime } from './bootstrap.ts';
export type { RuntimeContext, BootstrapOptions } from './context.ts';
export type { BootstrapContext } from './bootstrap.ts';
export { shutdownRuntime } from '@pellux/goodvibes-sdk/platform/runtime/lifecycle';
export { createUiRuntimeServices } from './ui-services.ts';
export type { UiRuntimeServices } from './ui-services.ts';
export {
  createDirectTransportServices,
  createOperatorClientServices,
  createPeerClientDependencies,
} from '@pellux/goodvibes-sdk/platform/runtime/foundation-services';
export type {
  DirectTransportServicesOptions,
  DirectTransportServices,
  OperatorClientServicesOptions,
  OperatorClientServices,
  OperatorClientReadModels,
} from '@pellux/goodvibes-sdk/platform/runtime/foundation-services';
export { createRuntimeFoundationClients } from '@pellux/goodvibes-sdk/platform/runtime/foundation-clients';
export type {
  RuntimeFoundationClients,
  RuntimeFoundationClientsOptions,
} from '@pellux/goodvibes-sdk/platform/runtime/foundation-clients';
export { createOperatorClient } from '@pellux/goodvibes-sdk/platform/runtime/operator-client';
export type { OperatorClient } from '@pellux/goodvibes-sdk/platform/runtime/operator-client';
export { createPeerClient } from '@pellux/goodvibes-sdk/platform/runtime/peer-client';
export type { PeerClient } from '@pellux/goodvibes-sdk/platform/runtime/peer-client';
export { createRuntimeProviderApi } from '@pellux/goodvibes-sdk/platform/runtime/runtime-provider-api';
export { createRuntimeKnowledgeApi } from '@pellux/goodvibes-sdk/platform/runtime/runtime-knowledge-api';
export { createRuntimeHookApi } from '@pellux/goodvibes-sdk/platform/runtime/runtime-hook-api';
export { createRuntimeMcpApi } from '@pellux/goodvibes-sdk/platform/runtime/runtime-mcp-api';
export { createRuntimeOpsApi } from '@pellux/goodvibes-sdk/platform/runtime/runtime-ops-api';
export type { OpsApi } from '@pellux/goodvibes-sdk/platform/runtime/ops-api';
export { createDirectTransport, createDirectTransportFromServices } from '@pellux/goodvibes-sdk/platform/runtime/transports/direct';
export { createRuntimeDirectTransport } from '@pellux/goodvibes-sdk/platform/runtime/transports/direct';
export type { DirectTransport } from '@pellux/goodvibes-sdk/platform/runtime/transports/direct';
export { createDirectClientTransport } from '@pellux/goodvibes-sdk/platform/runtime/transports/direct-client';
export type { DirectClientTransport } from '@pellux/goodvibes-sdk/platform/runtime/transports/direct-client';
export { createClientTransport } from '@pellux/goodvibes-sdk/platform/runtime/transports/client-transport';
export type { ClientTransport } from '@pellux/goodvibes-sdk/platform/runtime/transports/client-transport';
export { buildUrl, createTransportPaths, normalizeBaseUrl } from '@pellux/goodvibes-sdk/platform/runtime/transports/transport-paths';
export type { TransportPaths } from '@pellux/goodvibes-sdk/platform/runtime/transports/transport-paths';
export {
  createFetch,
  createHttpJsonTransport,
  createJsonInit,
  createJsonRequestInit,
  readJsonBody,
  requestJson,
} from '@pellux/goodvibes-sdk/platform/runtime/transports/http-json-transport';
export type {
  HttpJsonRequestOptions,
  HttpJsonTransport,
  HttpJsonTransportOptions,
  JsonObject,
  JsonValue,
  ResolvedContractRequest,
  TransportJsonError,
} from '@pellux/goodvibes-sdk/platform/runtime/transports/http-json-transport';
export {
  buildContractInput,
  invokeContractRoute,
  openContractRouteStream,
  requireContractRoute,
} from '@pellux/goodvibes-sdk/platform/runtime/transports/contract-http-client';
export type {
  ContractInvokeOptions,
  ContractRouteDefinition,
  ContractRouteLike,
  ContractStreamOptions,
} from '@pellux/goodvibes-sdk/platform/runtime/transports/contract-http-client';
export { isAbortError, openServerSentEventStream } from '@pellux/goodvibes-sdk/platform/runtime/transports/sse-stream';
export type { ServerSentEventHandlers, ServerSentEventOptions } from '@pellux/goodvibes-sdk/platform/runtime/transports/sse-stream';
export { createOperatorRemoteClient } from '@pellux/goodvibes-sdk/platform/runtime/transports/operator-remote-client';
export type {
  OperatorRemoteClient,
  OperatorRemoteClientInvokeOptions,
  OperatorRemoteClientStreamOptions,
} from '@pellux/goodvibes-sdk/platform/runtime/transports/operator-remote-client';
export { createPeerRemoteClient } from '@pellux/goodvibes-sdk/platform/runtime/transports/peer-remote-client';
export type {
  PeerRemoteClient,
  PeerRemoteClientInvokeOptions,
} from '@pellux/goodvibes-sdk/platform/runtime/transports/peer-remote-client';
export {
  buildEventSourceUrl,
  buildWebSocketUrl,
  createEventSourceConnector,
  createRemoteDomainEvents,
  createRemoteRuntimeEvents,
  createRemoteUiRuntimeEvents,
  createWebSocketConnector,
} from '@pellux/goodvibes-sdk/platform/runtime/transports/remote-events';
export type {
  DomainEventConnector,
  RemoteDomainEvents,
  RemoteRuntimeEvents,
  SerializedRuntimeEnvelope,
} from '@pellux/goodvibes-sdk/platform/runtime/transports/remote-events';

// Network
export * from '@pellux/goodvibes-sdk/platform/runtime/network/index';
