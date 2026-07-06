import { join } from 'node:path';
import {
  foldMemoryStores,
  formatMemoryFoldReport,
  type LegacyMemorySource,
  type MemoryEmbeddingProviderRegistry,
  type MemoryFoldReport,
  type MemoryStore,
} from '@pellux/goodvibes-sdk/platform/state';

/**
 * Fold the TUI's legacy per-project memory store into the canonical
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

/** A minimal boot logger seam (matches the SDK logger's info/warn shape). */
export interface BootFoldLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
}

/**
 * Run the legacy TUI memory fold at boot and surface the report. Never blocks or
 * fails boot: a fold error degrades to a warn and the canonical store serves on.
 * Only logs the report when something actually moved (or a source failed), so a
 * clean boot stays quiet.
 */
export async function runBootMemoryFold(
  memoryStore: MemoryStore,
  memoryEmbeddingRegistry: MemoryEmbeddingProviderRegistry,
  workingDirectory: string,
  log: BootFoldLogger,
): Promise<void> {
  try {
    const report = await foldTuiLegacyMemory(memoryStore, memoryEmbeddingRegistry, workingDirectory);
    if (report.totalImported > 0 || report.failedSources.length > 0) {
      log.info(`[bootstrap] memory fold: ${formatMemoryFoldReport(report)}`);
    }
  } catch (err) {
    log.warn('memory fold at bootstrap failed (non-fatal; canonical store unaffected)', { err });
  }
}
