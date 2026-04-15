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
export { FileWatcher } from '@pellux/goodvibes-sdk/platform/state/file-watcher';
export { SQLiteStore } from '@pellux/goodvibes-sdk/platform/state/sqlite-store';
export { TelemetryDB } from '@pellux/goodvibes-sdk/platform/state/telemetry';
export type { ToolCallRecord, TelemetryFilter, TelemetrySummary } from '@pellux/goodvibes-sdk/platform/state/telemetry';
export { FileUndoManager } from '@pellux/goodvibes-sdk/platform/state/file-undo';
export type { FileOperation } from '@pellux/goodvibes-sdk/platform/state/file-undo';
export { MemoryStore } from '@pellux/goodvibes-sdk/platform/state/memory-store';
export { MemoryRegistry } from '@pellux/goodvibes-sdk/platform/state/memory-registry';
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
} from '@pellux/goodvibes-sdk/platform/state/memory-store';
export {
  MEMORY_VECTOR_DIMS,
  embedMemoryText,
  resolveMemoryVectorDbPath,
  SqliteVecMemoryIndex,
} from '@pellux/goodvibes-sdk/platform/state/memory-vector-store';
export type { MemoryVectorCandidate, MemoryVectorStats } from '@pellux/goodvibes-sdk/platform/state/memory-vector-store';
export {
  DEFAULT_MEMORY_EMBEDDING_DIMS,
  HASHED_MEMORY_EMBEDDING_PROVIDER,
  MemoryEmbeddingProviderRegistry,
  normalizeMemoryEmbeddingVector,
} from '@pellux/goodvibes-sdk/platform/state/memory-embeddings';
export type {
  MemoryEmbeddingDoctorReport,
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderState,
  MemoryEmbeddingProviderStatus,
  MemoryEmbeddingRequest,
  MemoryEmbeddingResult,
  MemoryEmbeddingUsage,
} from '@pellux/goodvibes-sdk/platform/state/memory-embeddings';
export type { KnowledgeInjection } from '@pellux/goodvibes-sdk/platform/state/knowledge-injection';
export { selectKnowledgeForTask, buildKnowledgeInjectionPrompt } from '@pellux/goodvibes-sdk/platform/state/knowledge-injection';
