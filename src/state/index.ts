export { JsonFileStore } from './json-file-store.ts';
export { KVState } from './kv-state.ts';
export { FileStateCache } from './file-cache.ts';
export type { CacheEntry, CacheStatus, ConflictInfo } from './file-cache.ts';
export { ProjectIndex } from './project-index.ts';
export type { FileEntry } from './project-index.ts';
export { ModeManager } from './mode-manager.ts';
export type { ModeDefinition } from './mode-manager.ts';
export type { HITLMode, HITLModeDefinition } from './mode-manager.ts';
export { HITL_QUIET, HITL_BALANCED, HITL_OPERATOR } from './mode-manager.ts';
export { FileWatcher } from './file-watcher.ts';
export { SQLiteStore } from './sqlite-store.ts';
export { TelemetryDB } from './telemetry.ts';
export type { ToolCallRecord, TelemetryFilter, TelemetrySummary } from './telemetry.ts';
export { FileUndoManager } from './file-undo.ts';
export type { FileOperation } from './file-undo.ts';
export { MemoryStore, MemoryRegistry, getMemoryStore, getMemoryRegistry } from './memory-store.ts';
export { _resetMemoryRegistryForTesting } from './memory-store.ts';
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
export { selectKnowledgeForTask, buildKnowledgeInjectionPrompt, _setKnowledgeRegistryForTesting } from './knowledge-injection.ts';
