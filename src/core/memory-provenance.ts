// ---------------------------------------------------------------------------
// memory-provenance.ts — the optional "used N memories" turn chip (owner-ruled
// 2026-07-13, default OFF).
//
// The SDK already records, per turn, which standing-memory records were
// injected into the prompt (Orchestrator.getTurnInjections() → TurnInjectionRecord
// with parallel injectedIds / injectedSources arrays). When the memory-provenance
// setting is ON, a turn that drew on memories shows a small chip naming how many,
// with a drill-in listing them. When OFF (default), NOTHING is rendered and no
// context is added — the caller never even asks for the records.
// ---------------------------------------------------------------------------

import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { TurnInjectionEntry } from '../renderer/turn-injection.ts';

/** TUI-local setting key: show the per-turn memory-provenance chip. Default OFF. */
export const MEMORY_SHOW_PROVENANCE_CONFIG_KEY = 'memory.showProvenance';
export const MEMORY_SHOW_PROVENANCE_DEFAULT = false;
export const MEMORY_SHOW_PROVENANCE_DESCRIPTION =
  'Show a "used N memories" chip on turns that drew on your standing memories, with a drill-in ' +
  'listing them (Alt+M to expand). Off by default; when off, nothing is rendered and no context is added.';

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

/** The memory-sourced injected ids for one turn. */
export interface MemoryUse {
  readonly count: number;
  readonly ids: readonly string[];
}

/**
 * The memory-sourced injected ids for one turn. `injectedSources` is parallel
 * to `injectedIds`; a missing/short entry defaults to 'memory' (matching
 * turn-injection.ts), so a memory-only record — the common case — counts every
 * id. Code-index hits are excluded: this chip is about memories specifically.
 */
export function memoryUseFromEntry(entry: TurnInjectionEntry): MemoryUse {
  const sources = entry.injectedSources ?? [];
  const ids = entry.injectedIds.filter((_, i) => (sources[i] ?? 'memory') === 'memory');
  return { count: ids.length, ids };
}

/** The most-recent turn that used at least one memory, or null when none did. */
export function latestMemoryUse(
  entries: readonly TurnInjectionEntry[],
): { readonly entry: TurnInjectionEntry; readonly use: MemoryUse } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const use = memoryUseFromEntry(entries[i]!);
    if (use.count > 0) return { entry: entries[i]!, use };
  }
  return null;
}
