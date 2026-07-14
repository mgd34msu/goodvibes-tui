import { describe, expect, test } from 'bun:test';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { linesToText } from '../setup.ts';
import {
  memoryRecordIdsFromTurn,
  readMemoryShowProvenance,
  MEMORY_SHOW_PROVENANCE_DEFAULT,
} from '../../core/memory-provenance.ts';
import type { Line } from '../../types/grid.ts';
import { buildSettingGroups } from '../../input/settings-modal-data.ts';
import { createTestManagers } from '../helpers/test-managers.ts';

// ---------------------------------------------------------------------------
// STEP 4 — the optional "used N memories" turn chip (default OFF), built against
// the SDK's metadata.memory.recordIds convention (the same field the webui
// chip reads). When on, a turn that used memories shows the chip with a
// drill-in listing them; when off, zero rendering and the metadata is not read.
// ---------------------------------------------------------------------------

/** A fixture turn payload carrying metadata.memory.recordIds (the SDK convention). */
function turnWithMemories(recordIds: string[]): unknown {
  return { type: 'TURN_COMPLETED', turnId: 't1', response: 'ok', stopReason: 'completed', metadata: { memory: { recordIds } } };
}

/** The render gate exactly as main.ts applies it: on AND at least one record id. */
function chipLinesFor(turn: unknown, showProvenance: boolean, expanded = false): Line[] {
  const ids = memoryRecordIdsFromTurn(turn);
  if (!showProvenance || ids.length === 0) return [];
  return UIFactory.createMemoryProvenanceChip(80, ids.length, ids, expanded);
}

describe('memoryRecordIdsFromTurn — the metadata.memory.recordIds convention (STEP 4)', () => {
  test('the setting defaults OFF', () => {
    expect(MEMORY_SHOW_PROVENANCE_DEFAULT).toBe(false);
  });

  test('reads the memory record ids from a turn payload carrying the field', () => {
    expect(memoryRecordIdsFromTurn(turnWithMemories(['mem-a', 'mem-b']))).toEqual(['mem-a', 'mem-b']);
  });

  test('a turn without the field (absent when none) yields an empty list — never a guess, never a throw', () => {
    expect(memoryRecordIdsFromTurn({ type: 'TURN_COMPLETED', turnId: 't', response: 'ok', stopReason: 'completed' })).toEqual([]);
    expect(memoryRecordIdsFromTurn({ metadata: {} })).toEqual([]);
    expect(memoryRecordIdsFromTurn(null)).toEqual([]);
    expect(memoryRecordIdsFromTurn(undefined)).toEqual([]);
  });

  test('non-string entries are filtered out', () => {
    expect(memoryRecordIdsFromTurn({ metadata: { memory: { recordIds: ['ok', 3, null, 'fine'] } } })).toEqual(['ok', 'fine']);
  });
});

describe('the render gate — off renders nothing (STEP 4)', () => {
  test('OFF (the default): a turn that used memories renders zero chip lines', () => {
    expect(chipLinesFor(turnWithMemories(['mem-a', 'mem-b', 'mem-c']), false)).toEqual([]);
  });

  test('ON: a turn that used memories renders the chip naming the count', () => {
    const text = linesToText(chipLinesFor(turnWithMemories(['mem-a', 'mem-b', 'mem-c']), true)).join('\n');
    expect(text).toContain('used 3 memories');
    expect(text).toContain('Alt+M to list');
  });

  test('ON but a turn used no memories: still nothing', () => {
    expect(chipLinesFor({ type: 'TURN_COMPLETED' }, true)).toEqual([]);
  });
});

describe('createMemoryProvenanceChip render (STEP 4)', () => {
  test('collapsed chip names the count at 80 columns, ids behind the drill-in', () => {
    const text = linesToText(UIFactory.createMemoryProvenanceChip(80, 3, ['m1', 'm2', 'm3'], false)).join('\n');
    expect(text).toContain('used 3 memories');
    expect(text).not.toContain('m1');
  });

  test('expanded chip lists each memory at 80 columns', () => {
    const text = linesToText(UIFactory.createMemoryProvenanceChip(80, 2, ['mem-alpha', 'mem-beta'], true)).join('\n');
    expect(text).toContain('Alt+M to hide');
    expect(text).toContain('mem-alpha');
    expect(text).toContain('mem-beta');
  });

  test('collapsed and expanded both render at 60 columns', () => {
    expect(linesToText(UIFactory.createMemoryProvenanceChip(60, 1, ['mem-x'], false)).join('\n')).toContain('used 1 memory');
    const expanded = linesToText(UIFactory.createMemoryProvenanceChip(60, 1, ['mem-x'], true)).join('\n');
    expect(expanded).toContain('mem-x');
  });

  test('zero memories → zero lines', () => {
    expect(UIFactory.createMemoryProvenanceChip(80, 0, [], false)).toEqual([]);
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
    expect(readMemoryShowProvenance(configManager)).toBe(false);
  });
});
