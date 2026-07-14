import { describe, expect, test } from 'bun:test';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { linesToText } from '../setup.ts';
import { memoryUseFromEntry, latestMemoryUse, MEMORY_SHOW_PROVENANCE_DEFAULT } from '../../core/memory-provenance.ts';
import type { TurnInjectionEntry } from '../../renderer/turn-injection.ts';
import { buildSettingGroups } from '../../input/settings-modal-data.ts';
import { createTestManagers } from '../helpers/test-managers.ts';

// ---------------------------------------------------------------------------
// STEP 4 — the optional "used N memories" turn chip (default OFF). When on, a
// turn that used memories shows the chip with a drill-in listing them; when
// off, zero rendering and zero added context.
// ---------------------------------------------------------------------------

function entry(injectedIds: string[], injectedSources: ('memory' | 'code-index')[], turn = 1): TurnInjectionEntry {
  return {
    turn,
    query: 'q',
    candidatesConsidered: injectedIds.length,
    codeCandidatesConsidered: 0,
    injectedIds,
    injectedSources,
    droppedForBudget: [],
    tokenCost: 10,
    budgetTokens: 800,
    relevanceFloor: 95,
    ingestModes: injectedIds.map(() => 'semantic'),
    embeddingBackend: 'available',
  } as unknown as TurnInjectionEntry;
}

describe('memory-provenance data (STEP 4)', () => {
  test('the setting defaults OFF', () => {
    expect(MEMORY_SHOW_PROVENANCE_DEFAULT).toBe(false);
  });

  test('counts only memory-sourced ids, excluding code-index hits', () => {
    const use = memoryUseFromEntry(entry(['m1', 'c1', 'm2'], ['memory', 'code-index', 'memory']));
    expect(use.count).toBe(2);
    expect(use.ids).toEqual(['m1', 'm2']);
  });

  test('a missing/short source array defaults to memory (memory-only turn)', () => {
    const use = memoryUseFromEntry(entry(['m1', 'm2'], []));
    expect(use.count).toBe(2);
  });

  test('latestMemoryUse finds the most recent turn that used a memory', () => {
    const entries = [entry(['m1'], ['memory'], 1), entry(['c1'], ['code-index'], 2), entry(['m2', 'm3'], ['memory', 'memory'], 3)];
    const latest = latestMemoryUse(entries);
    expect(latest?.entry.turn).toBe(3);
    expect(latest?.use.count).toBe(2);
  });

  test('no memory used anywhere → null (chip never shows)', () => {
    expect(latestMemoryUse([entry(['c1'], ['code-index'])])).toBeNull();
  });
});

describe('createMemoryProvenanceChip render (STEP 4)', () => {
  test('collapsed chip names the count at 80 columns', () => {
    const text = linesToText(UIFactory.createMemoryProvenanceChip(80, 3, ['m1', 'm2', 'm3'], false)).join('\n');
    expect(text).toContain('used 3 memories');
    expect(text).toContain('Alt+M to list');
    expect(text).not.toContain('m1'); // ids are behind the drill-in
  });

  test('expanded chip lists each memory at 80 columns', () => {
    const text = linesToText(UIFactory.createMemoryProvenanceChip(80, 2, ['mem-alpha', 'mem-beta'], true)).join('\n');
    expect(text).toContain('used 2 memories');
    expect(text).toContain('Alt+M to hide');
    expect(text).toContain('mem-alpha');
    expect(text).toContain('mem-beta');
  });

  test('collapsed and expanded both render at 60 columns', () => {
    expect(linesToText(UIFactory.createMemoryProvenanceChip(60, 1, ['mem-x'], false)).join('\n')).toContain('used 1 memory');
    const expanded = linesToText(UIFactory.createMemoryProvenanceChip(60, 1, ['mem-x'], true)).join('\n');
    expect(expanded).toContain('used 1 memory');
    expect(expanded).toContain('mem-x');
  });

  test('zero memories → zero lines (off = nothing rendered)', () => {
    expect(UIFactory.createMemoryProvenanceChip(80, 0, [], false)).toEqual([]);
    expect(UIFactory.createMemoryProvenanceChip(80, 0, [], true)).toEqual([]);
  });
});

describe('memory settings domain (STEP 4)', () => {
  test('memory.showProvenance surfaces in the memory category, default OFF', () => {
    const { configManager } = createTestManagers();
    const groups = buildSettingGroups(configManager);
    const memory = groups.get('memory') ?? [];
    const entry = memory.find((e) => e.setting.key === 'memory.showProvenance');
    expect(entry).toBeDefined();
    expect(entry!.setting.type).toBe('boolean');
    expect(entry!.setting.default).toBe(false);
    expect(entry!.isDefault).toBe(true);
  });
});
