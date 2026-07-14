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
  return UIFactory.createMemoryProvenanceChip(80, ids.length, ids.map((id) => ({ id })), expanded);
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
  test('collapsed chip names the count at 80 columns, records behind the drill-in', () => {
    const entries = [{ id: 'm1', record: { summary: 'prefers dark mode', cls: 'preference' } }];
    const text = linesToText(UIFactory.createMemoryProvenanceChip(80, 3, entries, false)).join('\n');
    expect(text).toContain('used 3 memories');
    expect(text).not.toContain('prefers dark mode');
  });

  test('expanded chip shows each RESOLVED record summary (not the raw id) at 80 columns', () => {
    const entries = [
      { id: 'mem-alpha', record: { summary: 'the API base url is prod', cls: 'fact' } },
      { id: 'mem-beta', record: { summary: 'user is on Arch Linux', cls: 'preference' } },
    ];
    const text = linesToText(UIFactory.createMemoryProvenanceChip(80, 2, entries, true)).join('\n');
    expect(text).toContain('Alt+M to hide');
    expect(text).toContain('the API base url is prod');
    expect(text).toContain('user is on Arch Linux');
    expect(text).toContain('fact');
    // The raw ids are never shown once resolved.
    expect(text).not.toContain('mem-alpha');
  });

  test('a still-resolving entry shows a placeholder; a forgotten one is honest', () => {
    const text = linesToText(UIFactory.createMemoryProvenanceChip(80, 2, [
      { id: 'loading-1', record: undefined },
      { id: 'gone-1', record: null },
    ], true)).join('\n');
    expect(text).toContain('resolving…');
    expect(text).toContain('no longer available');
  });

  test('zero memories → zero lines', () => {
    expect(UIFactory.createMemoryProvenanceChip(80, 0, [], false)).toEqual([]);
  });
});

describe('memory-provenance drill-in resolves ids to summaries (7a)', () => {
  test('expanding resolves each id through the memory spine, per-id, and renders summaries', async () => {
    const { createMemoryProvenanceUi } = await import('../../runtime/interaction-seams.ts');
    const records: Record<string, { summary: string; cls: string } | null> = {
      'mem-1': { summary: 'first fact', cls: 'fact' },
      'mem-2': null, // forgotten since the turn
    };
    const gets: string[] = [];
    const ui = createMemoryProvenanceUi({
      render: () => {},
      memorySpine: { get: async (id) => { gets.push(id); return records[id] ?? null; } },
    });
    ui.onTurnCompleted(turnWithMemories(['mem-1', 'mem-2']));
    const cfg = { get: (k: string) => (k === 'memory.showProvenance' ? true : undefined) } as never;

    ui.toggle(); // expand → triggers resolution
    await Promise.resolve(); await Promise.resolve();

    const text = linesToText(ui.renderChip(80, cfg)).join('\n');
    expect(gets.sort()).toEqual(['mem-1', 'mem-2']); // resolved per id
    expect(text).toContain('first fact');
    expect(text).toContain('no longer available'); // the forgotten one degrades honestly
  });

  test('a collapsed chip resolves nothing (lazy)', async () => {
    const { createMemoryProvenanceUi } = await import('../../runtime/interaction-seams.ts');
    const gets: string[] = [];
    const ui = createMemoryProvenanceUi({ render: () => {}, memorySpine: { get: async (id) => { gets.push(id); return null; } } });
    ui.onTurnCompleted(turnWithMemories(['mem-1']));
    const cfg = { get: (k: string) => (k === 'memory.showProvenance' ? true : undefined) } as never;
    ui.renderChip(80, cfg); // collapsed
    await Promise.resolve();
    expect(gets).toEqual([]);
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
