/**
 * memory-panel.test.ts
 *
 * TASK-040: Tests for the merged MemoryPanel (filter toggle: all / review queue).
 * Verifies:
 *   - both record kinds render in 'all' mode
 *   - Tab toggles to 'review' mode and shows review columns
 *   - review actions (r/s/c/f + confirm) work in review mode
 *   - no dead panel id (class name and constructor unchanged)
 *   - label honesty: 'Memory' title, no knowledge-graph content in this panel
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { MemoryRegistry, MemoryStore } from '@pellux/goodvibes-sdk/platform/state';
import type { MemoryRecord } from '@pellux/goodvibes-sdk/platform/state';
import { MemoryEmbeddingProviderRegistry } from '@pellux/goodvibes-sdk/platform/state';
import { MemoryPanel } from '../../panels/memory-panel.ts';
import type { Line } from '../../types/grid.ts';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

describe('MemoryPanel (merged)', () => {
  let dir: string;
  let store: MemoryStore;
  let registry: MemoryRegistry;
  let configManager: ConfigManager;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gv-memory-panel-'));
    configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(dir, '.goodvibes', 'tui'),
      workingDir: dir,
    });
    store = new MemoryStore(join(dir, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
    });
    await store.init();
    registry = new MemoryRegistry(store);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Basic contract
  // ---------------------------------------------------------------------------

  test('panel id is \'memory\' and name is \'Memory\'', () => {
    const panel = new MemoryPanel(registry);
    expect((panel as unknown as { id: string }).id).toBe('memory');
    expect((panel as unknown as { name: string }).name).toBe('Memory');
  });

  test('renders empty guidance in all mode', () => {
    const panel = new MemoryPanel(registry);
    const text = linesText(panel.render(120, 12));
    expect(text).toContain('Memory');
    expect(text).toContain('All Records');
  });

  // ---------------------------------------------------------------------------
  // Both record kinds render in all mode
  // ---------------------------------------------------------------------------

  test('renders all record kinds in all mode', async () => {
    await registry.add({ cls: 'decision', summary: 'Use Bun as the runtime.' });
    await registry.add({ cls: 'risk', summary: 'API surface may change before 1.0.', review: { state: 'fresh', confidence: 60 } });
    await registry.add({ cls: 'runbook', summary: 'Restart daemon after upgrade.' });
    await registry.add({ cls: 'fact', summary: 'sqlite-vec is bundled at build time.' });

    const panel = new MemoryPanel(registry);
    panel.onActivate();
    const text = linesText(panel.render(140, 24));

    // Summary counts visible
    expect(text).toContain('records');
    expect(text).toContain('facts');
    expect(text).toContain('decisions');
    // All mode filter label
    expect(text).toContain('All Records');
    // Tab hint present
    expect(text).toContain('Tab');

    panel.onDeactivate();
    panel.onDestroy();
  });

  // ---------------------------------------------------------------------------
  // Filter toggle (Tab key) switches to review mode
  // ---------------------------------------------------------------------------

  test('Tab key toggles from all to review mode', async () => {
    await registry.add({ cls: 'fact', summary: 'Fact in review queue.', review: { state: 'stale', confidence: 30 } });

    const panel = new MemoryPanel(registry);
    panel.onActivate();

    // Initial mode: all
    const allText = linesText(panel.render(120, 24));
    expect(allText).toContain('All Records');

    // Toggle to review mode
    expect(panel.handleInput('tab')).toBe(true);
    const reviewText = linesText(panel.render(120, 24));
    expect(reviewText).toContain('Review Queue');
    // Review mode shows reviewState column hint
    expect(reviewText).toContain('stale');
    expect(reviewText).toContain('Tab: All Records');

    // Toggle back to all mode
    expect(panel.handleInput('tab')).toBe(true);
    const backText = linesText(panel.render(120, 24));
    expect(backText).toContain('All Records');

    panel.onDeactivate();
    panel.onDestroy();
  });

  // ---------------------------------------------------------------------------
  // Review actions in review mode
  // ---------------------------------------------------------------------------

  test('review mode: r marks selected record as reviewed', async () => {
    const record = await registry.add({ cls: 'fact', summary: 'Item awaiting review.', review: { state: 'fresh', confidence: 55 } });
    const panel = new MemoryPanel(registry);
    panel.onActivate();

    // Switch to review mode
    panel.handleInput('tab');

    // Press r to mark reviewed
    expect(panel.handleInput('r')).toBe(true);
    const updated = registry.get(record.id);
    expect(updated?.reviewState).toBe('reviewed');
    expect(updated?.confidence).toBeGreaterThanOrEqual(85);

    panel.onDeactivate();
    panel.onDestroy();
  });

  test('review mode: s + y confirm marks selected record stale', async () => {
    const record = await registry.add({ cls: 'risk', summary: 'Risk to be marked stale.', review: { state: 'fresh', confidence: 70 } });
    const panel = new MemoryPanel(registry);
    panel.onActivate();

    // Switch to review mode
    panel.handleInput('tab');

    // s opens confirm dialog
    expect(panel.handleInput('s')).toBe(true);
    // state still 'fresh' — confirm pending
    expect(registry.get(record.id)?.reviewState).toBe('fresh');

    // y confirms the stale transition
    expect(panel.handleInput('y')).toBe(true);
    expect(registry.get(record.id)?.reviewState).toBe('stale');

    panel.onDeactivate();
    panel.onDestroy();
  });

  test('review mode: f marks selected record fresh', async () => {
    const record = await registry.add({ cls: 'architecture', summary: 'Architecture note.', review: { state: 'stale', confidence: 20 } });
    const panel = new MemoryPanel(registry);
    panel.onActivate();
    panel.handleInput('tab');

    expect(panel.handleInput('f')).toBe(true);
    expect(registry.get(record.id)?.reviewState).toBe('fresh');

    panel.onDeactivate();
    panel.onDestroy();
  });

  // ---------------------------------------------------------------------------
  // Review mode: getItems() identity and navigation invariant
  // ---------------------------------------------------------------------------

  test('review mode: getItems() returns reviewRecords, not full set', async () => {
    // Add 3 records with mixed states so reviewQueue orders differently from search()
    await registry.add({ cls: 'fact',     summary: 'Alpha record.', review: { state: 'stale', confidence: 20 } });
    await registry.add({ cls: 'risk',     summary: 'Beta record.',  review: { state: 'fresh', confidence: 30 } });
    await registry.add({ cls: 'decision', summary: 'Gamma record.', review: { state: 'fresh', confidence: 40 } });

    const panel = new MemoryPanel(registry);
    panel.onActivate();
    panel.handleInput('tab'); // enter review mode

    const reviewRecords = (panel as unknown as { reviewRecords: MemoryRecord[] }).reviewRecords;
    const items = (panel as unknown as { getItems(): readonly MemoryRecord[] }).getItems();

    // getItems() in review mode must be identical to reviewRecords
    expect(items.length).toBe(reviewRecords.length);
    expect(items.length).toBe(3);

    // Every item returned by getItems() must exist in reviewRecords (by id)
    const reviewIds = new Set(reviewRecords.map((r) => r.id));
    for (const item of items) {
      expect(reviewIds.has(item.id)).toBe(true);
    }

    // Switching back to all mode: getItems() returns from getAllItems() (full set)
    panel.handleInput('tab');
    const allModeItems = (panel as unknown as { getItems(): readonly MemoryRecord[] }).getItems();
    expect(allModeItems.length).toBe(3);

    panel.onDeactivate();
    panel.onDestroy();
  });

  test('review mode: action key mutates the correct reviewRecords entry, not fullSet entry at same index', async () => {
    // Add 3 records with mixed states. The reviewQueue ordering is implementation-defined
    // (typically stale-first, then by confidence). The full set (registry.search) uses
    // insertion order. We do not assert a specific queue order — instead, we read the
    // actual queue at runtime and verify that the action mutates reviewRecords[selectedIndex],
    // and that exactly one record was mutated (proving the fix).
    const alpha = await registry.add({ cls: 'fact',     summary: 'Record alpha.', review: { state: 'fresh', confidence: 50 } });
    const beta  = await registry.add({ cls: 'risk',     summary: 'Record beta.',  review: { state: 'stale', confidence: 30 } });
    const gamma = await registry.add({ cls: 'decision', summary: 'Record gamma.', review: { state: 'fresh', confidence: 45 } });

    const panel = new MemoryPanel(registry);
    panel.onActivate();
    panel.handleInput('tab'); // enter review mode

    // Navigate down once with 'j' — in review mode this must navigate, not append to search query
    expect(panel.handleInput('j')).toBe(true);

    // 'j' must be treated as navigation, not filter input
    const filterQuery = (panel as unknown as { filterQuery: string }).filterQuery;
    expect(filterQuery).toBe('');

    // selectedIndex must be 1
    const selectedIndex = (panel as unknown as { selectedIndex: number }).selectedIndex;
    expect(selectedIndex).toBe(1);

    // Read the actual reviewRecords queue at runtime — do not assume ordering
    const reviewRecords = (panel as unknown as { reviewRecords: MemoryRecord[] }).reviewRecords;
    expect(reviewRecords.length).toBe(3);
    const targetRecord = reviewRecords[1]!;

    // Press 'r' to mark the selected record (reviewRecords[1]) as reviewed
    expect(panel.handleInput('r')).toBe(true);

    // targetRecord must now be marked reviewed with confidence ≥ 85
    const updatedTarget = registry.get(targetRecord.id);
    expect(updatedTarget?.reviewState).toBe('reviewed');
    expect(updatedTarget?.confidence).toBeGreaterThanOrEqual(85);

    // Exactly one record must have been reviewed — the one at reviewRecords[1]
    // This is the core invariant: navigation index maps to reviewRecords, not fullSet
    let reviewedCount = 0;
    for (const rec of [alpha, beta, gamma]) {
      const current = registry.get(rec.id);
      if (current?.reviewState === 'reviewed') {
        reviewedCount++;
        expect(current.id).toBe(targetRecord.id);
      }
    }
    expect(reviewedCount).toBe(1);

    panel.onDeactivate();
    panel.onDestroy();
  });

  // ---------------------------------------------------------------------------
  // No panel id confusion — MemoryPanel does not render knowledge-graph content
  // ---------------------------------------------------------------------------

  test('no KnowledgeGraphPanel confusion: MemoryPanel does not mention graph', async () => {
    const panel = new MemoryPanel(registry);
    panel.onActivate();
    const text = linesText(panel.render(120, 24));
    // Memory panel should NOT label itself as 'Knowledge Graph'
    expect(text).not.toContain('Knowledge Graph');
    panel.onDeactivate();
    panel.onDestroy();
  });
});
