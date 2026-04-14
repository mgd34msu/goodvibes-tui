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
export { RuntimeEventBus } from './events/index.ts';
export { createEventEnvelope } from './event-envelope.ts';
export type { EventEnvelope, EventEnvelopeContext } from './event-envelope.ts';
export type { RuntimeEventEnvelope, EnvelopeContext } from './events/envelope.ts';
export { RUNTIME_EVENT_DOMAINS, isRuntimeEventDomain } from './events/domain-map.ts';
export type { AnyRuntimeEvent, RuntimeEventDomain } from './events/domain-map.ts';
export { createRuntimeEventFeed, createRuntimeEventFeeds } from './event-feeds.ts';
export type { RuntimeEventFeed, RuntimeEventFeeds } from './event-feeds.ts';

// Emitters
export type { EmitterContext } from './emitters/index.ts';

// Health
export { RuntimeHealthAggregator } from './health/aggregator.ts';
export { CascadeEngine } from './health/cascade-engine.ts';
export { CASCADE_RULES } from './health/cascade-rules.ts';
export { createHealthSystem } from './health/index.ts';
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
} from './health/types.ts';

// Notifications
export { NotificationRouter, createNotificationRouter } from './notifications/index.ts';
export type { Notification, NotificationLevel, NotificationTarget, DomainVerbosity, RoutingDecision } from './notifications/types.ts';

// UI surfaces
export { createModelPickerData, ModelPickerDataProvider } from './ui/model-picker/index.ts';
export type { ModelPickerDataProviderOptions } from './ui/model-picker/index.ts';
export { createProviderHealthData, ProviderHealthDataProvider } from './ui/provider-health/index.ts';

// Retention
export {
  RetentionPolicy,
  SnapshotPruner,
  DEFAULT_RETENTION_CONFIG,
} from './retention/index.ts';
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
} from './retention/index.ts';

// Bootstrap
export { bootstrapRuntime } from './bootstrap.ts';
export type { RuntimeContext, BootstrapOptions } from './context.ts';
export type { BootstrapContext } from './bootstrap.ts';
export { shutdownRuntime } from './lifecycle.ts';
export { createUiRuntimeServices } from './ui-services.ts';
export type { UiRuntimeServices } from './ui-services.ts';
export {
  createDirectTransportServices,
  createOperatorClientServices,
  createPeerClientDependencies,
} from './foundation-services.ts';
export type {
  DirectTransportServicesOptions,
  DirectTransportServices,
  OperatorClientServicesOptions,
  OperatorClientServices,
  OperatorClientReadModels,
} from './foundation-services.ts';
export { createRuntimeFoundationClients } from './foundation-clients.ts';
export type {
  RuntimeFoundationClients,
  RuntimeFoundationClientsOptions,
} from './foundation-clients.ts';
export { createOperatorClient } from './operator-client.ts';
export type { OperatorClient } from './operator-client.ts';
export { createPeerClient } from './peer-client.ts';
export type { PeerClient } from './peer-client.ts';
export { createRuntimeProviderApi } from './runtime-provider-api.ts';
export { createRuntimeKnowledgeApi } from './runtime-knowledge-api.ts';
export { createRuntimeHookApi } from './runtime-hook-api.ts';
export { createRuntimeMcpApi } from './runtime-mcp-api.ts';
export { createRuntimeOpsApi } from './runtime-ops-api.ts';
export type { OpsApi } from './ops-api.ts';
export { createDirectTransport, createDirectTransportFromServices } from './transports/direct.ts';
export { createRuntimeDirectTransport } from './transports/direct.ts';
export type { DirectTransport } from './transports/direct.ts';
export { createDirectClientTransport } from './transports/direct-client.ts';
export type { DirectClientTransport } from './transports/direct-client.ts';
export { createClientTransport } from './transports/client-transport.ts';
export type { ClientTransport } from './transports/client-transport.ts';
export { buildUrl, createTransportPaths, normalizeBaseUrl } from './transports/transport-paths.ts';
export type { TransportPaths } from './transports/transport-paths.ts';
export {
  createFetch,
  createHttpJsonTransport,
  createJsonInit,
  createJsonRequestInit,
  readJsonBody,
  requestJson,
} from './transports/http-json-transport.ts';
export type {
  HttpJsonRequestOptions,
  HttpJsonTransport,
  HttpJsonTransportOptions,
  JsonObject,
  JsonValue,
  ResolvedContractRequest,
  TransportJsonError,
} from './transports/http-json-transport.ts';
export {
  buildContractInput,
  invokeContractRoute,
  openContractRouteStream,
  requireContractRoute,
} from './transports/contract-http-client.ts';
export type {
  ContractInvokeOptions,
  ContractRouteDefinition,
  ContractRouteLike,
  ContractStreamOptions,
} from './transports/contract-http-client.ts';
export { isAbortError, openServerSentEventStream } from './transports/sse-stream.ts';
export type { ServerSentEventHandlers, ServerSentEventOptions } from './transports/sse-stream.ts';
export { createOperatorRemoteClient } from './transports/operator-remote-client.ts';
export type {
  OperatorRemoteClient,
  OperatorRemoteClientInvokeOptions,
  OperatorRemoteClientStreamOptions,
} from './transports/operator-remote-client.ts';
export { createPeerRemoteClient } from './transports/peer-remote-client.ts';
export type {
  PeerRemoteClient,
  PeerRemoteClientInvokeOptions,
} from './transports/peer-remote-client.ts';
export {
  buildEventSourceUrl,
  buildWebSocketUrl,
  createEventSourceConnector,
  createRemoteDomainEvents,
  createRemoteRuntimeEvents,
  createRemoteUiRuntimeEvents,
  createWebSocketConnector,
} from './transports/remote-events.ts';
export type {
  DomainEventConnector,
  RemoteDomainEvents,
  RemoteRuntimeEvents,
  SerializedRuntimeEnvelope,
} from './transports/remote-events.ts';

// Network
export * from './network/index.ts';
