export { JsonFileStore } from '@pellux/goodvibes-sdk/platform/state/json-file-store';
export { KVState } from '@pellux/goodvibes-sdk/platform/state/kv-state';
export { FileStateCache } from '@pellux/goodvibes-sdk/platform/state/file-cache';
export type { CacheEntry, CacheStatus, ConflictInfo } from '@pellux/goodvibes-sdk/platform/state/file-cache';
export { ProjectIndex } from '@pellux/goodvibes-sdk/platform/state/project-index';
export type { FileEntry } from '@pellux/goodvibes-sdk/platform/state/project-index';
export { ModeManager } from '@pellux/goodvibes-sdk/platform/state/mode-manager';
export type { ModeDefinition } from '@pellux/goodvibes-sdk/platform/state/mode-manager';
export type { HITLMode, HITLModeDefinition } from '@pellux/goodvibes-sdk/platform/state/mode-manager';
export { HITL_QUIET, HITL_BALANCED, HITL_OPERATOR } from '@pellux/goodvibes-sdk/platform/state/mode-manager';
export { FileWatcher } from './file-watcher.ts';
export { SQLiteStore } from '@pellux/goodvibes-sdk/platform/state/sqlite-store';
export { TelemetryDB } from '@pellux/goodvibes-sdk/platform/state/telemetry';
export type { ToolCallRecord, TelemetryFilter, TelemetrySummary } from '@pellux/goodvibes-sdk/platform/state/telemetry';
export { FileUndoManager } from '@pellux/goodvibes-sdk/platform/state/file-undo';
export type { FileOperation } from '@pellux/goodvibes-sdk/platform/state/file-undo';
export { MemoryStore } from './memory-store.ts';
export { MemoryRegistry } from './memory-registry.ts';
export type {
  MemoryClass,
  MemoryRecord,
  MemoryLink,
  MemoryAddOptions,
  MemorySearchFilter,
  MemorySemanticSearchResult,
  MemoryStoreOptions,
  MemoryDoctorReport,
  MemoryScope,
  MemoryReviewState,
  ProvenanceLink,
  ProvenanceLinkKind,
} from './memory-store.ts';
export {
  MEMORY_VECTOR_DIMS,
  embedMemoryText,
  resolveMemoryVectorDbPath,
  SqliteVecMemoryIndex,
} from './memory-vector-store.ts';
export type { MemoryVectorCandidate, MemoryVectorStats } from './memory-vector-store.ts';
export {
  DEFAULT_MEMORY_EMBEDDING_DIMS,
  HASHED_MEMORY_EMBEDDING_PROVIDER,
  MemoryEmbeddingProviderRegistry,
  normalizeMemoryEmbeddingVector,
} from './memory-embeddings.ts';
export type {
  MemoryEmbeddingDoctorReport,
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderState,
  MemoryEmbeddingProviderStatus,
  MemoryEmbeddingRequest,
  MemoryEmbeddingResult,
  MemoryEmbeddingUsage,
} from './memory-embeddings.ts';
export type { KnowledgeInjection } from './knowledge-injection.ts';
export { selectKnowledgeForTask, buildKnowledgeInjectionPrompt } from './knowledge-injection.ts';
