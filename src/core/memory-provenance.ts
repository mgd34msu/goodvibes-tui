// ---------------------------------------------------------------------------
// memory-provenance.ts — the optional "used N memories" turn chip (owner-ruled
// 2026-07-13, default OFF).
//
// The SDK tags each turn payload with the memory-sourced injection ids it drew
// on: `metadata.memory.recordIds: string[]` (absent when none) — the SAME
// convention the webui's chip reads, so both surfaces name the same records.
// When the memory-provenance setting is ON, a turn that used memories shows a
// small chip naming how many, with a drill-in listing them. When OFF (default),
// NOTHING is rendered and the metadata is never even read.
// ---------------------------------------------------------------------------

import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';

/** TUI-local setting key: show the per-turn memory-provenance chip. Default OFF. */
export const MEMORY_SHOW_PROVENANCE_CONFIG_KEY = 'memory.showProvenance';
export const MEMORY_SHOW_PROVENANCE_DEFAULT = false;
export const MEMORY_SHOW_PROVENANCE_DESCRIPTION =
  'Show a "used N memories" chip on turns that drew on your standing memories, with a drill-in ' +
  'listing them (Alt+M to expand). Off by default; when off, nothing is rendered and no metadata is read.';

/**
 * Read the memory-provenance toggle defensively. `memory.*` is a TUI-local
 * section with no SDK DEFAULT_CONFIG entry, so ConfigManager.get() throws for
 * it until something has been written — an unset key means the default (OFF),
 * not an error (same pattern as memory.projection.dir).
 */
export function readMemoryShowProvenance(configManager: Pick<ConfigManager, 'get'>): boolean {
  try {
    return configManager.get(MEMORY_SHOW_PROVENANCE_CONFIG_KEY as Parameters<ConfigManager['get']>[0]) === true;
  } catch {
    return MEMORY_SHOW_PROVENANCE_DEFAULT;
  }
}

/**
 * Extract the memory-sourced record ids a turn drew on, from the SDK's
 * `metadata.memory.recordIds` convention. Structural (not a named import) so it
 * reads the field whether or not the pinned SDK's TurnEvent type surfaces it
 * yet, and yields an empty list for any turn without the field — never a guess,
 * never a throw.
 */
export function memoryRecordIdsFromTurn(turn: unknown): readonly string[] {
  const metadata = (turn as { metadata?: unknown } | null | undefined)?.metadata;
  const memory = (metadata as { memory?: unknown } | null | undefined)?.memory;
  const recordIds = (memory as { recordIds?: unknown } | null | undefined)?.recordIds;
  if (!Array.isArray(recordIds)) return [];
  return recordIds.filter((id): id is string => typeof id === 'string');
}
