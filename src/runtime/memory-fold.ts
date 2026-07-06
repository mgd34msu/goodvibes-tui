import { join } from 'node:path';
import {
  foldMemoryStores,
  type LegacyMemorySource,
  type MemoryEmbeddingProviderRegistry,
  type MemoryFoldReport,
  type MemoryStore,
} from '@pellux/goodvibes-sdk/platform/state';

/**
 * W6-C2 (E6): fold the TUI's legacy per-project memory store into the canonical
 * cross-surface store. Called once at boot AFTER `memoryStore.init()` so records written
 * before unification survive. Id-keyed and idempotent — a re-run imports nothing new and
 * never deletes the legacy file. Returns the report so boot can log what moved.
 */
export async function foldTuiLegacyMemory(
  memoryStore: MemoryStore,
  memoryEmbeddingRegistry: MemoryEmbeddingProviderRegistry,
  workingDirectory: string,
): Promise<MemoryFoldReport> {
  const legacyTuiProject = join(workingDirectory, '.goodvibes', 'tui', 'memory.sqlite');
  const sources: LegacyMemorySource[] = [
    { label: `tui:${workingDirectory} (pre-E6)`, dbPath: legacyTuiProject },
  ];
  return foldMemoryStores(memoryStore, sources, { embeddingRegistry: memoryEmbeddingRegistry });
}
